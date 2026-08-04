// Content-based loopback discovery.
//
// Lock state is useless for this: `IdleOutputOperation = Black` means an idle
// DeckLink output still transmits valid SDI, so every cabled input reads as
// "locked" whether or not we are driving it. Instead, transmit a colour unique
// to each output port and check what each input actually *receives*.
//
// Captures UYVY (the only thing SDI hands back) and reports mean Y/Cb/Cr, which
// doubles as the first real data on the card's colour-range behaviour.
#include <CoreFoundation/CoreFoundation.h>
#include <atomic>
#include <cstdio>
#include <cstring>
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

struct RGB { uint8_t r, g, b; const char* name; };

// Eight widely separated colours so a mis-ident is obvious, not marginal.
static const RGB kSig[8] = {
    { 255,   0,   0, "red"     }, {   0, 255,   0, "green"   },
    {   0,   0, 255, "blue"    }, { 255, 255,   0, "yellow"  },
    { 255,   0, 255, "magenta" }, {   0, 255, 255, "cyan"    },
    { 255, 128,   0, "orange"  }, { 128,   0, 255, "violet"  },
};

// Rec.709 limited-range RGB->YCbCr, the conventional SDI encoding. Used only as
// the reference we compare the captured signal against.
static void rgb2ycc709(const RGB& c, double& Y, double& Cb, double& Cr) {
    double R = c.r / 255.0, G = c.g / 255.0, B = c.b / 255.0;
    double y  = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    double cb = (B - y) / 1.8556;
    double cr = (R - y) / 1.5748;
    Y  = 16.0 + 219.0 * y;
    Cb = 128.0 + 224.0 * cb;
    Cr = 128.0 + 224.0 * cr;
}

// Averages UYVY frames as they arrive. Only the central region is sampled so
// blanking and any edge processing cannot skew the result.
class Averager : public IDeckLinkInputCallback {
public:
    std::atomic<int> frames{0}, noSource{0};
    std::atomic<double> sumY{0}, sumCb{0}, sumCr{0};
    std::atomic<int> minY{255}, maxY{0};
    IDeckLinkInput* input = NULL;          // set by caller, for format-change restarts
    std::atomic<uint32_t> detected{0};     // BMDDisplayMode actually seen on the wire

    HRESULT QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG AddRef() override  { return ++ref; }
    ULONG Release() override { ULONG r = --ref; return r; }

    // Reconfigure to whatever is actually arriving; without this an input only
    // delivers frames when the incoming raster happens to match what we guessed.
    HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents,
                                    IDeckLinkDisplayMode* mode,
                                    BMDDetectedVideoInputFormatFlags) override {
        if (!mode || !input) return S_OK;
        detected = (uint32_t)mode->GetDisplayMode();
        input->StopStreams();
        input->EnableVideoInput(mode->GetDisplayMode(), bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
        input->StartStreams();
        return S_OK;
    }

    HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* f, IDeckLinkAudioInputPacket*) override {
        if (!f) return S_OK;
        if (f->GetFlags() & bmdFrameHasNoInputSource) { noSource++; return S_OK; }
        void* p = NULL;
        if (f->GetBytes(&p) != S_OK || !p) return S_OK;
        const long w = f->GetWidth(), h = f->GetHeight(), rb = f->GetRowBytes();
        double y = 0, cb = 0, cr = 0; long n = 0;
        int lo = 255, hi = 0;
        for (long row = h / 4; row < h * 3 / 4; row += 4) {
            const uint8_t* s = (const uint8_t*)p + row * rb;
            for (long col = w / 4; col < w * 3 / 4; col += 2) {
                const uint8_t* q = s + (col / 2) * 4;   // UYVY: U Y0 V Y1 per 2px
                cb += q[0]; y += q[1]; cr += q[2]; y += q[3]; n += 2;
                lo = std::min({lo, (int)q[1], (int)q[3]});
                hi = std::max({hi, (int)q[1], (int)q[3]});
            }
        }
        if (!n) return S_OK;
        sumY = sumY + y / n; sumCb = sumCb + cb / (n / 2); sumCr = sumCr + cr / (n / 2);
        int cur = minY; while (lo < cur && !minY.compare_exchange_weak(cur, lo)) {}
        cur = maxY;    while (hi > cur && !maxY.compare_exchange_weak(cur, hi)) {}
        frames++;
        return S_OK;
    }
private:
    std::atomic<ULONG> ref{1};
};

struct Dev { IDeckLink* dl; std::string name; int64_t pid; int64_t sub; int card; };

