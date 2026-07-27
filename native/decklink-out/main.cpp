// latticeout — standalone DeckLink SDI output helper for Lattice.
//
// Deliberately a separate process rather than a Node native module: it keeps
// Lattice's dependency tree native-free, so the release pipeline on the build
// machine needs no electron-rebuild and no per-Electron-version recompilation,
// and a driver-level crash cannot take the app down with it.
//
// Phase 2 scope: enumerate devices, and push internally generated test frames
// with correct scheduled-playback pacing. Frame transport from Electron over
// shared memory arrives in Phase 3; the pacing and colour paths are proven here
// first so there is only ever one unknown at a time.

#include <Accelerate/Accelerate.h>
#include <CoreFoundation/CoreFoundation.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include "DeckLinkAPI.h"

// ---------------------------------------------------------------- utilities

static std::string cf2s(CFStringRef s) {
    if (!s) return "";
    char b[512];
    if (!CFStringGetCString(s, b, sizeof(b), kCFStringEncodingUTF8)) return "";
    return std::string(b);
}

static std::string fourccStr(uint32_t v) {
    char b[5] = { char((v >> 24) & 0xff), char((v >> 16) & 0xff), char((v >> 8) & 0xff), char(v & 0xff), 0 };
    for (int i = 0; i < 4; i++) if (b[i] < 32 || b[i] > 126) b[i] = '.';
    return std::string(b);
}

static uint32_t strFourcc(const std::string& s) {
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) v = (v << 8) | (i < (int)s.size() ? (uint8_t)s[i] : ' ');
    return v;
}

// Friendly mode names so callers do not have to know BMD fourccs.
static BMDDisplayMode modeFromName(const std::string& s) {
    struct { const char* n; BMDDisplayMode m; } t[] = {
        { "1080p23.98", bmdModeHD1080p2398 }, { "1080p24", bmdModeHD1080p24 },
        { "1080p25",    bmdModeHD1080p25   }, { "1080p29.97", bmdModeHD1080p2997 },
        { "1080p30",    bmdModeHD1080p30   }, { "1080p50", bmdModeHD1080p50 },
        { "1080p59.94", bmdModeHD1080p5994 }, { "1080p60", bmdModeHD1080p6000 },
        { "1080i50",    bmdModeHD1080i50   }, { "1080i59.94", bmdModeHD1080i5994 },
        { "1080i60",    bmdModeHD1080i6000 }, { "720p50", bmdModeHD720p50 },
        { "720p59.94",  bmdModeHD720p5994  }, { "720p60", bmdModeHD720p60 },
        { "ntsc",       bmdModeNTSC        }, { "pal", bmdModePAL },
    };
    for (auto& e : t) if (s == e.n) return e.m;
    return (BMDDisplayMode)strFourcc(s);   // accept a raw fourcc too
}

struct Dev {
    IDeckLink* dl = NULL;
    std::string model, uiName;
    int64_t persistentID = 0, subIndex = 0;
    int card = 0;
    bool canOutput = false, hasSignalIn = false;
};

// Sub-devices of one card share a contiguous persistent-ID block; a drop in
// sub-index marks the start of the next card.
static std::vector<Dev> enumerate() {
    std::vector<Dev> devs;
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) return devs;
    IDeckLink* dl = NULL;
    while (it->Next(&dl) == S_OK) {
        Dev d; d.dl = dl;
        CFStringRef m = NULL; dl->GetModelName(&m); d.model = cf2s(m); if (m) CFRelease(m);
        IDeckLinkAttributes* a = NULL;
        if (dl->QueryInterface(IID_IDeckLinkAttributes, (void**)&a) == S_OK) {
            a->GetInt(BMDDeckLinkPersistentID, &d.persistentID);
            a->GetInt(BMDDeckLinkSubDeviceIndex, &d.subIndex);
            a->Release();
        }
        IDeckLinkOutput* o = NULL;
        if (dl->QueryInterface(IID_IDeckLinkOutput, (void**)&o) == S_OK && o) { d.canOutput = true; o->Release(); }
        devs.push_back(d);
    }
    it->Release();
    int card = 0;
    for (size_t i = 0; i < devs.size(); i++) {
        if (i > 0 && devs[i].subIndex <= devs[i - 1].subIndex) card++;
        devs[i].card = card;
        char b[160];
        // Per the Phase 0 finding that the stored CardInfoLabel is a cosmetic
        // user string: one card's sub-devices are literally named "Input 1-4".
        // Naming outputs from that would be actively misleading.
        snprintf(b, sizeof(b), "%s #%d — SDI %d", devs[i].model.c_str(), card + 1, (int)devs[i].subIndex + 1);
        devs[i].uiName = b;
    }
    return devs;
}

