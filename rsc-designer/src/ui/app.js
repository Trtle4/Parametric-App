/**
 * Application wiring: style selection, view switching, event listeners,
 * readouts. Reads params via inputs.readState() (mm) and passes them down
 * explicitly — no module below ui/ touches the DOM for parameters, and no
 * renderer contains style conditionals (fold builders resolve via the
 * registry-keyed map in render/folds/index.js).
 */
import {styles, styleById} from '../core/styles/index.js';
import {fromMM, fmtLen} from '../core/units.js';
import * as inputs from './inputs.js';
import {el} from './inputs.js';
import {draw2d, apply2dView, view2d} from '../render/dieline2d.js';
import * as fold from '../render/fold3d.js';
import {foldBuilders} from '../render/folds/index.js';
import {buildPallet, showPallet} from '../render/pallet3d.js';
import {downloadDXF} from '../export/dxf.js';

let view = '2d';

/* ---------- refreshers ---------- */
function refresh2d(){
  const s = inputs.readState();
  const g = s.style.geometry(s.params);
  const {w, h} = draw2d(el('svg'), g, s.unit, s.printText);

  // readout (blank size / style stats / board area)
  const areaU = s.unit === 'mm' ? 'm²' : 'ft²';
  const wq = fromMM(w, s.unit), hq = fromMM(h, s.unit);
  const areaConv = s.unit === 'mm' ? (wq*hq)/1e6 : (wq*hq)/144;
  el('blank').textContent = `${fmtLen(w, s.unit)} × ${fmtLen(h, s.unit)} ${s.unit}`;
  el('area').textContent  = `${areaConv.toFixed(3)} ${areaU}`;
  el('styleStats').innerHTML = (s.style.readouts ? s.style.readouts(g) : []).map(r =>
    `<div class="stat"><span class="lab">${r.label}</span><span class="val">${
      r.len !== undefined ? `${fmtLen(r.len, s.unit)} ${s.unit}` : r.text}</span></div>`
  ).join('');
}

function refresh3d(){
  const s = inputs.readState();
  fold.buildBox(foldBuilders[s.style.id], s.style.geometry(s.params), s.printText, s.options);
}

function refreshPal(){
  const s = inputs.readState();
  const stats = buildPallet(s.style.geometry(s.params), s.pallet, s.pattern, view === 'pal');
  el('palPat').textContent = stats.perLayer > 0 ? stats.label + (s.pattern === 'interlock' ? ' · interlocked' : '') : 'does not fit';
  el('palCnt').textContent = stats.perLayer > 0 ? `${stats.perLayer} × ${stats.layers}` : '--';
  el('palTot').textContent = stats.total > 0 ? `${stats.total} boxes` : '0';
  el('palCov').textContent = stats.perLayer > 0 ? `${stats.coveragePct}%` : '--';
}

function refreshAll(){
  refresh2d();
  if(view === '3d') refresh3d();
  if(view === 'pal') refreshPal();
}

/* ---------- style switching ---------- */
function applyStyle(s){
  el('brandCode').textContent = s.brand.code;
  el('brandName').textContent = s.brand.sub;
  inputs.setStyle(s, onParamInput, onParamChange);
  refreshAll();
}
function onParamInput(){ refreshAll(); }
function onParamChange(){ // select params & style options (e.g. outer flaps replay the fold)
  refresh2d();
  if(view === '3d'){ refresh3d(); fold.startFold(); }
  if(view === 'pal') refreshPal();
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
const styleSel = el('style');
styleSel.innerHTML = styles.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
styleSel.addEventListener('change', () => applyStyle(styleById(styleSel.value)));

el('txt').addEventListener('input', refreshAll);
['pal', 'palMaxH'].forEach(id => {
  el(id).addEventListener('input', () => { if(view === 'pal') refreshPal(); });
});
el('palPattern').addEventListener('change', () => { if(view === 'pal') refreshPal(); });

el('units').addEventListener('change', () => { if(inputs.switchUnits()) refreshAll(); });
el('palUnits').addEventListener('change', () => {
  if(inputs.switchPalUnits() && view === 'pal') refreshPal();
});

el('tab2d').addEventListener('click', () => setView('2d'));
el('tab3d').addEventListener('click', () => setView('3d'));
el('tabPal').addEventListener('click', () => setView('pal'));
el('btnDXF').addEventListener('click', () => {
  const s = inputs.readState();
  downloadDXF(s.style.geometry(s.params), s.params, s.unit, s.style.id.toUpperCase());
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

window.addEventListener('resize', () => { if(view === '3d') fold.resize3d(); });

applyStyle(styles[0]);
