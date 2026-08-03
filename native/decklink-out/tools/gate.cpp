// The byte-exact gate: transmit a known pattern on one sub-device, capture it
// on another through the Videohub loopback, and compare pixels.
//
// Answers the questions clean pacing counters cannot: is 1:1 actually pixel
// exact, do Gray Steps crush or clip, and which colour range leaves the card.
//
// Transmit and capture live in one process so the timing is controlled and the
// whole mode/range matrix can run unattended.
#include <Accelerate/Accelerate.h>
#include <CoreFoundation/CoreFoundation.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <mutex>
#include <unistd.h>
#include "DeckLinkAPI.h"

static std::string cf2s(CFStringRef s) {
    if (!s) return "";
    char b[512];
    if (!CFStringGetCString(s, b, sizeof(b), kCFStringEncodingUTF8)) return "";
    return std::string(b);
}

// ------------------------------------------------------------------ capture

// Holds the most recent complete frame as raw UYVY.
class Grabber : public IDeckLinkInputCallback {
public:
    IDeckLinkInput* input = NULL;
    std::mutex mu;
    std::vector<uint8_t> frame;
    long W = 0, H = 0, rowBytes = 0;
    std::atomic<int> count{0};

    HRESULT QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG AddRef() override { return ++ref; }
    ULONG Release() override { return --ref; }
    HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents, IDeckLinkDisplayMode* m,
                                    BMDDetectedVideoInputFormatFlags) override {
        if (!m || !input) return S_OK;
        input->StopStreams();
        input->EnableVideoInput(m->GetDisplayMode(), bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
        input->StartStreams();
        return S_OK;
    }
    HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* f, IDeckLinkAudioInputPacket*) override {
        if (!f || (f->GetFlags() & bmdFrameHasNoInputSource)) return S_OK;
        void* p = NULL;
        if (f->GetBytes(&p) != S_OK || !p) return S_OK;
        std::lock_guard<std::mutex> g(mu);
        W = f->GetWidth(); H = f->GetHeight(); rowBytes = f->GetRowBytes();
        frame.assign((uint8_t*)p, (uint8_t*)p + rowBytes * H);
        count++;
        return S_OK;
    }
    // UYVY: U Y0 V Y1 covers two horizontal pixels.
    int Y(long x, long y) const { return frame[y * rowBytes + (x / 2) * 4 + ((x & 1) ? 3 : 1)]; }
    int Cb(long x, long y) const { return frame[y * rowBytes + (x / 2) * 4 + 0]; }
    int Cr(long x, long y) const { return frame[y * rowBytes + (x / 2) * 4 + 2]; }
private:
    std::atomic<ULONG> ref{1};
};

// ----------------------------------------------------------------- patterns

static void patGraySteps(uint8_t* p, int w, int h) {
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        uint8_t v = (uint8_t)(((x * 16) / w) * 255 / 15);
        uint8_t* q = p + ((long)y * w + x) * 4;
        q[0] = q[1] = q[2] = v; q[3] = 255;
    }
}
// 1px white lines every 16px on black — the pixel-exactness probe.
static void patGrid(uint8_t* p, int w, int h) {
    memset(p, 0, (size_t)w * h * 4);
    for (long i = 0; i < (long)w * h; i++) p[i * 4 + 3] = 255;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x += 16) {
        uint8_t* q = p + ((long)y * w + x) * 4;
        q[0] = q[1] = q[2] = 255;
    }
}
// Alternating 1px red/blue columns: survives only if chroma is full bandwidth.
static void patChroma(uint8_t* p, int w, int h) {
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        uint8_t* q = p + ((long)y * w + x) * 4;
        const bool red = (x & 1) == 0;
        q[0] = red ? 0 : 255;   // B
        q[1] = 0;               // G
        q[2] = red ? 255 : 0;   // R
        q[3] = 255;
    }
}
// Flat black then flat white: the colour-range readout.
static void patLevels(uint8_t* p, int w, int h) {
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        uint8_t v = (x < w / 2) ? 0 : 255;
        uint8_t* q = p + ((long)y * w + x) * 4;
        q[0] = q[1] = q[2] = v; q[3] = 255;
    }
}