// Fill in Dev::hasSignalIn.
//
// bmdDeckLinkStatusVideoInputSignalLocked only reports meaningfully once video
// input is actually enabled and streaming — querying it cold returns false on
// every port, including ports that are demonstrably receiving. So enable input
// on every candidate at once, wait for the receivers to lock, then read.
// Whether a port is carrying someone else's signal decides whether we are
// allowed to flip it to transmit, so a false negative here is not acceptable.
static void probeInputSignals(std::vector<Dev>& devs, const std::vector<int>& which) {
    std::vector<IDeckLinkInput*> ins(devs.size(), NULL);
    for (int i : which) {
        if (i < 0 || i >= (int)devs.size()) continue;
        IDeckLinkInput* in = NULL;
        if (devs[i].dl->QueryInterface(IID_IDeckLinkInput, (void**)&in) != S_OK || !in) continue;
        if (in->EnableVideoInput(bmdModeHD1080i5994, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection) != S_OK) {
            in->Release(); continue;
        }
        in->StartStreams();
        ins[i] = in;
    }
    usleep(1600 * 1000);   // receivers need time to lock; 900ms was measured too short for 8 at once
    for (size_t i = 0; i < devs.size(); i++) {
        if (!ins[i]) continue;
        IDeckLinkStatus* st = NULL;
        if (devs[i].dl->QueryInterface(IID_IDeckLinkStatus, (void**)&st) == S_OK) {
            bool locked = false;
            st->GetFlag(bmdDeckLinkStatusVideoInputSignalLocked, &locked);
            devs[i].hasSignalIn = locked;
            st->Release();
        }
        ins[i]->StopStreams();
        ins[i]->DisableVideoInput();
        ins[i]->Release();
    }
}

// ------------------------------------------------------------ test patterns

struct TestPattern { virtual void render(uint8_t* bgra, int w, int h, int frame) = 0; virtual ~TestPattern() {} };

// Solid magenta: the brief's first-light frame. Unmistakable if geometry or
// pixel format is wrong.
struct Magenta : TestPattern {
    void render(uint8_t* p, int w, int h, int) override {
        for (long i = 0; i < (long)w * h; i++) { p[i*4+0] = 255; p[i*4+1] = 0; p[i*4+2] = 255; p[i*4+3] = 255; }
    }
};

// 1px white grid on black: the pixel-exactness check. Any scaling, softening or
// chroma subsampling of the lines is immediately visible.
struct Grid : TestPattern {
    void render(uint8_t* p, int w, int h, int) override {
        memset(p, 0, (size_t)w * h * 4);
        for (long i = 0; i < (long)w * h; i++) p[i*4+3] = 255;
        auto put = [&](int x, int y) {
            uint8_t* q = p + ((long)y * w + x) * 4;
            q[0] = q[1] = q[2] = 255;
        };
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x += 16) put(x, y);
        for (int y = 0; y < h; y += 16) for (int x = 0; x < w; x++) put(x, y);
    }
};

// 16 vertical steps, black to white. The colour-range check: all 16 must be
// distinguishable, and steps 0 and 15 must not clip.
struct GraySteps : TestPattern {
    void render(uint8_t* p, int w, int h, int) override {
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int step = (x * 16) / w;               // 0..15
                uint8_t v = (uint8_t)(step * 255 / 15);
                uint8_t* q = p + ((long)y * w + x) * 4;
                q[0] = q[1] = q[2] = v; q[3] = 255;
            }
        }
    }
};

// A moving bar, for judging pacing by eye and for giving the dropped-frame
// counters something non-static to work with.
struct Motion : TestPattern {
    void render(uint8_t* p, int w, int h, int frame) override {
        memset(p, 0, (size_t)w * h * 4);
        for (long i = 0; i < (long)w * h; i++) p[i*4+3] = 255;
        int bar = (frame * 8) % w;
        for (int y = 0; y < h; y++)
            for (int x = bar; x < bar + 64 && x < w; x++) {
                uint8_t* q = p + ((long)y * w + x) * 4;
                q[0] = q[1] = q[2] = 255;
            }
    }
};