int main() {
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) { fprintf(stderr, "no DeckLink API\n"); return 1; }
    std::vector<Dev> devs;
    IDeckLink* dl = NULL;
    while (it->Next(&dl) == S_OK) {
        Dev d{dl, "", 0, 0, 0};
        CFStringRef m = NULL; dl->GetModelName(&m); std::string model = cf2s(m); if (m) CFRelease(m);
        IDeckLinkAttributes* a = NULL;
        if (dl->QueryInterface(IID_IDeckLinkAttributes, (void**)&a) == S_OK) {
            a->GetInt(BMDDeckLinkPersistentID, &d.pid);
            a->GetInt(BMDDeckLinkSubDeviceIndex, &d.sub);
            a->Release();
        }
        d.name = model;
        devs.push_back(d);
    }
    it->Release();
    int card = 0;
    for (size_t i = 0; i < devs.size(); i++) {
        if (i > 0 && devs[i].sub <= devs[i - 1].sub) card++;
        devs[i].card = card;
        char b[128];
        snprintf(b, sizeof(b), "%s #%d — SDI %d", devs[i].name.c_str(), card + 1, (int)devs[i].sub + 1);
        devs[i].name = b;
    }

    const BMDDisplayMode kMode = bmdModeHD1080p30;
    const int W = 1920, H = 1080;

    printf("expected Rec.709 limited-range encodings:\n");
    for (int i = 0; i < 8; i++) {
        double Y, Cb, Cr; rgb2ycc709(kSig[i], Y, Cb, Cr);
        printf("  [%d] %-8s rgb(%3d,%3d,%3d) -> Y=%6.1f Cb=%6.1f Cr=%6.1f\n",
               i, kSig[i].name, kSig[i].r, kSig[i].g, kSig[i].b, Y, Cb, Cr);
    }
    printf("\n");

    int pairs = 0;
    for (size_t o = 0; o < devs.size(); o++) {
        IDeckLinkOutput* out = NULL;
        if (devs[o].dl->QueryInterface(IID_IDeckLinkOutput, (void**)&out) != S_OK || !out) continue;
        if (out->EnableVideoOutput(kMode, bmdVideoOutputFlagDefault) != S_OK) {
            printf("[%zu] %-28s output unavailable\n", o, devs[o].name.c_str());
            out->Release(); continue;
        }
        IDeckLinkMutableVideoFrame* frame = NULL;
        const RGB& sig = kSig[o % 8];
        if (out->CreateVideoFrame(W, H, W * 4, bmdFormat8BitBGRA, bmdFrameFlagDefault, &frame) == S_OK) {
            uint8_t* px = NULL; frame->GetBytes((void**)&px);
            for (long i = 0; i < (long)W * H; i++) {
                px[i * 4 + 0] = sig.b; px[i * 4 + 1] = sig.g;
                px[i * 4 + 2] = sig.r; px[i * 4 + 3] = 255;
            }
            out->DisplayVideoFrameSync(frame);
        }

        // Listen on every other sub-device at once.
        std::vector<IDeckLinkInput*> ins(devs.size(), NULL);
        std::vector<Averager*> cbs(devs.size(), NULL);
        for (size_t j = 0; j < devs.size(); j++) {
            if (j == o) continue;
            IDeckLinkInput* in = NULL;
            if (devs[j].dl->QueryInterface(IID_IDeckLinkInput, (void**)&in) != S_OK || !in) continue;
            if (in->EnableVideoInput(kMode, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection) != S_OK) {
                if (in->EnableVideoInput(kMode, bmdFormat8BitYUV, bmdVideoInputFlagDefault) != S_OK) { in->Release(); continue; }
            }
            Averager* cb = new Averager();
            cb->input = in;
            in->SetCallback(cb);
            in->StartStreams();
            ins[j] = in; cbs[j] = cb;
        }
        usleep(2200 * 1000);   // 1200ms measured marginal: inputs intermittently fail to lock (see README)

        double eY, eCb, eCr; rgb2ycc709(sig, eY, eCb, eCr);
        printf("[%zu] %-28s transmitting %s\n", o, devs[o].name.c_str(), sig.name);
        for (size_t j = 0; j < devs.size(); j++) {
            if (!ins[j]) continue;
            ins[j]->StopStreams(); ins[j]->DisableVideoInput(); ins[j]->SetCallback(NULL);
            Averager* cb = cbs[j];
            int n = cb->frames;
            char modeStr[8] = "----";
            uint32_t dm = cb->detected;
            if (dm) { modeStr[0] = (dm >> 24) & 0xff; modeStr[1] = (dm >> 16) & 0xff;
                      modeStr[2] = (dm >> 8) & 0xff;  modeStr[3] = dm & 0xff; modeStr[4] = 0; }
            if (n > 0) {
                double Y = cb->sumY / n, Cb = cb->sumCb / n, Cr = cb->sumCr / n;
                double err = std::abs(Y - eY) + std::abs(Cb - eCb) + std::abs(Cr - eCr);
                bool match = err < 24.0;
                printf("      <- [%zu] %-28s [%s] %3d frames  Y=%6.1f Cb=%6.1f Cr=%6.1f  Ymin=%3d Ymax=%3d  err=%6.1f %s\n",
                       j, devs[j].name.c_str(), modeStr, n, Y, Cb, Cr, (int)cb->minY, (int)cb->maxY, err,
                       match ? "  <<< MATCH" : "");
                if (match) pairs++;
            } else {
                printf("      <- [%zu] %-28s [%s] no frames (%d no-source)\n",
                       j, devs[j].name.c_str(), modeStr, (int)cb->noSource);
            }
            ins[j]->Release(); cb->Release();
        }
        if (frame) frame->Release();
        out->DisableVideoOutput(); out->Release();
        printf("\n");
    }
    printf("content-verified loopback pairs: %d\n", pairs);
    for (auto& d : devs) d.dl->Release();
    return pairs > 0 ? 0 : 2;
}
