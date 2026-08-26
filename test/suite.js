'use strict';
// Lattice verification suite. Drives the running app over the Chrome DevTools
// Protocol, so every check exercises the real renderer rather than a mock.
//
//   npm start -- --remote-debugging-port=9333      (or: npx electron . --remote-debugging-port=9333)
//   node test/suite.js
//
// Kept in the repo deliberately: the scratchpad copies of these checks were
// lost to a temp-dir cleanup, and re-deriving them cost more than storing them.
const PORT = process.argv[2] || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      call: (m, p) => new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
      }),
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
  });
}

async function evalIn(page, expr) {
  const r = await page.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

let failures = 0;
let group = '';
function section(name) { group = name; console.log(`\n── ${name}`); }
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

(async () => {
  let list = await targets();
  const ctrl = list.find((t) => t.url.includes('control.html'));
  if (!ctrl) throw new Error('control window not found — is the app running with --remote-debugging-port?');
  const page = await connect(ctrl.webSocketDebuggerUrl);

  const reset = `(function(){
    window.ledwall.stopAll();
    cfg = normalizeConfig(JSON.parse(JSON.stringify(DEFAULTS)));
    syncWallInputs(); syncPatternUI(); syncOverlayUI(); syncContentUI(); push(); renderDisplays();
    return 1;
  })()`;

  // Start from a known state. Without this, windows left open by an aborted
  // run (or by hand) are counted by the live-output checks and report failures
  // that have nothing to do with the code.
  await evalIn(page, reset);
  await sleep(700);

  // ───────────────────────────────────────────── shell
  section('control window');
  const shell = JSON.parse(await evalIn(page, `JSON.stringify({
    cols: !!document.querySelector('#colWalls') && !!document.querySelector('#colContent') && !!document.querySelector('#colRight'),
    show: !!document.querySelector('#saveShowBtn') && !!document.querySelector('#loadShowBtn'),
    tabs: document.querySelectorAll('.card-head .tabs .tab[data-view]').length,
    patterns: document.querySelectorAll('#patternButtons button').length,
    overlays: document.querySelectorAll('#overlayButtons button').length
  })`));
  check('three columns and show buttons', shell.cols && shell.show, JSON.stringify(shell));
  check('preview/cabling tabs', shell.tabs === 2);
  check('17 patterns, 4 overlays', shell.patterns === 17 && shell.overlays === 4, `${shell.patterns}/${shell.overlays}`);

  // Crop X/Y only exist in 1:1 — in a scaled mode there is nothing to crop
  const card = JSON.parse(await evalIn(page, `(function(){
    var c=document.querySelector('#displayList .display-card');
    var fields=function(){ return [...document.querySelectorAll('#displayList .display-card .dctl .field > span')].map(s=>s.textContent).join('|'); };
    var scaled=fields();
    var d=displays[0]; outCfgFor(d.id).mode='1to1'; renderDisplays();
    var pixel=fields();
    outCfgFor(d.id).mode='fit'; renderDisplays();
    return JSON.stringify({ head:!!c.querySelector('.dhead'), start:!!c.querySelector('.dhead button'), scaled:scaled, pixel:pixel });
  })()`));
  check('output card labelled fields', card.head && card.start
    && card.scaled === 'Label|Wall|Scale|Pos X|Pos Y'
    && card.pixel === 'Label|Wall|Scale|Crop X|Crop Y|Pos X|Pos Y',
    `${card.scaled}  /  ${card.pixel}`);

  const seg1 = JSON.parse(await evalIn(page, `(function(){
    var s=document.querySelector('#segmentOutputs select');
    var l=document.querySelector('#segmentOutputs label');
    return JSON.stringify({ label:l.childNodes[0].textContent.trim(), last:s.options[s.options.length-1].value,
      hasDisplay:[...s.options].some(o=>o.value.startsWith('d:')) });
  })()`));
  check('unsplit wall has one Send to output', seg1.label === 'Send to output' && seg1.last === 'new' && seg1.hasDisplay, JSON.stringify(seg1));

  check('DeckLink absent is a normal state',
    (await evalIn(page, `JSON.stringify({ cards: document.querySelectorAll('#decklinkList .display-card').length })`)).includes('"cards":0'));

  // ───────────────────────────────────────────── cabling + processors
  section('cabling and processors');
  const cab = JSON.parse(await evalIn(page, `(function(){
    setView('cabling');
    document.querySelector('#arPattern').value='serp';
    document.querySelector('#arAxis').value='v';
    document.querySelector('#arCorner').value='tl';
    document.querySelector('#arPerRun').value=8;
    applyAutoRoute();
    var rs=curWall().cabling.signal.runs;
    var r=JSON.stringify({ n:rs.length, first:rs[0].path.map(p=>LED_COL_LETTER(p[0])+(p[1]+1)).join(' ') });
    setView('preview');
    return r;
  })()`));
  check('serpentine auto-route', cab.n === 4 && cab.first === 'A1 A2 A3 A4 B4 B3 B2 B1', cab.first);

  const proc = JSON.parse(await evalIn(page, `JSON.stringify({
    n: LED_PROCESSORS.length,
    brands: LED_PROCESSOR_BRANDS().length,
    vx1000: LED_PROCESSOR_BY_ID('novastar-vx1000').pxPerPort,
    m660: LED_PROCESSOR_BY_ID('novastar-mctrl660').ports,
    hvt11: LED_PROCESSOR_BY_ID('dbstar-hvt11').pxPerPort
  })`));
  check('processor database intact', proc.n === 18 && proc.brands === 5 && proc.vx1000 === 650000 && proc.m660 === 4 && proc.hvt11 === 655360, JSON.stringify(proc));

  // ───────────────────────────────────────────── wall split
  section('wall split');
  await evalIn(page, `(function(){
    cfg.walls=[freshWall('w1','MAIN')]; cfg.selectedWall='w1'; cfg.virtualOutputs=[]; cfg.outputs={};
    var w=curWall(); w.defineBy='px'; w.panelW=200; w.panelH=100; w.panelsX=9; w.panelsY=11; w.custom=false;
    w.split={cols:1,rows:2,overlap:0,colPanels:[9],rowPanels:[4,7]};
    resolveWall(w); syncWallInputs(); push(); renderDisplays(); return 1;
  })()`);

  const geo = JSON.parse(await evalIn(page, `(function(){
    var s=LED_WALL_SEGMENTS(curWall());
    return JSON.stringify({ top:s[0].panelsX+'x'+s[0].panelsY+' @'+s[0].x+','+s[0].y+' '+s[0].w+'x'+s[0].h,
                            bot:s[1].panelsX+'x'+s[1].panelsY+' @'+s[1].x+','+s[1].y+' '+s[1].w+'x'+s[1].h });
  })()`));
  check('9x11 wall splits 9x4 over 9x7',
    geo.top === '9x4 @0,0 1800x400' && geo.bot === '9x7 @0,400 1800x700', JSON.stringify(geo));

  const dd = JSON.parse(await evalIn(page, `JSON.stringify({
    n: document.querySelectorAll('#segmentOutputs select').length,
    labels: [...document.querySelectorAll('#segmentOutputs label')].map(l=>l.childNodes[0].textContent.trim())
  })`));
  check('one dropdown per segment, sized', dd.n === 2 && /9×4/.test(dd.labels[0]) && /9×7/.test(dd.labels[1]), JSON.stringify(dd.labels));

  // span boxes
  const boxes = JSON.parse(await evalIn(page, `JSON.stringify({
    n: document.querySelectorAll('#splitRowPanelsBoxes input').length,
    values: [...document.querySelectorAll('#splitRowPanelsBoxes input')].map(i=>i.value),
    noText: !document.querySelector('#splitRowPanels')
  })`));
  check('a numeric box per segment, no comma field', boxes.n === 2 && boxes.values.join('+') === '4+7' && boxes.noText, JSON.stringify(boxes));

  const invalid = JSON.parse(await evalIn(page, `(function(){
    var b=document.querySelectorAll('#splitRowPanelsBoxes input')[0];
    b.value='3'; b.dispatchEvent(new Event('input',{bubbles:true}));
    var r={ msg:document.querySelector('#splitRowPanelsMsg').textContent,
            bad:document.querySelector('#splitRowPanelsMsg').classList.contains('invalid'),
            stored:curWall().split.rowPanels.join(',') };
    b.value='4'; b.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify(r);
  })()`));
  check('invalid span flagged and not applied', invalid.bad && /10 of 11/.test(invalid.msg) && invalid.stored === '4,7', JSON.stringify(invalid));

  // ───────────────────────────────────────────── live outputs
  section('live outputs');
  await evalIn(page, `(function(){
    cfg.pattern.type='gradient'; cfg.pattern.gradMode='gray-v';
    cfg.overlay={type:'none',color:'#3fb950',opacity:70,speed:1,dir:'h'};
    cfg.readout={label:false,dims:false,scrim:true,font:'mono',image:null};
    push();
    var segs=LED_WALL_SEGMENTS(curWall());
    segs.forEach(function(sg,i){ previewWallInWindow(curWall(), i, sg); });
    return 1;
  })()`);
  await sleep(4000);

  list = await targets();
  const outs = list.filter((t) => t.url.includes('output.html'));
  check('two output windows', outs.length === 2, String(outs.length));

  const reads = [];
  for (const o of outs) {
    const p = await connect(o.webSocketDebuggerUrl);
    reads.push({ page: p, data: JSON.parse(await evalIn(p, `(function(){
      renderFrame(window.LED_NOW());
      var src=mySource();
      var c=(typeof virt!=='undefined'&&virt.width)?virt:document.getElementById('view');
      var ctx=c.getContext('2d'), col=Math.floor(c.width/2);
      return JSON.stringify({ seg:myOutputCfg().segment, mode:myOutputCfg().mode,
        src:src.x+','+src.y+' '+src.w+'x'+src.h, size:c.width+'x'+c.height,
        top:ctx.getImageData(col,2,1,1).data[0], bottom:ctx.getImageData(col,c.height-3,1,1).data[0],
        now:window.LED_NOW() });
    })()`)) });
  }
  reads.sort((a, b) => a.data.seg - b.data.seg);
  const [a, b] = reads.map((r) => r.data);
  check('segment windows sized to their feed', a.size === '1800x400' && b.size === '1800x700', `${a.size} / ${b.size}`);
  check('each output frames its own segment', a.src === '0,0 1800x400' && b.src === '0,400 1800x700', `${a.src} | ${b.src}`);
  check('the halves join continuously', Math.abs(a.bottom - b.top) < 6, `seg1 bottom=${a.bottom}, seg2 top=${b.top}`);
  check('outputs share one clock', Math.abs(a.now - b.now) < 150, `${a.now} vs ${b.now}`);

  // scale modes must all honour the segment
  const modes = [];
  for (const mode of ['fit', 'fill', 'stretch', '1to1']) {
    const r = await evalIn(reads[1].page, `(function(){
      cfg.outputs[me.id].mode='${mode}'; rebuildRenderCfg(); renderFrame(window.LED_NOW());
      var s=mySource(); return s.x+','+s.y+' '+s.w+'x'+s.h;
    })()`);
    modes.push(`${mode}=${r}`);
  }
  check('every scale mode frames the segment', modes.every((m) => m.endsWith('0,400 1800x700')), modes.join(' '));

  // animation stays at full rate while unfocused
  const fps = await evalIn(reads[0].page, `new Promise(function(res){
    var n=0,t0=performance.now();
    (function tick(){ n++; if(performance.now()-t0<1500) requestAnimationFrame(tick); else res(n/1.5); })();
  })`);
  check('unfocused output is not throttled', fps >= 50, `${fps.toFixed(1)} fps`);

  // ───────────────────────────────────────────── animation
  section('animation');
  const radar = JSON.parse(await evalIn(page, `(function(){
    var wall={width:1000,height:1000,panelsX:10,panelsY:10,panelW:100,panelH:100,mode:'uniform',defineBy:'px',split:{cols:1,rows:1,overlap:0}};
    function beam(t){
      var c=document.createElement('canvas'); c.width=1000; c.height=1000;
      var ctx=c.getContext('2d');
      window.LED_RENDER_FRAME(ctx,{wall:wall,pattern:{type:'solid',fg:'#fff',bg:'#000'},
        overlay:{type:'radar',color:'#00ff00',opacity:100,speed:1},readout:{label:false,dims:false}}, t);
      var best=-1,bestA=0,lit=0;
      for(var d=0;d<360;d+=2){
        var x=Math.round(500+Math.cos(d*Math.PI/180)*380), y=Math.round(500+Math.sin(d*Math.PI/180)*380);
        var px=ctx.getImageData(x,y,1,1).data;
        if(px[1]>40) lit++;
        if(px[1]>best){best=px[1];bestA=d;}
      }
      return {a:bestA,peak:best,lit:lit};
    }
    var t=window.LED_NOW(), b0=beam(t), b1=beam(t+1000);
    return JSON.stringify({ peak:b0.peak, lit:b0.lit, moved:((b1.a-b0.a)+360)%360 });
  })()`));
  check('radar is a tight sweep at the live clock', radar.peak > 150 && radar.lit < 140, `peak=${radar.peak} arc=${radar.lit}/180`);
  check('radar turns 90° per second', Math.abs(radar.moved - 90) < 12, `${radar.moved}°`);

  const wave = JSON.parse(await evalIn(page, `(function(){
    function pos(width){
      var wall={width:width,height:width/2,panelsX:10,panelsY:5,panelW:width/10,panelH:width/10,mode:'uniform',defineBy:'px',split:{cols:1,rows:1,overlap:0}};
      var c=document.createElement('canvas'); c.width=width; c.height=width/2;
      var ctx=c.getContext('2d');
      window.LED_RENDER_FRAME(ctx,{wall:wall,pattern:{type:'wavesweep',fg:'#fff',bg:'#000',speed:1,dir:'h'},
        overlay:{type:'none'},readout:{label:false,dims:false}}, 3000);
      var row=ctx.getImageData(0,Math.floor(width/4),width,1).data, best=-1,bi=0;
      for(var x=0;x<width;x++) if(row[x*4]>best){best=row[x*4];bi=x;}
      return bi/width;
    }
    return JSON.stringify({ big:pos(1920), small:pos(960) });
  })()`));
  check('wave sweep is scale-independent', Math.abs(wave.big - wave.small) < 0.02,
    `1920=${wave.big.toFixed(3)} 960=${wave.small.toFixed(3)}`);

  // ───────────────────────────────────────────── wall colours
  section('wall colours');
  const wc = JSON.parse(await evalIn(page, `(function(){
    var saved = cfg.wallColorMode;
    var walls = cfg.walls.length;
    var w = cfg.walls[0];
    var same = LED_WALL_PATTERN({...cfg.pattern, type:'grid', fg:'#ffffff'}, w, 'same');
    var per  = LED_WALL_PATTERN({...cfg.pattern, type:'grid', fg:'#ffffff'}, w, 'perWall');
    var bars = {...cfg.pattern, type:'colorbars'};
    var critical = LED_WALL_PATTERN(bars, w, 'perWall') === bars;
    var solid = LED_WALL_PATTERN({...cfg.pattern, type:'solid'}, w, 'perWall');
    cfg.wallColorMode = saved;
    return JSON.stringify({ hasColor:!!w.color, sameFg:same.fg, perFg:per.fg, critical:critical, solidBg:solid.bg });
  })()`));
  check('walls carry an identity colour', wc.hasColor && wc.sameFg === '#ffffff', JSON.stringify(wc));
  check('per-wall mode tints the pattern', wc.perFg !== '#ffffff' && wc.perFg === wc.solidBg, `${wc.perFg}`);
  check('colour-critical patterns are never tinted', wc.critical === true);

  // Panel Map and Checkerboard fill BOTH their colours, so both must be the
  // wall's — a global Panel B made every wall share the same second tile.
  const wc2 = JSON.parse(await evalIn(page, `(function(){
    var saved = { mode: cfg.wallColorMode, type: cfg.pattern.type, sel: cfg.selectedWall };
    cfg.wallColorMode = 'perWall'; cfg.pattern.type = 'panelmap';
    var a = cfg.walls[0], b = freshWall('probe', 'PROBE', null, 1);
    var pa = LED_WALL_PATTERN(cfg.pattern, a, 'perWall');
    var pb = LED_WALL_PATTERN(cfg.pattern, b, 'perWall');
    cfg.selectedWall = a.id; syncPatternUI();
    var lblA = document.querySelector('.param[data-param="panelA"]').childNodes[0].textContent;
    var lblB = document.querySelector('.param[data-param="panelB"]').childNodes[0].textContent;
    var pickerB = document.querySelector('#panelB').value;
    var chk = LED_WALL_PATTERN({...cfg.pattern, type:'checker'}, a, 'perWall');
    var grid = LED_WALL_PATTERN({...cfg.pattern, type:'grid', bg:'#000000'}, a, 'perWall');
    cfg.wallColorMode = saved.mode; cfg.pattern.type = saved.type; cfg.selectedWall = saved.sel;
    syncPatternUI();
    return JSON.stringify({ aB:pa.panelB, bB:pb.panelB, aA:pa.panelA, bA:pb.panelA,
      lblA:lblA, lblB:lblB, pickerB:pickerB, want2:a.color2,
      chkFg:chk.fg, chkBg:chk.bg, c:a.color, c2:a.color2, gridBg:grid.bg });
  })()`));
  check('both Panel Map colours come from the wall',
    wc2.aA !== wc2.bA && wc2.aB !== wc2.bB, `A ${wc2.aA}/${wc2.bA}  B ${wc2.aB}/${wc2.bB}`);
  check('both colour pickers retarget to the selected wall',
    /colour$/.test(wc2.lblA) && /colour 2$/.test(wc2.lblB) && wc2.pickerB === wc2.want2,
    `${wc2.lblA} | ${wc2.lblB} = ${wc2.pickerB}`);
  check('checkerboard carries the pair', wc2.chkFg === wc2.c && wc2.chkBg === wc2.c2,
    `${wc2.chkFg} / ${wc2.chkBg}`);
  check('a plain background stays a background', wc2.gridBg === '#000000', wc2.gridBg);

  // ───────────────────────────────────────────── distortion circles
  section('distortion circles');
  // Measure the arc itself: sample the radius at many angles rather than
  // scanning the horizontal and vertical from centre. Those two rays are
  // exactly where the arc crosses a panel seam and the wall border, and a
  // white circle over a white seam leaves no trace to find — which made the
  // earlier ray version report rx=0, ry=0 and "pass" on 0 === 0.
  await evalIn(page, `window.__circArc = function(o){
    var W=o.W, H=o.H, FW=o.FW||W, FH=o.FH||H;
    function frame(on){
      var wall={id:'m',name:'M',width:W,height:H,mode:'uniform',defineBy:'px',
        panelW:172,panelH:172,panelsX:Math.round(W/172),panelsY:Math.round(H/172)};
      var s=document.createElement('canvas'); s.width=W; s.height=H;
      LED_CREATE_FRAME_RENDERER()(s.getContext('2d'),{wall:wall,
        pattern:{...cfg.pattern,type:o.type||'grid',fg:o.fg||'#ffffff',bg:'#000000',
          size:16,panelA:o.A||'#101010',panelB:o.B||'#303030',circles:on,circleWidth:o.lw||2},
        overlay:{type:'none'},readout:{label:false,dims:false},centerLabel:''},0);
      var out=document.createElement('canvas'); out.width=FW; out.height=FH;
      var c=out.getContext('2d'); c.imageSmoothingEnabled=true;
      c.drawImage(s,0,0,W,H,0,0,FW,FH);
      return c.getImageData(0,0,FW,FH).data;
    }
    var a=frame(false), b=frame(true);
    var cx=FW/2, cy=FH/2, nom=Math.min(FW,FH)/2;
    // A tight band around the expected radius. Open it wider and a hidden arc
    // (where the circle crosses a same-coloured seam, or a white circle sits on
    // a white tile) lets the search run on and lock onto the NEIGHBOURING
    // circle. +/-10% still admits the stretched cases measured here.
    var lo=Math.round(nom*0.9), hi=Math.round(nom*1.1);
    var rs=[], ax=0, ay=0, byAngle={}, hits=[];
    for(var deg=0; deg<360; deg+=2){
      var t=deg*Math.PI/180, ct=Math.cos(t), st=Math.sin(t);
      for(var i=lo;i<=hi;i++){
        var x=Math.round(cx+ct*i), y=Math.round(cy+st*i);
        if(x<0||y<0||x>=FW||y>=FH) break;
        var q=(y*FW+x)*4;
        if(Math.abs(a[q]-b[q])>40 || Math.abs(a[q+1]-b[q+1])>40 || Math.abs(a[q+2]-b[q+2])>40){
          rs.push(i); byAngle[deg]=i; hits.push([ct,st,i]);
          break;
        }
      }
    }
    // opposite pairs should match if the circle is centred
    var offc=0;
    for(var d=0; d<180; d+=2){
      if(byAngle[d]!=null && byAngle[d+180]!=null) offc=Math.max(offc, Math.abs(byAngle[d]-byAngle[d+180]));
    }
    // Where the circle is invisible (crossing a same-coloured seam, or a white
    // circle on a white tile) the search can run past it and lock onto the
    // NEIGHBOURING circle. Drop samples far from the median: a stretched circle
    // is at most a few percent off, a wrong circle is tens of percent off.
    var sorted=rs.slice().sort(function(p,q){return p-q;});
    var med=sorted[Math.floor(sorted.length/2)];
    var keep=rs.filter(function(v){return Math.abs(v-med)/med <= 0.15;});
    hits.forEach(function(k){
      if(Math.abs(k[2]-med)/med > 0.15) return;
      ax=Math.max(ax, Math.abs(k[0]*k[2])); ay=Math.max(ay, Math.abs(k[1]*k[2]));
    });
    return {n:keep.length, raw:rs.length, rejected:rs.length-keep.length,
      min:Math.min.apply(null,keep), max:Math.max.apply(null,keep),
      ax:Math.round(ax), ay:Math.round(ay), offCentre:offc};
  }; 1`);

  const arc = JSON.parse(await evalIn(page, `JSON.stringify(window.__circArc({W:1720,H:1032}))`));
  check('the arc is found all the way round', arc.n > 150, `${arc.n} of 180 angles sampled`);
  check('the centre circle is geometrically round',
    arc.n > 150 && arc.max - arc.min <= 3, `radius ${arc.min}–${arc.max}px over 360°`);
  check('it is centred', arc.offCentre <= 2, `opposite radii differ by ${arc.offCentre}px`);
  check('it spans the short axis', Math.abs(arc.ay - 516) <= 3, `vertical radius ${arc.ay} of 516`);

  const arcPortrait = JSON.parse(await evalIn(page, `JSON.stringify(window.__circArc({W:1032,H:1720}))`));
  check('round on a portrait wall too',
    arcPortrait.n > 150 && arcPortrait.max - arcPortrait.min <= 3,
    `radius ${arcPortrait.min}–${arcPortrait.max}px`);

  // the whole point: a wall pushed through a frame of the wrong shape
  const arcStretch = JSON.parse(await evalIn(page,
    `JSON.stringify(window.__circArc({W:1720,H:1032,FW:1920,FH:1080}))`));
  const outOfRound = Math.abs(arcStretch.ax / arcStretch.ay - 1) * 100;
  check('a stretched frame reads as an oval', arcStretch.n > 150 && outOfRound > 5,
    `semi-axes ${arcStretch.ax} x ${arcStretch.ay} — ${outOfRound.toFixed(1)}% out of round`);

  const circDefault = JSON.parse(await evalIn(page,
    `JSON.stringify({def: DEFAULTS.pattern.circles === true, param: LED_PATTERNS.grid.params.indexOf('circles') >= 0})`));
  check('off by default, and offered on the Grid pattern',
    circDefault.def === false && circDefault.param === true, JSON.stringify(circDefault));

  const layout = JSON.parse(await evalIn(page, `(function(){
    function lay(W,H){var d=LED_DISTORTION_CIRCLES({width:W,height:H});
      return {n:d.list.length, r:d.list.map(function(c){return c[2];}),
        cx:d.list.map(function(c){return c[0];}), cy:d.list.map(function(c){return c[1];}), lw:d.lw};}
    return JSON.stringify({ref:lay(3840,1080), hd:lay(1720,1032), wide:lay(4128,516),
      sq:lay(1032,1032), port:lay(516,4128), big:lay(8000,4000)});})()`));
  const uniform = (o) => new Set(o.r).size === 1;
  const tangent = (o, axis) => o[axis].every((v, i, a) => i === 0 || Math.abs(a[i] - a[i - 1] - 2 * o.r[0]) < 0.001);

  check('every circle is the same size, on every wall shape',
    [layout.ref, layout.hd, layout.wide, layout.port].every(uniform),
    `radii: ${layout.ref.r[0]}, ${layout.hd.r[0]}, ${layout.wide.r[0]}`);
  check('each circle is as tall as the wall',
    layout.ref.r[0] === 540 && layout.hd.r[0] === 516, `3840x1080 → r=${layout.ref.r[0]}`);
  check('neighbours are tangent — no gap, no overlap',
    tangent(layout.ref, 'cx') && tangent(layout.wide, 'cx') && tangent(layout.port, 'cy'));
  check('the row is centred on the wall',
    layout.ref.cx[0] + layout.ref.cx[layout.ref.n - 1] === 3840
    && layout.hd.cx[0] + layout.hd.cx[layout.hd.n - 1] === 1720);
  check('a 3840x1080 wall matches the reference slate: 5 circles, 1080 apart',
    layout.ref.n === 5 && layout.ref.cx.join() === '-240,840,1920,3000,4080', layout.ref.cx.join(', '));
  check('a square wall gets exactly one', layout.sq.n === 1 && layout.sq.r[0] === 516);
  check('a portrait wall tiles down instead of across',
    layout.port.cx.every((x) => x === 258) && new Set(layout.port.cy).size === layout.port.n,
    `${layout.port.n} circles down the wall`);
  check('a long wall is covered end to end', layout.wide.n >= 8, `8:1 wall = ${layout.wide.n} circles`);
  const thick = JSON.parse(await evalIn(page, `JSON.stringify({
    def: DEFAULTS.pattern.circleWidth,
    one: LED_DISTORTION_CIRCLES({width:1720,height:1032},1).lw,
    six: LED_DISTORTION_CIRCLES({width:1720,height:1032},6).lw,
    lo:  LED_DISTORTION_CIRCLES({width:1720,height:1032},0).lw,
    hi:  LED_DISTORTION_CIRCLES({width:1720,height:1032},99).lw,
    unset: LED_DISTORTION_CIRCLES({width:8000,height:4000}).lw,
    onGrid: LED_PATTERNS.grid.params.indexOf('circleWidth') >= 0,
    onPM: LED_PATTERNS.panelmap.params.indexOf('circleWidth') >= 0 })`));
  check('thickness is exactly what you set', thick.one === 1 && thick.six === 6,
    `1→${thick.one}px, 6→${thick.six}px`);
  check('thickness is clamped to a usable range', thick.lo === 1 && thick.hi === 16,
    `0→${thick.lo}, 99→${thick.hi}`);
  check('thickness no longer scales itself with the wall',
    thick.unset === 2 && thick.def === 2, `8000px wall → ${thick.unset}px`);
  check('the thickness control is offered on both patterns', thick.onGrid && thick.onPM);

  // the slider is meaningless until the circles are on
  const sliderVis = JSON.parse(await evalIn(page, `(function(){
    var saved={type:cfg.pattern.type, on:cfg.pattern.circles};
    cfg.pattern.type='grid'; cfg.pattern.circles=false; syncPatternUI();
    var off=document.querySelector('.param[data-param="circleWidth"]').classList.contains('visible');
    cfg.pattern.circles=true; syncPatternUI();
    var on=document.querySelector('.param[data-param="circleWidth"]').classList.contains('visible');
    cfg.pattern.type=saved.type; cfg.pattern.circles=saved.on; syncPatternUI();
    return JSON.stringify({off:off,on:on});})()`));
  check('the thickness slider appears only when circles are on',
    sliderVis.off === false && sliderVis.on === true, JSON.stringify(sliderVis));

  // no outline: crossing an arc must pass through ONE band, not a sandwich
  const bands = JSON.parse(await evalIn(page, `(function(){
    var W=1720,H=1032;
    var wall={id:'m',name:'M',width:W,height:H,mode:'uniform',defineBy:'px',
      panelW:172,panelH:172,panelsX:10,panelsY:6};
    function frame(on,lwSet){
      var s=document.createElement('canvas'); s.width=W; s.height=H;
      LED_CREATE_FRAME_RENDERER()(s.getContext('2d'),{wall:wall,
        pattern:{...cfg.pattern,type:'grid',bg:'#000000',fg:'#ffffff',size:16,circles:on,circleWidth:lwSet},
        overlay:{type:'none'},readout:{label:false,dims:false},centerLabel:''},0);
      return s.getContext('2d').getImageData(0,0,W,H).data;
    }
    // diff isolates the stroke; walk out at 45 degrees, perpendicular to the
    // arc there and clear of the tangent points where two strokes coincide
    function runs(lwSet){
      var a=frame(false,lwSet), b=frame(true,lwSet), out=[], cur=0, k=Math.SQRT1_2;
      for(var i=1;i<700;i++){
        var x=Math.round(860+i*k), y=Math.round(516-i*k);
        if(x<0||y<0||x>=W||y>=H) break;
        var o=(y*W+x)*4;
        if(Math.abs(a[o]-b[o])>40) cur++; else if(cur){out.push(cur); cur=0;}
      }
      if(cur) out.push(cur);
      return out;
    }
    return JSON.stringify({thin:runs(1), thick:runs(8)});})()`));
  check('the circle is a single line, not an outlined band',
    bands.thin.length === 1 && bands.thick.length === 1, JSON.stringify(bands));
  check('the line measures what was asked for',
    bands.thin[0] <= 3 && bands.thick[0] >= 6 && bands.thick[0] <= 11,
    `1px set → ${bands.thin[0]}px, 8px set → ${bands.thick[0]}px`);

  // Panel Map: two alternating tile colours underneath, and coordinates that
  // must survive the circle crossing them.
  const pmOffered = JSON.parse(await evalIn(page,
    `JSON.stringify(LED_PATTERNS.panelmap.params.indexOf('circles') >= 0)`));
  check('offered on Panel Map too', pmOffered === true);

  const pmArc = JSON.parse(await evalIn(page,
    `JSON.stringify(window.__circArc({W:1720,H:1032,type:'panelmap'}))`));
  check('round over the panel tiles', pmArc.n > 150 && pmArc.max - pmArc.min <= 5,
    `radius ${pmArc.min}–${pmArc.max}px over ${pmArc.n} angles`);

  // The honest limit of dropping the outline: the circle is drawn in the
  // pattern's foreground colour and nothing else, so on a Black / White panel
  // pair it shows on the black tiles and vanishes on the white ones — exactly
  // as the white seam lines already do. Documented here rather than papered
  // over; picking a foreground colour that contrasts both tiles fixes it.
  const pmBW = JSON.parse(await evalIn(page,
    `JSON.stringify(window.__circArc({W:1720,H:1032,type:'panelmap',A:'#000000',B:'#ffffff'}))`));
  check('on a Black / White pair the circle shows on the dark tiles only',
    pmBW.raw > 40 && pmBW.raw < pmArc.raw * 0.85,
    `${pmBW.raw} of 180 angles visible, against ${pmArc.raw} on the grey pair`);
  const pmRed = JSON.parse(await evalIn(page,
    `JSON.stringify(window.__circArc({W:1720,H:1032,type:'panelmap',A:'#000000',B:'#ffffff',fg:'#ff0000'}))`));
  check('a contrasting foreground restores it across both tiles, and it is round',
    pmRed.raw > pmBW.raw * 1.5 && pmRed.max - pmRed.min <= 5,
    `${pmRed.raw} angles visible, radius ${pmRed.min}–${pmRed.max}px`);

  const labelsIntact = JSON.parse(await evalIn(page, `(function(){
    function px(on){
      var W=1720,H=1032;
      var wall={id:'m',name:'M',width:W,height:H,mode:'uniform',defineBy:'px',
        panelW:172,panelH:172,panelsX:10,panelsY:6};
      var s=document.createElement('canvas'); s.width=W; s.height=H;
      LED_CREATE_FRAME_RENDERER()(s.getContext('2d'),{wall:wall,
        pattern:{...cfg.pattern,type:'panelmap',fg:'#ff0000',panelA:'#101010',panelB:'#303030',circles:on},
        overlay:{type:'none'},readout:{label:false,dims:false},centerLabel:''},0);
      return s.getContext('2d').getImageData(0,0,W,H).data;
    }
    // Find the panel label an arc actually passes through — with the circles
    // tiled, a fixed panel may sit nowhere near one and the check would pass
    // while proving nothing.
    // Count the pixels the GLYPH lit, then how many go dark once circles are
    // on. Drawing circles UNDER the text costs only anti-aliased edge pixels
    // (the glyph edge now blends against the circle instead of the tile);
    // drawing them OVER it punches the stroke straight through. The on-top
    // case is rendered here so the threshold is calibrated, not guessed.
    var W=1720,H=1032;
    var a=px(false), b=px(true);
    var over=(function(){
      var wall={id:'m',name:'M',width:W,height:H,mode:'uniform',defineBy:'px',
        panelW:172,panelH:172,panelsX:10,panelsY:6};
      var s=document.createElement('canvas'); s.width=W; s.height=H;
      var c=s.getContext('2d');
      LED_CREATE_FRAME_RENDERER()(c,{wall:wall,
        pattern:{...cfg.pattern,type:'panelmap',fg:'#ff0000',panelA:'#101010',panelB:'#303030',circles:false},
        overlay:{type:'none'},readout:{label:false,dims:false},centerLabel:''},0);
      var dc=LED_DISTORTION_CIRCLES(wall, cfg.pattern.circleWidth);
      c.strokeStyle='#ff0000'; c.lineWidth=dc.lw; c.lineJoin='round';
      dc.list.forEach(function(k){c.beginPath();c.arc(k[0],k[1],k[2],0,Math.PI*2);c.stroke();});
      return c.getImageData(0,0,W,H).data;
    })();
    var best=null, dc2=LED_DISTORTION_CIRCLES({width:W,height:H});
    for(var pr=0;pr<6;pr++) for(var pc=0;pc<10;pc++){
      var lx=172*pc+86, ly=172*pr+86;
      dc2.list.forEach(function(k){
        var d=Math.abs(Math.hypot(lx-k[0],ly-k[1])-k[2]);
        if(!best||d<best.d) best={d:d,x:lx,y:ly};
      });
    }
    var glyph=0, lost=0, lostIfOnTop=0;
    for(var y=best.y-45;y<best.y+45;y++) for(var x=best.x-60;x<best.x+60;x++){
      var o=(y*W+x)*4;
      // green channel: the coordinate glyph is white, the circle is red, so a
      // glyph pixel the circle painted over drops from 255 to 0 here
      if(a[o+1]>200){ glyph++; if(b[o+1]<=200) lost++; if(over[o+1]<=200) lostIfOnTop++; }
    }
    return JSON.stringify({glyph:glyph, lost:lost, lostIfOnTop:lostIfOnTop,
      panel:Math.round(best.x)+','+Math.round(best.y), arcDist:Math.round(best.d)});})()`));
  check('panel coordinates survive the circle crossing them',
    labelsIntact.glyph > 500 && labelsIntact.lost / labelsIntact.glyph < 0.01
      && labelsIntact.lostIfOnTop > labelsIntact.lost * 20,
    `label at ${labelsIntact.panel} (${labelsIntact.arcDist}px from an arc): ${labelsIntact.glyph} glyph px, `
    + `${labelsIntact.lost} lost — ${labelsIntact.lostIfOnTop} would be lost if drawn on top`);

  // ───────────────────────────────────────────── loop export
  section('loop export');
  const periods = JSON.parse(await evalIn(page, `(function(){
    var w=curWall();
    function per(pat,spd,ov,ovs){
      return LED_LOOP_PERIOD({wall:w, pattern:{...cfg.pattern,type:pat,speed:spd},
        overlay: ov?{type:ov,speed:ovs||1}:{type:'none'}});
    }
    return JSON.stringify({
      radar: per('solid',1,'radar',1),
      radar2: per('solid',1,'radar',2),
      combined: per('colorcycle',1,'radar',1),
      motion: per('motion',1),
      static: per('grid',1)
    });
  })()`));
  check('radar loops in 4s, halving at speed 2',
    periods.radar.ms === 4000 && periods.radar.exact && periods.radar2.ms === 2000, JSON.stringify(periods.radar));
  check('layers combine to a common multiple', periods.combined.ms === 8000 && periods.combined.exact, JSON.stringify(periods.combined));
  check('unloopable and static patterns are reported honestly',
    periods.motion.exact === false && periods.static.animated === false,
    `motion=${JSON.stringify(periods.motion)} static=${JSON.stringify(periods.static)}`);

  // the property the whole feature rests on: one frame past the end is the start
  const seam = JSON.parse(await evalIn(page, `(function(){
    var w=curWall();
    var pat={...cfg.pattern,type:'solid',bg:'#000000'};
    var ov={type:'radar',speed:1,color:'#00ff00',opacity:100,dir:'h'};
    var per=LED_LOOP_PERIOD({wall:w,pattern:pat,overlay:ov});
    var frames=Math.round(per.ms/1000*60), step=per.ms/frames;
    function sig(t){
      var c=document.createElement('canvas'); c.width=w.width; c.height=w.height;
      var ctx=c.getContext('2d');
      LED_RENDER_FRAME(ctx,{wall:w,pattern:pat,overlay:ov,readout:{label:false,dims:false}},t);
      var d=ctx.getImageData(0,0,c.width,c.height).data,s=0;
      for(var i=0;i<d.length;i+=997) s+=d[i+1];
      return s;
    }
    return JSON.stringify({ frames:frames, first:sig(0), wrap:sig(frames*step), last:sig((frames-1)*step) });
  })()`));
  check('the frame after the last is exactly the first', seam.first === seam.wrap, `first=${seam.first} wrap=${seam.wrap}`);
  check('the last frame is not a duplicate of the first', seam.last !== seam.first, `last=${seam.last}`);

  const caps = JSON.parse(await evalIn(page, `window.ledwall.exportCapabilities().then(c=>JSON.stringify(c))`));
  check('encoder capability is probed', typeof caps.ffmpeg === 'boolean', `ffmpeg=${caps.ffmpeg}`);

  // frames really reach disk
  const wrote = JSON.parse(await evalIn(page, `(async function(){
    var w=curWall();
    var b=await window.ledwall.exportBegin('/private/tmp/lattice-suite-export/x.mp4');
    if(!b.ok) return JSON.stringify({ok:false,error:b.error});
    var c=document.createElement('canvas'); c.width=w.width; c.height=w.height;
    var ctx=c.getContext('2d');
    LED_RENDER_FRAME(ctx,{wall:w,pattern:cfg.pattern,overlay:{type:'none'},readout:{label:false,dims:false}},0);
    var r=await window.ledwall.exportFrame(b.dir,0,c.toDataURL('image/png'));
    var cleanup=await window.ledwall.exportCleanup(b.dir,false);
    return JSON.stringify({ok:r.ok && cleanup.ok, dir:b.dir});
  })()`));
  check('frames write to disk and clean up', wrote.ok, wrote.dir || wrote.error);

  // ───────────────────────────────────────────── several walls per output
  section('several walls per output');
  // this section replaces the whole config, so hand back what it found
  const cfgBefore = await evalIn(page, `JSON.stringify(cfg)`);
  await evalIn(page, `(function(){
    cfg=normalizeConfig(JSON.parse(JSON.stringify(DEFAULTS)));
    cfg.walls[0].name='SL TORM'; addWall(); cfg.walls[1].name='HEADER'; addWall(); cfg.walls[2].name='SR TORM';
    var dims=[[344,688],[1376,172],[344,688]];
    cfg.walls.forEach(function(w,i){ w.mode='uniform'; w.defineBy='px'; w.panelW=172; w.panelH=172;
      w.panelsX=dims[i][0]/172; w.panelsY=dims[i][1]/172; w.width=dims[i][0]; w.height=dims[i][1]; });
    cfg.walls[0].color='#ff0000'; cfg.walls[1].color='#00ff00'; cfg.walls[2].color='#0000ff';
    cfg.wallColorMode='perWall'; cfg.pattern.type='solid';
    cfg.readout.label=false; cfg.readout.dims=false;
    cfg.virtualOutputs=[{id:'vP',width:1920,height:1080}];
    cfg.outputs={}; renderDisplays(); push(); return 1;})()`);

  const enter = JSON.parse(await evalIn(page, `(function(){
    var sel=[...document.querySelectorAll('#virtualList select')].find(function(s){
      return [...s.options].some(function(o){return o.value==='__multi__';});});
    sel.value='__multi__'; sel.dispatchEvent(new Event('change'));
    var oc=cfg.outputs['vP'];
    return JSON.stringify({multi:!!oc.multi, n:oc.walls.length, map:!!document.querySelector('.wmap')});})()`));
  check('the Wall dropdown turns an output into a canvas',
    enter.multi && enter.n === 1 && enter.map, JSON.stringify(enter));

  const add3 = JSON.parse(await evalIn(page, `(function(){
    var add=[...document.querySelectorAll('#virtualList .btn.small')]
      .find(function(b){return b.textContent==='+ Wall';});
    add.click(); add.click();
    var oc=cfg.outputs['vP'], list=LED_PLACED_WALLS(oc,cfg.walls);
    var iss=LED_PLACEMENT_ISSUES(list,1920,1080);
    return JSON.stringify({n:oc.walls.length, overlaps:iss.overlaps.length, outside:iss.outside.length,
      pos:list.map(function(p){return p.wall.name+'@'+p.x+','+p.y;})});})()`));
  check('each added wall lands in a free gap, never on top of another',
    add3.n === 3 && add3.overlaps === 0 && add3.outside === 0, add3.pos.join('  '));

  const faults = JSON.parse(await evalIn(page, `(function(){
    var oc=cfg.outputs['vP'];
    oc.walls[1].x=oc.walls[0].x; oc.walls[1].y=oc.walls[0].y; renderDisplays();
    var over=document.querySelector('.wmap-warn').textContent;
    oc.walls[1].x=1900; oc.walls[1].y=0; renderDisplays();
    var out=document.querySelector('.wmap-warn').textContent;
    return JSON.stringify({over:over, out:out});})()`));
  check('double-fed pixels are named, not silently accepted', /overlaps/.test(faults.over), faults.over);
  check('a wall hanging off the frame is named', /outside the 1920 x 1080 frame/.test(faults.out), faults.out);

  const repaired = JSON.parse(await evalIn(page, `(function(){
    [...document.querySelectorAll('#virtualList .btn.small')]
      .find(function(b){return b.textContent==='Auto-arrange';}).click();
    var list=LED_PLACED_WALLS(cfg.outputs['vP'],cfg.walls);
    var iss=LED_PLACEMENT_ISSUES(list,1920,1080);
    return JSON.stringify({overlaps:iss.overlaps.length, outside:iss.outside.length});})()`));
  check('Auto-arrange repairs a broken layout',
    repaired.overlaps === 0 && repaired.outside === 0, JSON.stringify(repaired));

  const dragSnap = JSON.parse(await evalIn(page, `(function(){
    var oc=cfg.outputs['vP'];
    oc.walls=[{wallId:cfg.walls[0].id,x:0,y:0},{wallId:cfg.walls[1].id,x:700,y:600},
              {wallId:cfg.walls[2].id,x:1576,y:392}];
    renderDisplays();
    var cv=document.querySelector('.wmap'), r=cv.getBoundingClientRect(), sc=r.width/1920;
    function at(px,py){return {clientX:r.left+px*sc, clientY:r.top+py*sc, bubbles:true};}
    cv.dispatchEvent(new MouseEvent('mousedown', at(710,610)));
    window.dispatchEvent(new MouseEvent('mousemove', at(360,610)));
    window.dispatchEvent(new MouseEvent('mouseup', at(360,610)));
    var snapped={x:oc.walls[1].x,y:oc.walls[1].y};
    cv.dispatchEvent(new MouseEvent('mousedown', at(oc.walls[1].x+20,oc.walls[1].y+20)));
    window.dispatchEvent(new MouseEvent('mousemove', at(3000,2000)));
    window.dispatchEvent(new MouseEvent('mouseup', at(3000,2000)));
    return JSON.stringify({snapped:snapped, clamped:{x:oc.walls[1].x,y:oc.walls[1].y}});})()`));
  check('dragging snaps flush to a neighbour', dragSnap.snapped.x === 344,
    `landed at x=${dragSnap.snapped.x}, neighbour ends at 344`);
  check('a wall cannot be dragged out of the frame',
    dragSnap.clamped.x === 1920 - 1376 && dragSnap.clamped.y === 1080 - 172, JSON.stringify(dragSnap.clamped));

  // the placements have to mean something at the far end
  await evalIn(page, `(function(){
    cfg.outputs['vP'].walls=[{wallId:cfg.walls[0].id,x:0,y:0},
      {wallId:cfg.walls[1].id,x:400,y:0},{wallId:cfg.walls[2].id,x:1576,y:392}];
    push(); return 1;})()`);
  await evalIn(page, `window.ledwall.startOutput('vP',{width:1920,height:1080,label:'PROC'})`);
  await sleep(2600);
  const outTab = (await targets()).find((t) => t.url.includes('output.html'));
  let composited = { frame: 'none', n: 0 };
  if (outTab) {
    const outPage = await connect(outTab.webSocketDebuggerUrl);
    await sleep(700);
    composited = JSON.parse(await evalIn(outPage, `(function(){
      var g=wall.getContext('2d');
      function px(x,y){var d=g.getImageData(x,y,1,1).data; return [d[0],d[1],d[2]];}
      function near(p,c){return Math.abs(p[0]-c[0])<40&&Math.abs(p[1]-c[1])<40&&Math.abs(p[2]-c[2])<40;}
      return JSON.stringify({
        frame: wall.width+'x'+wall.height, n: multiCfg ? multiCfg.length : 0,
        sl: near(px(10,10),[255,0,0]),
        slEdge: near(px(340,600),[255,0,0]) && near(px(350,600),[0,0,0]),
        header: near(px(410,80),[0,255,0]),
        headerEdge: near(px(410,165),[0,255,0]) && near(px(410,180),[0,0,0]),
        sr: near(px(1590,400),[0,0,255]), empty: near(px(1200,900),[0,0,0]) });})()`));
  }
  check('the live output composites every wall at the full frame size',
    composited.frame === '1920x1080' && composited.n === 3, `${composited.frame}, ${composited.n} walls`);
  check('each wall lands on the exact pixel it was placed on',
    composited.sl && composited.header && composited.sr, JSON.stringify(composited));
  check('each keeps its own size, and unused frame stays black',
    composited.slEdge && composited.headerEdge && composited.empty, JSON.stringify(composited));
  await evalIn(page, `window.ledwall.stopOutput('vP')`);

  const packSave = JSON.parse(await evalIn(page, `(function(){
    var back=normalizeConfig(JSON.parse(JSON.stringify({latticeShow:1,cfg:cfg})).cfg);
    var oc=back.outputs['vP'];
    var gone=JSON.parse(JSON.stringify(cfg)); gone.walls=gone.walls.slice(0,2);
    var pruned=normalizeConfig(gone);
    var emptied=JSON.parse(JSON.stringify(cfg)); emptied.outputs['vP'].walls=[];
    return JSON.stringify({n:oc.walls.length, first:oc.walls[0].x+','+oc.walls[0].y,
      pruned:pruned.outputs['vP'].walls.length, emptyMulti:!!normalizeConfig(emptied).outputs['vP'].multi});})()`));
  check('placements survive a show file', packSave.n === 3 && packSave.first === '0,0', JSON.stringify(packSave));
  check('deleting a wall drops its placement, and an emptied output reverts to single-wall',
    packSave.pruned === 2 && packSave.emptyMulti === false, JSON.stringify(packSave));

  await evalIn(page, `(function(){
    cfg = normalizeConfig(JSON.parse(${JSON.stringify(cfgBefore)}));
    renderDisplays(); syncWallInputs(); syncPatternUI(); push(); return 1;})()`);

  // ───────────────────────────────────────────── persistence
  section('show files');
  const rt = JSON.parse(await evalIn(page, `(function(){
    // give this wall cabling of its own — the split section replaced the wall
    // the cabling section had routed
    setView('cabling');
    document.querySelector('#arPerRun').value=20; applyAutoRoute();
    setView('preview');
    var payload=JSON.stringify({latticeShow:1,cfg:cfg});
    cfg=normalizeConfig(JSON.parse(payload).cfg);
    var w=cfg.walls[0];
    return JSON.stringify({ name:w.name, res:w.width+'x'+w.height, spans:w.split.rowPanels.join(','),
      runs:w.cabling.signal.runs.length });
  })()`));
  check('show round-trip keeps walls, split and cabling',
    rt.name === 'MAIN' && rt.res === '1800x1100' && rt.spans === '4,7' && rt.runs > 0, JSON.stringify(rt));

  const legacy = JSON.parse(await evalIn(page, `(function(){
    var v14 = normalizeConfig({ walls:[{id:'w1',name:'V14',defineBy:'px',panelW:200,panelH:100,panelsX:9,panelsY:11,
                                        split:{cols:1,rows:2,overlap:0}}], selectedWall:'w1' });
    var pre = normalizeConfig({ walls:[{id:'w1',name:'OLD',panelsX:8,panelsY:4}], selectedWall:'w1' });
    return JSON.stringify({ v14spans:LED_SPLIT_SPANS(v14.walls[0].split.rowPanels,2,11).join(','),
                            preSplit:LED_WALL_IS_SPLIT(pre.walls[0]) });
  })()`));
  check('older show files still load', legacy.v14spans === '6,5' && legacy.preSplit === false, JSON.stringify(legacy));

  await evalIn(page, reset);
  await sleep(800);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE ERROR:', e.message); process.exit(1); });