// ------------------------------------------------------------- BGRA -> UYVY

// At 1080p50/59.94/60 the card refuses BGRA outright (Phase 0 finding), so the
// conversion is mandatory rather than an optimisation. vImage is used because
// Accelerate ships on every Mac — no new dependency for the release pipeline —
// and it is SIMD-optimised enough to stay well inside a 60fps budget.
class Converter {
public:
    bool init(bool legalRange) {
        vImage_ARGBToYpCbCrMatrix matrix = *kvImage_ARGBToYpCbCrMatrix_ITU_R_709_2;
        // Legal/video range (16-235) is the SDI convention; full range (0-255)
        // is what many LED processors actually expect. Which one is right is a
        // property of the downstream device, so it stays selectable.
        vImage_YpCbCrPixelRange range = legalRange
            ? vImage_YpCbCrPixelRange{ 16, 128, 235, 240, 235, 16, 240, 16 }
            : vImage_YpCbCrPixelRange{  0, 128, 255, 255, 255,  0, 255,  1 };
        return vImageConvert_ARGBToYpCbCr_GenerateConversion(
                   &matrix, &range, &info, kvImageARGB8888, kvImage422CbYpCrYp8,
                   kvImageNoFlags) == kvImageNoError;
    }
    bool convert(const uint8_t* bgra, uint8_t* uyvy, int w, int h) {
        vImage_Buffer src{ (void*)bgra, (vImagePixelCount)h, (vImagePixelCount)w, (size_t)w * 4 };
        vImage_Buffer dst{ (void*)uyvy, (vImagePixelCount)h, (vImagePixelCount)w, (size_t)w * 2 };
        // Source is BGRA; the converter wants ARGB channel order.
        const uint8_t permute[4] = { 3, 2, 1, 0 };
        return vImageConvert_ARGB8888To422CbYpCrYp8(&src, &dst, &info, permute, kvImageNoFlags) == kvImageNoError;
    }
private:
    vImage_ARGBToYpCbCr info{};
};

// --------------------------------------------------------- scheduled output

class Scheduler : public IDeckLinkVideoOutputCallback {
public:
    IDeckLinkOutput* out = NULL;
    std::vector<IDeckLinkMutableVideoFrame*> frames;   // pre-rendered ring
    BMDTimeValue frameDuration = 0;
    BMDTimeScale timeScale = 0;
    std::atomic<uint64_t> scheduled{0};
    std::atomic<uint64_t> completed{0}, late{0}, dropped{0}, flushed{0};

    HRESULT QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG AddRef() override { return ++ref; }
    ULONG Release() override { return --ref; }

    HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame*, BMDOutputFrameCompletionResult r) override {
        switch (r) {
            case bmdOutputFrameCompleted:     completed++; break;
            case bmdOutputFrameDisplayedLate: late++;      break;
            case bmdOutputFrameDropped:       dropped++;   break;
            case bmdOutputFrameFlushed:       flushed++;   break;
        }
        scheduleNext();
        return S_OK;
    }
    HRESULT ScheduledPlaybackHasStopped() override { return S_OK; }

    void scheduleNext() {
        uint64_t i = scheduled++;
        IDeckLinkMutableVideoFrame* f = frames[i % frames.size()];
        out->ScheduleVideoFrame(f, (BMDTimeValue)(i * frameDuration), frameDuration, timeScale);
    }
private:
    std::atomic<ULONG> ref{1};
};

// --------------------------------------------------------------------- main

static int cmdList() {
    auto devs = enumerate();
    std::vector<int> all;
    for (size_t i = 0; i < devs.size(); i++) all.push_back((int)i);
    probeInputSignals(devs, all);
    printf("[\n");
    for (size_t i = 0; i < devs.size(); i++) {
        printf("  {\"index\":%zu,\"name\":\"%s\",\"model\":\"%s\",\"card\":%d,\"subDevice\":%d,"
               "\"persistentId\":%lld,\"canOutput\":%s,\"signalPresentOnInput\":%s}%s\n",
               i, devs[i].uiName.c_str(), devs[i].model.c_str(), devs[i].card + 1,
               (int)devs[i].subIndex + 1, (long long)devs[i].persistentID,
               devs[i].canOutput ? "true" : "false",
               devs[i].hasSignalIn ? "true" : "false",
               i + 1 < devs.size() ? "," : "");
    }
    printf("]\n");
    for (auto& d : devs) d.dl->Release();
    return 0;
}

