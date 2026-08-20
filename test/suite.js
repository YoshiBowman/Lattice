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