int main(int argc, char** argv) {
    int outIdx = 0, inIdx = 4;
    std::string modeName = "1080p59.94", rangeName = "legal";
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto nx = [&]() -> std::string { return (i + 1 < argc) ? argv[++i] : ""; };
        if      (a == "--out")   outIdx = atoi(nx().c_str());
        else if (a == "--in")    inIdx = atoi(nx().c_str());
        else if (a == "--mode")  modeName = nx();
        else if (a == "--range") rangeName = nx();
    }
    const bool legal = (rangeName != "full");

    struct { const char* n; BMDDisplayMode m; } modes[] = {
        { "1080p59.94", bmdModeHD1080p5994 }, { "1080p60", bmdModeHD1080p6000 },
        { "1080p50", bmdModeHD1080p50 }, { "1080p30", bmdModeHD1080p30 },
        { "1080p25", bmdModeHD1080p25 }, { "720p60", bmdModeHD720p60 },
        { "720p59.94", bmdModeHD720p5994 },
    };
    BMDDisplayMode mode = bmdModeHD1080p5994;
    for (auto& e : modes) if (modeName == e.n) mode = e.m;

    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) { fprintf(stderr, "no DeckLink API\n"); return 1; }
    std::vector<IDeckLink*> devs;
    IDeckLink* dl = NULL;
    while (it->Next(&dl) == S_OK) devs.push_back(dl);
    it->Release();
    if (outIdx >= (int)devs.size() || inIdx >= (int)devs.size()) { fprintf(stderr, "index out of range\n"); return 1; }

    IDeckLinkOutput* out = NULL;
    if (devs[outIdx]->QueryInterface(IID_IDeckLinkOutput, (void**)&out) != S_OK) { fprintf(stderr, "no output\n"); return 1; }
    IDeckLinkInput* in = NULL;
    if (devs[inIdx]->QueryInterface(IID_IDeckLinkInput, (void**)&in) != S_OK) { fprintf(stderr, "no input\n"); return 1; }

    BMDPixelFormat pf = bmdFormat8BitBGRA;
    BMDDisplayModeSupport sup = bmdDisplayModeNotSupported;
    if (!legal) sup = bmdDisplayModeNotSupported; else out->DoesSupportVideoMode(mode, bmdFormat8BitBGRA, bmdVideoOutputFlagDefault, &sup, NULL);
    const bool needConv = (sup == bmdDisplayModeNotSupported);
    if (needConv) pf = bmdFormat8BitYUV;

    int W = 0, H = 0;
    IDeckLinkDisplayModeIterator* dmIt = NULL;
    if (out->GetDisplayModeIterator(&dmIt) == S_OK) {
        IDeckLinkDisplayMode* dm = NULL;
        while (dmIt->Next(&dm) == S_OK) {
            if (dm->GetDisplayMode() == mode) { W = (int)dm->GetWidth(); H = (int)dm->GetHeight(); }
            dm->Release();
        }
        dmIt->Release();
    }
    if (!W) { fprintf(stderr, "bad mode\n"); return 1; }

    vImage_ARGBToYpCbCr cinfo{};
    if (needConv) {
        vImage_ARGBToYpCbCrMatrix mx = *kvImage_ARGBToYpCbCrMatrix_ITU_R_709_2;
        vImage_YpCbCrPixelRange range = legal
            ? vImage_YpCbCrPixelRange{ 16, 128, 235, 240, 235, 16, 240, 16 }
            : vImage_YpCbCrPixelRange{  0, 128, 255, 255, 255,  0, 255,  1 };
        vImageConvert_ARGBToYpCbCr_GenerateConversion(&mx, &range, &cinfo, kvImageARGB8888,
                                                      kvImage422CbYpCrYp8, kvImageNoFlags);
    }

    printf("gate: out=%d in=%d mode=%s (%dx%d) wire=%s range=%s\n\n",
           outIdx, inIdx, modeName.c_str(), W, H,
           needConv ? "UYVY (vImage)" : "BGRA (card converts)", legal ? "legal" : "full");

    out->EnableVideoOutput(mode, bmdVideoOutputFlagDefault);

    struct Check { const char* name; void (*render)(uint8_t*, int, int); };
    Check checks[] = {
        { "levels",    patLevels },
        { "graysteps", patGraySteps },
        { "grid",      patGrid },
        { "chroma",    patChroma },
    };

    std::vector<uint8_t> bgra((size_t)W * H * 4);
    int failures = 0;

    for (auto& chk : checks) {
        chk.render(bgra.data(), W, H);
        IDeckLinkMutableVideoFrame* f = NULL;
        const int rb = needConv ? W * 2 : W * 4;
        if (out->CreateVideoFrame(W, H, rb, pf, bmdFrameFlagDefault, &f) != S_OK) { fprintf(stderr, "frame alloc\n"); return 1; }
        uint8_t* dst = NULL; f->GetBytes((void**)&dst);
        if (needConv) {
            vImage_Buffer s{ bgra.data(), (vImagePixelCount)H, (vImagePixelCount)W, (size_t)W * 4 };
            vImage_Buffer d{ dst, (vImagePixelCount)H, (vImagePixelCount)W, (size_t)W * 2 };
            const uint8_t perm[4] = { 3, 2, 1, 0 };
            vImageConvert_ARGB8888To422CbYpCrYp8(&s, &d, &cinfo, perm, kvImageNoFlags);
        } else {
            memcpy(dst, bgra.data(), (size_t)W * H * 4);
        }
        out->DisplayVideoFrameSync(f);

        Grabber g; g.input = in;
        in->EnableVideoInput(mode, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
        in->SetCallback(&g);
        in->StartStreams();
        for (int t = 0; t < 60 && g.count < 12; t++) usleep(50 * 1000);
        in->StopStreams(); in->DisableVideoInput(); in->SetCallback(NULL);

        std::lock_guard<std::mutex> lk(g.mu);
        if (g.count < 1 || g.frame.empty()) {
            printf("  %-10s NO SIGNAL CAPTURED — is the route set?\n", chk.name);
            failures++; f->Release(); continue;
        }
        const long midY = g.H / 2;

        if (!strcmp(chk.name, "levels")) {
            int black = g.Y(W / 4, midY), white = g.Y(W * 3 / 4, midY);
            int cbB = g.Cb(W / 4, midY), crB = g.Cr(W / 4, midY);
            const int expB = legal ? 16 : 0, expW = legal ? 235 : 255;
            bool ok = abs(black - expB) <= 2 && abs(white - expW) <= 2;
            printf("  %-10s black Y=%3d (expect %3d)   white Y=%3d (expect %3d)   neutral Cb=%3d Cr=%3d   %s\n",
                   chk.name, black, expB, white, expW, cbB, crB, ok ? "PASS" : "FAIL");
            if (!ok) failures++;
        } else if (!strcmp(chk.name, "graysteps")) {
            int v[16]; bool mono = true, distinct = true;
            for (int s = 0; s < 16; s++) v[s] = g.Y((long)(s * W / 16 + W / 32), midY);
            for (int s = 1; s < 16; s++) { if (v[s] < v[s-1]) mono = false; if (v[s] == v[s-1]) distinct = false; }
            printf("  %-10s steps:", chk.name);
            for (int s = 0; s < 16; s++) printf(" %d", v[s]);
            printf("\n             monotonic=%s all-distinct=%s (no crush/clip) %s\n",
                   mono ? "yes" : "NO", distinct ? "yes" : "NO",
                   (mono && distinct) ? "PASS" : "FAIL");
            if (!(mono && distinct)) failures++;
        } else if (!strcmp(chk.name, "grid")) {
            // Every 16th column should be bright, all others dark, with no
            // spreading into neighbours.
            int hits = 0, misses = 0, bleed = 0;
            const int dark = g.Y(5, midY);
            for (int x = 0; x < W; x += 16) {
                if (g.Y(x, midY) > dark + 60) hits++; else misses++;
                if (x + 1 < W && g.Y(x + 1, midY) > dark + 60) bleed++;
            }
            bool ok = (misses == 0 && bleed == 0);
            printf("  %-10s lines found %d/%d, neighbour bleed %d  %s\n",
                   chk.name, hits, hits + misses, bleed, ok ? "PASS (1px exact)" : "FAIL");
            if (!ok) failures++;
        } else {
            // Alternating 1px red/blue: if chroma is subsampled the Cr swing
            // between adjacent pixel pairs collapses toward the mean.
            int crMin = 255, crMax = 0;
            for (int x = W / 4; x < W / 4 + 64; x++) {
                int cr = g.Cr(x, midY);
                crMin = std::min(crMin, cr); crMax = std::max(crMax, cr);
            }
            const int swing = crMax - crMin;
            printf("  %-10s Cr swing across 1px red/blue columns = %d %s\n",
                   chk.name, swing,
                   swing > 60 ? "(chroma full bandwidth)" : "(CHROMA SUBSAMPLED — 1px colour detail lost)");
        }
        f->Release();
    }

    out->DisableVideoOutput();
    out->Release(); in->Release();
    for (auto* d : devs) d->Release();
    printf("\n%s\n", failures ? "GATE: FAILURES ABOVE" : "GATE: all pass/fail checks passed");
    return failures ? 1 : 0;
}