static int cmdPlay(int index, const std::string& modeName, const std::string& patName,
                   bool legalRange, double seconds, bool forceYUV, bool force) {
    auto devs = enumerate();
    if (index < 0 || index >= (int)devs.size()) { fprintf(stderr, "device index out of range\n"); return 1; }
    if (!force) probeInputSignals(devs, { index });
    Dev& d = devs[index];

    // Refuse to hijack a sub-device that is currently receiving. Half-duplex
    // ports flip direction when output is opened, so starting playback on a
    // live input silently kills someone's capture.
    if (d.hasSignalIn) {
        fprintf(stderr, "refusing: %s currently has an input signal locked.\n"
                        "          Opening output would flip this half-duplex port to transmit.\n"
                        "          Pass --force if that is genuinely intended.\n", d.uiName.c_str());
        for (auto& x : devs) x.dl->Release();
        return 3;
    }

    IDeckLinkOutput* out = NULL;
    if (d.dl->QueryInterface(IID_IDeckLinkOutput, (void**)&out) != S_OK || !out) {
        fprintf(stderr, "no output interface on %s\n", d.uiName.c_str()); return 1;
    }

    BMDDisplayMode mode = modeFromName(modeName);

    // Pick the pixel format the card will actually accept for this mode.
    BMDPixelFormat pf = bmdFormat8BitBGRA;
    BMDDisplayModeSupport sup = bmdDisplayModeNotSupported;
    if (forceYUV) {
        pf = bmdFormat8BitYUV;
    } else {
        out->DoesSupportVideoMode(mode, bmdFormat8BitBGRA, bmdVideoOutputFlagDefault, &sup, NULL);
        if (sup == bmdDisplayModeNotSupported) pf = bmdFormat8BitYUV;
    }
    sup = bmdDisplayModeNotSupported;
    out->DoesSupportVideoMode(mode, pf, bmdVideoOutputFlagDefault, &sup, NULL);
    if (sup == bmdDisplayModeNotSupported) {
        fprintf(stderr, "mode %s not supported on %s in any usable pixel format\n",
                modeName.c_str(), d.uiName.c_str());
        out->Release(); return 1;
    }

    // Resolve geometry and frame rate from the mode itself.
    int W = 0, H = 0; BMDTimeValue dur = 0; BMDTimeScale ts = 0;
    IDeckLinkDisplayModeIterator* dmIt = NULL;
    if (out->GetDisplayModeIterator(&dmIt) == S_OK) {
        IDeckLinkDisplayMode* dm = NULL;
        while (dmIt->Next(&dm) == S_OK) {
            if (dm->GetDisplayMode() == mode) {
                W = (int)dm->GetWidth(); H = (int)dm->GetHeight();
                dm->GetFrameRate(&dur, &ts);
            }
            dm->Release();
        }
        dmIt->Release();
    }
    if (!W || !ts) { fprintf(stderr, "could not resolve mode geometry\n"); out->Release(); return 1; }

    const double fps = (double)ts / (double)dur;
    const bool subsampled = (pf == bmdFormat8BitYUV);
    printf("device : %s\n", d.uiName.c_str());
    printf("mode   : %s  %dx%d @ %.3f fps\n", modeName.c_str(), W, H, fps);
    printf("format : %s%s\n", subsampled ? "8-bit YUV (UYVY, 4:2:2)" : "8-bit BGRA (4:4:4)",
           subsampled ? "   [chroma subsampled — coloured 1px detail is not pixel-exact]" : "");
    printf("range  : %s\n", legalRange ? "legal/video (16-235)" : "full (0-255)");

    Converter conv;
    if (subsampled && !conv.init(legalRange)) { fprintf(stderr, "vImage conversion setup failed\n"); out->Release(); return 1; }

    TestPattern* pat = NULL;
    if      (patName == "magenta")   pat = new Magenta();
    else if (patName == "grid")      pat = new Grid();
    else if (patName == "graysteps") pat = new GraySteps();
    else if (patName == "motion")    pat = new Motion();
    else { fprintf(stderr, "unknown pattern %s\n", patName.c_str()); out->Release(); return 1; }

    if (out->EnableVideoOutput(mode, bmdVideoOutputFlagDefault) != S_OK) {
        fprintf(stderr, "EnableVideoOutput failed (device busy?)\n"); out->Release(); return 1;
    }

    Scheduler sched;
    sched.out = out; sched.frameDuration = dur; sched.timeScale = ts;
    out->SetScheduledFrameCompletionCallback(&sched);

    // A short ring of pre-rendered frames: enough for motion, cheap enough that
    // conversion never lands on the playback path.
    const int kRing = (patName == "motion") ? 60 : 2;
    std::vector<uint8_t> staging((size_t)W * H * 4);
    for (int i = 0; i < kRing; i++) {
        IDeckLinkMutableVideoFrame* f = NULL;
        const int rowBytes = (pf == bmdFormat8BitBGRA) ? W * 4 : W * 2;
        if (out->CreateVideoFrame(W, H, rowBytes, pf, bmdFrameFlagDefault, &f) != S_OK) {
            fprintf(stderr, "CreateVideoFrame failed\n"); out->Release(); return 1;
        }
        uint8_t* dstBytes = NULL; f->GetBytes((void**)&dstBytes);
        pat->render(staging.data(), W, H, i);
        if (pf == bmdFormat8BitBGRA) memcpy(dstBytes, staging.data(), (size_t)W * H * 4);
        else if (!conv.convert(staging.data(), dstBytes, W, H)) {
            fprintf(stderr, "vImage conversion failed\n"); out->Release(); return 1;
        }
        sched.frames.push_back(f);
    }

    // Preroll before starting the clock, or the first frames are already late.
    const int preroll = 4;
    for (int i = 0; i < preroll; i++) sched.scheduleNext();
    if (out->StartScheduledPlayback(0, ts, 1.0) != S_OK) {
        fprintf(stderr, "StartScheduledPlayback failed\n"); out->Release(); return 1;
    }

    printf("playing for %.1fs...\n", seconds);
    usleep((useconds_t)(seconds * 1e6));

    BMDTimeValue stopped = 0;
    out->StopScheduledPlayback(0, &stopped, ts);
    out->SetScheduledFrameCompletionCallback(NULL);
    out->DisableVideoOutput();

    const uint64_t c = sched.completed, l = sched.late, dr = sched.dropped, fl = sched.flushed;
    const double expected = seconds * fps;
    printf("\n--- pacing ---\n");
    printf("completed on time : %llu\n", (unsigned long long)c);
    printf("displayed late    : %llu\n", (unsigned long long)l);
    printf("dropped           : %llu\n", (unsigned long long)dr);
    printf("flushed (at stop) : %llu\n", (unsigned long long)fl);
    printf("expected ~%.0f frames in %.1fs at %.3f fps\n", expected, seconds, fps);
    const bool clean = (l == 0 && dr == 0) && (c >= expected * 0.98);
    printf("RESULT: %s\n", clean ? "CLEAN — no late or dropped frames" : "PROBLEM — see counters above");

    for (auto* f : sched.frames) f->Release();
    delete pat;
    out->Release();
    for (auto& x : devs) x.dl->Release();
    return clean ? 0 : 4;
}

