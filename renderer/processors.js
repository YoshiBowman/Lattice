'use strict';
// LED processor database — per-port pixel budgets for signal (data) runs.
//
// `pxPerPort` is the per-output pixel budget and `totalPx` the whole-processor
// ceiling; BOTH bind in practice (e.g. a NovaStar VX4S has four 650k ports but
// is rated 2.3M overall, less than 4 × 650k).
//
// Capacity depends on colour depth and frame rate — the figures below are the
// manufacturer's headline numbers at the noted conditions. Every value stays
// editable in the app; treat these as good defaults, not gospel, and check the
// data sheet for the firmware you're running.
//
// Verified July 2026 against manufacturer specs / comparison charts:
//   NovaStar  https://www.novastar.tech (VX1000, VX16s, VX600, MCTRL4K, MX40 Pro)
//   Brompton  https://www.bromptontech.com/compare/
//   Megapixel https://megapixelvr.com/helios/
//   Colorlight https://www.colorlight.net
(function () {
  const PROCESSORS = [
    // ---- NovaStar (1G copper ports, headline figures at 8-bit) ----
    {
      id: 'novastar-vx4s', brand: 'NovaStar', model: 'VX4S',
      ports: 4, portType: '1G Ethernet', pxPerPort: 650000, totalPx: 2300000,
      note: '8-bit; rated 2.3M total, below 4 × 650k',
    },
    {
      id: 'novastar-vx600', brand: 'NovaStar', model: 'VX600',
      ports: 6, portType: '1G Ethernet', pxPerPort: 650000, totalPx: 3900000,
      note: '8-bit',
    },
    {
      id: 'novastar-vx1000', brand: 'NovaStar', model: 'VX1000',
      ports: 10, portType: '1G Ethernet', pxPerPort: 650000, totalPx: 6500000,
      note: '8-bit',
    },
    {
      id: 'novastar-vx16s', brand: 'NovaStar', model: 'VX16s',
      ports: 16, portType: '1G Ethernet', pxPerPort: 650000, totalPx: 10400000,
      note: '8-bit',
    },
    {
      id: 'novastar-mctrl660', brand: 'NovaStar', model: 'MCTRL660',
      ports: 4, portType: '1G Ethernet', pxPerPort: 650000, totalPx: 2600000,
      note: '325k per port at 10/12-bit; standard input 1920×1200 = 2.3M, custom to 3840×3840',
    },
    {
      id: 'novastar-mctrl660pro', brand: 'NovaStar', model: 'MCTRL660 PRO',
      ports: 6, portType: '1G Ethernet (+2 × 10G optical)', pxPerPort: 650000, totalPx: 3900000,
      note: 'one optical port carries all 6 Ethernet ports; standard input 1920×1200 = 2.3M, custom to 3840×2560',
    },
    {
      id: 'novastar-mctrl4k', brand: 'NovaStar', model: 'MCTRL4K',
      ports: 16, portType: '1G Ethernet', pxPerPort: 650000, totalPx: 8800000,
      note: '8.8M via DP/HDMI, 8.3M via DVI',
    },
    {
      id: 'novastar-mx40pro', brand: 'NovaStar', model: 'MX40 Pro',
      ports: 20, portType: '1G Ethernet (+4 × 10G optical)', pxPerPort: 650000, totalPx: 9000000,
      note: '9M total; 10G optical ports carry more per fibre',
    },

    // ---- Brompton Tessera (per manufacturer comparison chart) ----
    {
      id: 'brompton-s4', brand: 'Brompton', model: 'Tessera S4',
      ports: 4, portType: '1G Ethernet', pxPerPort: 525000, totalPx: 2100000,
      note: '8-bit @60Hz; less at higher bit depth / frame rate',
    },
    {
      id: 'brompton-s8', brand: 'Brompton', model: 'Tessera S8',
      ports: 8, portType: '1G Ethernet', pxPerPort: 562500, totalPx: 4500000,
      note: 'compare chart figure; data sheet quotes 525k @8-bit 60Hz',
    },
    {
      id: 'brompton-sx40', brand: 'Brompton', model: 'Tessera SX40',
      ports: 4, portType: '10G (fibre or CAT6)', pxPerPort: 2250000, totalPx: 9000000,
      note: '4 trunks / 8 × 10G connectors; 12-bit output',
    },
    {
      id: 'brompton-sq200', brand: 'Brompton', model: 'Tessera SQ200',
      ports: 2, portType: '100G QSFP', pxPerPort: 18000000, totalPx: 36000000,
      note: 'fibre',
    },

    // ---- Megapixel ----
    {
      id: 'megapixel-helios', brand: 'Megapixel', model: 'HELIOS',
      ports: 4, portType: '10G SFP+', pxPerPort: 425000, totalPx: 4250000,
      note: '425k per port at 12-bit 60Hz — higher at lower bit depth',
    },

    // ---- Colorlight ----
    {
      id: 'colorlight-z6pro', brand: 'Colorlight', model: 'Z6 Pro',
      ports: 4, portType: '10G fibre', pxPerPort: 2211840, totalPx: 8847360,
      note: 'max width/height 8192 px',
    },

    // ---- DBSTAR (Nanjing DBSTAR) — ports are 1280×512 = 655,360 px ----
    {
      id: 'dbstar-hvt09', brand: 'DBSTAR', model: 'DBS-HVT09',
      ports: 2, portType: '1G Ethernet', pxPerPort: 655360, totalPx: 1310720,
      note: 'sending card; 2048×640 dual-port, also 1280×1024 / 1024×1200',
    },
    {
      id: 'dbstar-hvt11', brand: 'DBSTAR', model: 'DBS-HVT11 (HVT2011)',
      ports: 2, portType: '1G Ethernet', pxPerPort: 655360, totalPx: 1310720,
      note: 'sending card; 2048×640 dual-port, also 1280×1024 / 1024×1200; dual-link hot backup',
    },
    {
      id: 'dbstar-hvt13vp', brand: 'DBSTAR', model: 'DBS-HVT13VP',
      ports: 4, portType: '1G Ethernet', pxPerPort: 655360, totalPx: 2304000,
      note: '1280×512 per port; all four together rated 2560×900',
    },
    {
      id: 'dbstar-hvt13vpm', brand: 'DBSTAR', model: 'DBS-HVT13VP-M',
      ports: 4, portType: '1G Ethernet', pxPerPort: 655360, totalPx: 2304000,
      note: '1280×512 per port; all four together rated 2560×900; 10-bit processing',
    },
  ];

  const byId = (id) => PROCESSORS.find((p) => p.id === id) || null;

  function brands() {
    const seen = [];
    PROCESSORS.forEach((p) => { if (!seen.includes(p.brand)) seen.push(p.brand); });
    return seen;
  }

  window.LED_PROCESSORS = PROCESSORS;
  window.LED_PROCESSOR_BY_ID = byId;
  window.LED_PROCESSOR_BRANDS = brands;
})();
