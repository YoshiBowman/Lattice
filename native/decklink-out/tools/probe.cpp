// Phase 0 read-only probe: enumerate DeckLink devices and their output capabilities.
// Opens nothing, enables no output, changes no configuration.
#include <CoreFoundation/CoreFoundation.h>
#include <cstdio>
#include <cstring>
#include <string>
#include "DeckLinkAPI.h"
#include "DeckLinkAPIVersion.h"

static std::string cf2s(CFStringRef s) {
    if (!s) return "";
    char buf[512];
    if (!CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8)) return "";
    return std::string(buf);
}

static std::string fourcc(uint32_t v) {
    char b[5] = { char((v >> 24) & 0xff), char((v >> 16) & 0xff), char((v >> 8) & 0xff), char(v & 0xff), 0 };
    for (int i = 0; i < 4; i++) if (b[i] < 32 || b[i] > 126) b[i] = '.';
    return std::string(b);
}

static void attrInt(IDeckLinkAttributes* a, BMDDeckLinkAttributeID id, const char* label, bool asFourcc = false) {
    int64_t v = 0;
    if (a->GetInt(id, &v) == S_OK) {
        if (asFourcc) printf("    %-28s %s (0x%08llx)\n", label, fourcc((uint32_t)v).c_str(), (unsigned long long)v);
        else          printf("    %-28s %lld\n", label, (long long)v);
    }
}

static void attrFlag(IDeckLinkAttributes* a, BMDDeckLinkAttributeID id, const char* label) {
    bool v = false;
    if (a->GetFlag(id, &v) == S_OK) printf("    %-28s %s\n", label, v ? "yes" : "no");
}

// Pixel formats we care about for pushing canvas frames.
static struct { BMDPixelFormat pf; const char* name; } kPix[] = {
    { bmdFormat8BitBGRA, "8-bit BGRA" },
    { bmdFormat8BitARGB, "8-bit ARGB" },
    { bmdFormat8BitYUV,  "8-bit YUV (UYVY)" },
    { bmdFormat10BitYUV, "10-bit YUV" },
    { bmdFormat10BitRGB, "10-bit RGB" },
};

int main() {
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) { fprintf(stderr, "CreateDeckLinkIteratorInstance failed - driver/API bundle not loadable\n"); return 1; }

    IDeckLinkAPIInformation* apiInfo = CreateDeckLinkAPIInformationInstance();
    if (apiInfo) {
        CFStringRef s = NULL;
        if (apiInfo->GetString(BMDDeckLinkAPIVersion, &s) == S_OK) {
            printf("DeckLink API (driver) version: %s\n", cf2s(s).c_str());
            CFRelease(s);
        }
        apiInfo->Release();
    }
    printf("Headers compiled against:      %s\n\n", BLACKMAGIC_DECKLINK_API_VERSION_STRING);

    IDeckLink* dl = NULL;
    int n = 0;
    while (it->Next(&dl) == S_OK) {
        CFStringRef model = NULL, disp = NULL;
        dl->GetModelName(&model);
        dl->GetDisplayName(&disp);
        printf("=== device %d: %s  [%s] ===\n", n, cf2s(disp).c_str(), cf2s(model).c_str());
        if (model) CFRelease(model);
        if (disp) CFRelease(disp);

        IDeckLinkAttributes* attr = NULL;
        if (dl->QueryInterface(IID_IDeckLinkAttributes, (void**)&attr) == S_OK) {
            attrInt(attr, BMDDeckLinkPersistentID,        "PersistentID");
            attrInt(attr, BMDDeckLinkTopologicalID,       "TopologicalID");
            attrInt(attr, BMDDeckLinkSubDeviceIndex,      "SubDeviceIndex");
            attrInt(attr, BMDDeckLinkNumberOfSubDevices,  "NumberOfSubDevices");
            attrFlag(attr, BMDDeckLinkSupportsDuplexModeConfiguration, "DuplexConfigurable");
            attrFlag(attr, BMDDeckLinkSupportsFullDuplex, "SupportsFullDuplex");
            attrFlag(attr, BMDDeckLinkSupportsSMPTELevelAOutput, "SupportsSMPTELevelAOutput");
            attrInt(attr, BMDDeckLinkVideoOutputConnections, "VideoOutputConnections", true);
            attrInt(attr, BMDDeckLinkVideoInputConnections,  "VideoInputConnections", true);
            attrFlag(attr, BMDDeckLinkSupportsInternalKeying, "SupportsInternalKeying");
            attrFlag(attr, BMDDeckLinkSupportsHDKeying,       "SupportsHDKeying");
            attr->Release();
        }

        IDeckLinkStatus* st = NULL;
        if (dl->QueryInterface(IID_IDeckLinkStatus, (void**)&st) == S_OK) {
            int64_t v = 0;
            if (st->GetInt(bmdDeckLinkStatusDuplexMode, &v) == S_OK)
                printf("    %-28s %s\n", "DuplexStatus", fourcc((uint32_t)v).c_str());
            st->Release();
        }

        IDeckLinkInput* in = NULL;
        bool hasInput = (dl->QueryInterface(IID_IDeckLinkInput, (void**)&in) == S_OK);
        if (in) in->Release();

        IDeckLinkOutput* out = NULL;
        if (dl->QueryInterface(IID_IDeckLinkOutput, (void**)&out) != S_OK || !out) {
            printf("    ROLE: capture only (no IDeckLinkOutput)   input iface: %s\n\n", hasInput ? "yes" : "no");
            dl->Release();
            n++;
            continue;
        }
        printf("    ROLE: PLAYBACK capable                    input iface: %s\n", hasInput ? "yes" : "no");

        IDeckLinkDisplayModeIterator* dmIt = NULL;
        if (out->GetDisplayModeIterator(&dmIt) == S_OK) {
            printf("    supported output modes:\n");
            IDeckLinkDisplayMode* dm = NULL;
            while (dmIt->Next(&dm) == S_OK) {
                CFStringRef nm = NULL;
                dm->GetName(&nm);
                BMDTimeValue dur = 0; BMDTimeScale sc = 0;
                dm->GetFrameRate(&dur, &sc);
                BMDDisplayMode code = dm->GetDisplayMode();
                double fps = dur ? (double)sc / (double)dur : 0.0;
                char pix[256] = "";
                for (auto& p : kPix) {
                    BMDDisplayModeSupport sup = bmdDisplayModeNotSupported;
                    if (out->DoesSupportVideoMode(code, p.pf, bmdVideoOutputFlagDefault, &sup, NULL) == S_OK
                        && sup != bmdDisplayModeNotSupported) {
                        strncat(pix, p.name, sizeof(pix) - strlen(pix) - 1);
                        strncat(pix, "; ", sizeof(pix) - strlen(pix) - 1);
                    }
                }
                printf("      %-28s %5ldx%-5ld %7.3f fps  [%s]  %s\n",
                       cf2s(nm).c_str(), (long)dm->GetWidth(), (long)dm->GetHeight(), fps,
                       fourcc(code).c_str(), pix);
                if (nm) CFRelease(nm);
                dm->Release();
            }
            dmIt->Release();
        }
        out->Release();
        printf("\n");
        dl->Release();
        n++;
    }
    it->Release();
    printf("total devices: %d\n", n);
    return 0;
}