int main(int argc, char** argv) {
    std::string cmd = argc > 1 ? argv[1] : "";
    if (cmd == "list") return cmdList();
    if (cmd == "play") {
        int index = 0; std::string mode = "1080p59.94", pat = "magenta";
        bool legal = true, forceYUV = false, force = false; double secs = 5.0;
        for (int i = 2; i < argc; i++) {
            std::string a = argv[i];
            auto next = [&]() -> std::string { return (i + 1 < argc) ? argv[++i] : ""; };
            if      (a == "--device")  index = atoi(next().c_str());
            else if (a == "--mode")    mode = next();
            else if (a == "--pattern") pat = next();
            else if (a == "--seconds") secs = atof(next().c_str());
            else if (a == "--range")   legal = (next() != "full");
            else if (a == "--yuv")     forceYUV = true;
            else if (a == "--force")   force = true;
        }
        return cmdPlay(index, mode, pat, legal, secs, forceYUV, force);
    }
    fprintf(stderr,
        "latticeout — DeckLink SDI output helper\n\n"
        "  latticeout list\n"
        "  latticeout play [--device N] [--mode 1080p59.94] [--pattern magenta|grid|graysteps|motion]\n"
        "                  [--seconds S] [--range legal|full] [--yuv]\n");
    return 1;
}
