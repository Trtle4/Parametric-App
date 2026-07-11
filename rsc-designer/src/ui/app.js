/**
 * Application wiring: view switching, event listeners, readouts.
 * Reads params via inputs.readState() (mm) and passes them down explicitly —
 * no module below ui/ touches the DOM for parameters.
 */
import {fefco201} from '../core/styles/fefco201.js';
import {fromMM, fmtLen} from '../core/units.js';
import * as inputs from './inputs.js';
import {el} from './inputs.js';
import {draw2d, apply2dView, view2d} from '../render/dieline2d.js';
import * as fold from '../render/fold3d.js';
import {buildPallet, showPallet} from '../render/pallet3d.js';
import {downloadDXF} from '../export/dxf.js';

let view = '2d';

/* ---------- refreshers ---------- */
function refresh2d(){
  const s = inputs.readState();
  const g = fefco201(s.params);
  const {w, h, F} = draw2d(el('svg'), g, s.params, s.unit, s.printText);

  // readout (blank size / flap depth / board area)
  const areaU = s.unit === 'mm' ? 'm²' : 'ft²';
  const wq = fromMM(w, s.unit), hq = fromMM(h, s.unit);
  const areaConv = s.unit === 'mm' ? (wq*hq)/1e6 : (wq*hq)/144;
  el('blank').textContent = `${fmtLen(w, s.unit)} × ${fmtLen(h, s.unit)} ${s.unit}`;
  el('flap').textContent  = `${fmtLen(F, s.unit)} ${s.unit}`;
  el('area').textContent  = `${areaConv.toFixed(3)} ${areaU}`;
}

function refresh3d(){
  const s = inputs.readState();
  fold.buildBox(fefco201(s.params), s.printText, s.outerFlaps);
}

function refreshPal(){
  const s = inputs.readState();
  const stats = buildPallet(fefco201(s.params), s.pallet, s.pattern, view === 'pal');
  el('palPat').textContent = stats.perLayer > 0 ? stats.label + (s.pattern === 'interlock' ? ' · interlocked' : '') : 'does not fit';
  el('palCnt').textContent = stats.perLayer > 0 ? `${stats.perLayer} × ${stats.layers}` : '--';
  el('palTot').textContent = stats.total > 0 ? `${stats.total} boxes` : '0';
  el('palCov').textContent = stats.perLayer > 0 ? `${stats.coveragePct}%` : '--';
}

/* ---------- view switching ---------- */
function setView(v){
  view = v;
  el('tab2d').classList.toggle('on', v === '2d');
  el('tab3d').classList.toggle('on', v === '3d');
  el('tabPal').classList.toggle('on', v === 'pal');
  const canvas = v === '3d' || v === 'pal';
  el('svgWrap').style.display   = v === '2d' ? 'flex' : 'none';
  el('cvWrap').style.display    = canvas ? 'block' : 'none';
  el('hud').style.display       = v === '2d' ? 'flex' : 'none';
  el('orbithint').style.display = canvas ? 'block' : 'none';
  if(canvas){
    if(!fold.isInit()) fold.init3d(el('cvWrap'));
    if(v === '3d'){
      showPallet(false);
      fold.startFold();
      refresh3d(); fold.showBox(true);
    }else{
      fold.showBox(false);
      fold.stopFold();
      refreshPal();
    }
    fold.resize3d();
    fold.startLoop();
  }
}

/* ---------- wiring ---------- */
['L', 'W', 'H', 'cal', 'glue', 'slot', 'txt'].forEach(id => {
  el(id).addEventListener('input', () => { refresh2d(); if(view === '3d') refresh3d(); if(view === 'pal') refreshPal(); });
});
['pal', 'palMaxH'].forEach(id => {
  el(id).addEventListener('input', () => { if(view === 'pal') refreshPal(); });
});
el('palPattern').addEventListener('change', () => { if(view === 'pal') refreshPal(); });

el('units').addEventListener('change', () => {
  if(!inputs.switchUnits()) return;
  refresh2d(); if(view === '3d') refresh3d(); if(view === 'pal') refreshPal();
});
el('palUnits').addEventListener('change', () => {
  if(!inputs.switchPalUnits()) return;
  if(view === 'pal') refreshPal();
});

el('tab2d').addEventListener('click', () => setView('2d'));
el('tab3d').addEventListener('click', () => setView('3d'));
el('tabPal').addEventListener('click', () => setView('pal'));
el('btnDXF').addEventListener('click', () => {
  const s = inputs.readState();
  downloadDXF(fefco201(s.params), s.params, s.unit);
});

// 2D zoom & pan
const wrap2 = el('svgWrap');
wrap2.addEventListener('wheel', e => {
  if(view !== '2d') return;
  e.preventDefault();
  view2d.z *= e.deltaY < 0 ? 1.12 : 1/1.12;
  view2d.z = Math.max(1, Math.min(16, view2d.z));
  if(view2d.z === 1){ view2d.panX = 0; view2d.panY = 0; }
  apply2dView(el('svg'));
}, {passive: false});
let p2drag = false, p2x = 0, p2y = 0;
wrap2.addEventListener('pointerdown', e => {
  if(view !== '2d' || view2d.z === 1) return;
  p2drag = true; p2x = e.clientX; p2y = e.clientY;
  wrap2.setPointerCapture(e.pointerId); wrap2.style.cursor = 'grabbing';
});
wrap2.addEventListener('pointermove', e => {
  if(!p2drag) return;
  const r = el('svg').getBoundingClientRect();
  const scale = Math.min(r.width/(view2d.base[2]/view2d.z), r.height/(view2d.base[3]/view2d.z)); // px per svg unit
  view2d.panX -= (e.clientX - p2x)/scale; view2d.panY -= (e.clientY - p2y)/scale;
  p2x = e.clientX; p2y = e.clientY; apply2dView(el('svg'));
});
wrap2.addEventListener('pointerup', () => { p2drag = false; wrap2.style.cursor = ''; });
wrap2.addEventListener('dblclick', () => { if(view !== '2d') return; view2d.z = 1; view2d.panX = 0; view2d.panY = 0; apply2dView(el('svg')); });

el('outer').addEventListener('change', () => {
  if(view !== '3d') return;
  refresh3d();
  fold.startFold(); // replay fold so the new order is visible
});
window.addEventListener('resize', () => { if(view === '3d') fold.resize3d(); });

refresh2d();
