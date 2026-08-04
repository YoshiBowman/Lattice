// Inspect an incoming SDI signal and report everything the card can tell us
// about it, plus measured levels.
//
// Built to diff a known-good source (one the LED processors accept) against
// what Lattice produces, when the processor takes one and refuses the other.
#include <CoreFoundation/CoreFoundation.h>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>
#include <unistd.h>
#include "DeckLinkAPI.h"

static std::string cf2s(CFStringRef s) {
    if (!s) return "";
    char b[512];
    if (!CFStringGetCString(s, b, sizeof(b), kCFStringEncodingUTF8)) return "";
    return std::string(b);
}
static std::string fcc(uint32_t v) {
    char b[5] = { char((v>>24)&0xff), char((v>>16)&0xff), char((v>>8)&0xff), char(v&0xff), 0 };
    for (int i = 0; i < 4; i++) if (b[i] < 32 || b[i] > 126) b[i] = '.';
    return std::string(b);
}

class Inspector : public IDeckLinkInputCallback {
public:
    IDeckLinkInput* input = NULL;
    std::mutex mu;
    std::vector<uint8_t> frame;
    long W = 0, H = 0, rowBytes = 0;
    std::atomic<int> count{0};
    std::atomic<uint32_t> mode{0}, flags{0};
    std::string modeName;
    double fps = 0;
    BMDFieldDominance dominance = bmdUnknownFieldDominance;

    HRESULT QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG AddRef() override { return ++ref; }
    ULONG Release() override { return --ref; }

    HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents,
                                    IDeckLinkDisplayMode* m,
                                    BMDDetectedVideoInputFormatFlags f) override {
        if (!m || !input) return S_OK;
        {
            std::lock_guard<std::mutex> g(mu);
            mode = (uint32_t)m->GetDisplayMode();
            flags = (uint32_t)f;
            CFStringRef nm = NULL; m->GetName(&nm); modeName = cf2s(nm); if (nm) CFRelease(nm);
            BMDTimeValue dur = 0; BMDTimeScale ts = 0;
            m->GetFrameRate(&dur, &ts);
            fps = dur ? (double)ts / (double)dur : 0;
            dominance = m->GetFieldDominance();
        }
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
private:
    std::atomic<ULONG> ref{1};
};

int main(int argc, char** argv) {
    int idx = 4;
    int secs = 4;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--device" && i + 1 < argc) idx = atoi(argv[++i]);
        if (a == "--seconds" && i + 1 < argc) secs = atoi(argv[++i]);
    }

    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) { fprintf(stderr, "no DeckLink API\n"); return 1; }
    std::vector<IDeckLink*> devs;
    IDeckLink* dl = NULL;
    while (it->Next(&dl) == S_OK) devs.push_back(dl);
    it->Release();
    if (idx < 0 || idx >= (int)devs.size()) { fprintf(stderr, "bad index\n"); return 1; }

    CFStringRef nm = NULL; devs[idx]->GetDisplayName(&nm);
    printf("=== inspecting device %d (%s) ===\n", idx, cf2s(nm).c_str());
    if (nm) CFRelease(nm);

    IDeckLinkInput* in = NULL;
    if (devs[idx]->QueryInterface(IID_IDeckLinkInput, (void**)&in) != S_OK) { fprintf(stderr, "no input\n"); return 1; }

    Inspector insp; insp.input = in;
    in->EnableVideoInput(bmdModeHD1080i5994, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
    in->SetCallback(&insp);
    in->StartStreams();
    for (int t = 0; t < secs * 20 && insp.count < 30; t++) usleep(50 * 1000);
    in->StopStreams(); in->DisableVideoInput(); in->SetCallback(NULL);

    std::lock_guard<std::mutex> g(insp.mu);
    if (insp.count < 1 || insp.frame.empty()) { printf("  no signal\n"); return 2; }

    const uint32_t f = insp.flags;
    printf("  detected mode      : %s  [%s]  %.3f fps  %s\n",
           insp.modeName.c_str(), fcc(insp.mode).c_str(), insp.fps,
           insp.dominance == bmdProgressiveFrame ? "progressive"
             : insp.dominance == bmdUpperFieldFirst ? "interlaced (upper first)"
             : insp.dominance == bmdLowerFieldFirst ? "interlaced (lower first)" : "unknown");
    printf("  raster             : %ldx%ld\n", insp.W, insp.H);
    printf("  signal carries     : %s%s%s\n",
           (f & bmdDetectedVideoInputYCbCr422) ? "YCbCr 4:2:2 " : "",
           (f & bmdDetectedVideoInputRGB444) ? "RGB 4:4:4 " : "",
           (f & bmdDetectedVideoInputDualStream3D) ? "(dual stream 3D) " : "");
    printf("  raw format flags   : 0x%08x\n", f);

    // Measured levels. Legal-range content sits inside 16-235; anything at or
    // beyond those bounds indicates full-range (or clipping).
    int yMin = 255, yMax = 0, cbMin = 255, cbMax = 0, crMin = 255, crMax = 0;
    long belowLegal = 0, aboveLegal = 0, n = 0;
    double ySum = 0;
    for (long y = 0; y < insp.H; y += 2) {
        const uint8_t* row = insp.frame.data() + y * insp.rowBytes;
        for (long x = 0; x < insp.W; x += 2) {
            const uint8_t* q = row + (x / 2) * 4;
            int cb = q[0], y0 = q[1], cr = q[2], y1 = q[3];
            for (int yv : { y0, y1 }) {
                yMin = std::min(yMin, yv); yMax = std::max(yMax, yv);
                if (yv < 16) belowLegal++;
                if (yv > 235) aboveLegal++;
                ySum += yv; n++;
            }
            cbMin = std::min(cbMin, cb); cbMax = std::max(cbMax, cb);
            crMin = std::min(crMin, cr); crMax = std::max(crMax, cr);
        }
    }
    printf("  luma  Y            : min %d  max %d  mean %.1f\n", yMin, yMax, ySum / (n ? n : 1));
    printf("  chroma Cb          : min %d  max %d\n", cbMin, cbMax);
    printf("  chroma Cr          : min %d  max %d\n", crMin, crMax);
    printf("  samples outside legal range: %ld below 16, %ld above 235 (of %ld)\n",
           belowLegal, aboveLegal, n);
    printf("  => looks like       : %s\n",
           (belowLegal > n / 1000 || aboveLegal > n / 1000) ? "FULL range (0-255)"
             : (yMin <= 17 && yMax >= 234) ? "LEGAL range (16-235), using the full legal excursion"
             : "LEGAL range (16-235) or limited content");

    in->Release();
    for (auto* d : devs) d->Release();
    return 0;
}
