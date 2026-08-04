// Deterministic test for the §5c sub-device pairing question.
//
// The observation to explain: transmitting on card #2 SDI 3 appeared to make
// SDI 4 lose its input signal. If connectors really pair, "8 sub-devices = 8
// processor feeds" is wrong and Phase 3's UI has to be constrained.
//
// Method: repeated trials. A control trial transmits nothing and samples every
// input; each test trial transmits on one port and samples all the others. If a
// port is genuinely disturbed by a neighbour it will fail in test trials and
// pass in controls, consistently. Anything that fails intermittently in both is
// a measurement artefact, not pairing.
//
// The settle window is deliberately generous: 900ms was already measured too
// short for a receiver to lock, and loopscan's 1200ms was marginal — which is
// itself a candidate explanation for the original observation.
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

class Counter : public IDeckLinkInputCallback {
public:
    std::atomic<int> frames{0}, noSource{0};
    IDeckLinkInput* input = NULL;
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
        if (!f) return S_OK;
        if (f->GetFlags() & bmdFrameHasNoInputSource) noSource++; else frames++;
        return S_OK;
    }
private:
    std::atomic<ULONG> ref{1};
};

struct Dev { IDeckLink* dl; std::string name; int64_t sub; int card; };

int main(int argc, char** argv) {
    int trials = 6;
    int settleMs = 2000;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--trials" && i + 1 < argc) trials = atoi(argv[++i]);
        if (a == "--settle" && i + 1 < argc) settleMs = atoi(argv[++i]);
    }

    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) { fprintf(stderr, "no DeckLink API\n"); return 1; }
    std::vector<Dev> devs;
    IDeckLink* dl = NULL;
    while (it->Next(&dl) == S_OK) {
        Dev d{dl, "", 0, 0};
        CFStringRef m = NULL; dl->GetModelName(&m); std::string model = cf2s(m); if (m) CFRelease(m);
        IDeckLinkAttributes* a = NULL;
        if (dl->QueryInterface(IID_IDeckLinkAttributes, (void**)&a) == S_OK) {
            a->GetInt(BMDDeckLinkSubDeviceIndex, &d.sub); a->Release();
        }
        d.name = model;
        devs.push_back(d);
    }
    it->Release();
    int card = 0;
    for (size_t i = 0; i < devs.size(); i++) {
        if (i > 0 && devs[i].sub <= devs[i-1].sub) card++;
        devs[i].card = card;
        char b[128];
        snprintf(b, sizeof(b), "c%d/SDI%d", card + 1, (int)devs[i].sub + 1);
        devs[i].name = b;
    }
    const size_t N = devs.size();

    // pass[o][j] = trials in which input j delivered real frames while o transmitted.
    // o == N means the control (transmit nothing).
    std::vector<std::vector<int>> pass(N + 1, std::vector<int>(N, 0));
    std::vector<std::vector<int>> runs(N + 1, std::vector<int>(N, 0));

    auto oneTrial = [&](int o) {
        IDeckLinkOutput* out = NULL;
        IDeckLinkMutableVideoFrame* frame = NULL;
        if (o >= 0) {
            if (devs[o].dl->QueryInterface(IID_IDeckLinkOutput, (void**)&out) != S_OK || !out) return;
            if (out->EnableVideoOutput(bmdModeHD1080p30, bmdVideoOutputFlagDefault) != S_OK) { out->Release(); return; }
            if (out->CreateVideoFrame(1920, 1080, 1920 * 4, bmdFormat8BitBGRA, bmdFrameFlagDefault, &frame) == S_OK) {
                void* p = NULL; frame->GetBytes(&p);
                memset(p, 0x80, 1920L * 1080 * 4);
                out->DisplayVideoFrameSync(frame);
            }
        }
        std::vector<IDeckLinkInput*> ins(N, NULL);
        std::vector<Counter*> cbs(N, NULL);
        for (size_t j = 0; j < N; j++) {
            if ((int)j == o) continue;
            IDeckLinkInput* in = NULL;
            if (devs[j].dl->QueryInterface(IID_IDeckLinkInput, (void**)&in) != S_OK || !in) continue;
            if (in->EnableVideoInput(bmdModeHD1080i5994, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection) != S_OK) {
                in->Release(); continue;
            }
            Counter* c = new Counter(); c->input = in;
            in->SetCallback(c); in->StartStreams();
            ins[j] = in; cbs[j] = c;
        }
        usleep(settleMs * 1000);
        int row = (o < 0) ? (int)N : o;
        for (size_t j = 0; j < N; j++) {
            if (!ins[j]) continue;
            ins[j]->StopStreams(); ins[j]->DisableVideoInput(); ins[j]->SetCallback(NULL);
            runs[row][j]++;
            if (cbs[j]->frames > 0) pass[row][j]++;
            ins[j]->Release(); cbs[j]->Release();
        }
        if (frame) frame->Release();
        if (out) { out->DisableVideoOutput(); out->Release(); }
    };

    printf("trials=%d settle=%dms\n\n", trials, settleMs);
    for (int t = 0; t < trials; t++) {
        oneTrial(-1);                                   // control
        for (size_t o = 0; o < N; o++) oneTrial((int)o); // each transmitter
        printf("trial %d/%d done\n", t + 1, trials);
        fflush(stdout);
    }

    printf("\nfraction of trials in which each input delivered frames\n");
    printf("(rows = who is transmitting; CONTROL = nobody)\n\n");
    printf("%-10s", "TX \\ RX");
    for (size_t j = 0; j < N; j++) printf("%9s", devs[j].name.c_str());
    printf("\n");
    for (size_t r = 0; r <= N; r++) {
        printf("%-10s", r == N ? "CONTROL" : devs[r].name.c_str());
        for (size_t j = 0; j < N; j++) {
            if (runs[r][j] == 0) { printf("%9s", r == j ? "(tx)" : "-"); continue; }
            printf("%8.0f%%", 100.0 * pass[r][j] / runs[r][j]);
        }
        printf("\n");
    }
    for (auto& d : devs) d.dl->Release();
    return 0;
}
