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
import {buildPallet, showPallet, PALLET_HEIGHT} from '../render/pallet3d.js';
import {showNest, showProduct} from '../render/nest3d.js';
import * as hier from '../render/hierarchy3d.js';
import {LEGEND} from '../render/hierarchy3d.js';
import {downloadDXF} from '../export/dxf.js';
import {downloadArtwork, filmSpecText} from '../export/artwork.js';
import * as build from './build.js';

let view = '2d';
let mode3d = 'hier';           // 'fold' | 'hier'
let depth = 'case';            // hierarchy depth: product|wrap|carton|case|pallet
let hierSel = {};              // opened index per tier {case,carton,wrap}

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
  // flexible styles have no die, so there is no DXF — disabled with the
  // reason, never a silently meaningless file. Their deliverables are the
  // film spec and the artwork template.
  const flex = s.structure === 'flexible';
  el('btnDXF').disabled = flex;
  el('btnDXF').title = flex ? 'No die for a flexible style — export the artwork template instead' : '';
  el('btnArt').style.display = flex ? '' : 'none';
  el('btnSpec').style.display = flex ? '' : 'none';
  inputs.setStyle(s, onParamInput, onParamChange);
  refreshAll();
}
function onParamInput(){ refreshAll(); }
function onParamChange(){ // select params & style options (e.g. outer flaps replay the fold)
  refresh2d();
  if(view === '3d'){ refresh3d(); fold.startFold(); }
  if(view === 'pal') refreshPal();
}

/* ---------- 3D mode: FOLD (blank->box) vs HIERARCHY (the full nest) ------ */
function syncPalletToProject(){
  const s = inputs.readState();
  build.project.pallet = {L: s.pallet.L, W: s.pallet.W, maxH: s.pallet.maxH,
                          baseH: PALLET_HEIGHT, pattern: s.pattern};
}

/** Assemble the hierarchy bundle by READING the arrangements the chain
 *  already retained on the row (row.geo + row.arr). No re-solving here —
 *  single source of truth with the Build table. */
function hierarchyBundle(){
  const proj = build.project;
  syncPalletToProject();                                // pallet from the main rails
  if(build.getRows().length === 0) build.recompute();   // ensure rows exist (not every call: avoids reentrancy)
  const rows = build.getRows();
  // default to the freight-optimal row (max cartons/pallet) so the cascade
  // shows a representative case, not the first enumerated candidate
  const best = rows.reduce((a, b) => (b.cartonsPerPallet > (a ? a.cartonsPerPallet : -1) ? b : a), null);
  const row = build.getSelected() || best;
  if(!row || !row.arr) return null;
  const {cases, cartons, wraps, pieces} = row.arr;
  return {
    caseGeo: row.geo.case,
    cartonGeo: row.geo.carton,
    wrapGeo: row.geo.wrap,
    cases: {placements: cases.placements, count: cases.count, deck: cases.deck},
    cartons: {placements: cartons.placements},
    wraps: pieces ? {
      placements: wraps.placements, envelope: pieces.envelope, pieces: pieces.placements,
      piece: pieces.piece, stackAxis: pieces.stackAxis, seals: pieces.seals,
      nx: pieces.nx, ny: pieces.ny,            // collation grid — used to detect a single round slug
      wrapAxis: pieces.wrapAxis                // resolved 'L'|'W' — the renderer's taper/fin axis
    } : null,
    counts: {
      cases: cases.count, cartonsPerCase: proj.links[0].count,
      wrapsPerCarton: wraps ? wraps.count : 0,
      piecesPerWrap: pieces ? pieces.placements.length : 0
    }
  };
}

// depths reachable given the config (Product/Wrap need a primary/wrap level)
function depthAvailable(bundle, d){
  if(d === 'product' || d === 'wrap') return !!(bundle && bundle.wraps);
  return !!bundle;
}

function hudText(bundle, opened){
  const c = bundle.counts;
  const parts = [];
  if(depth === 'pallet') parts.push(`Pallet: ${c.cases} cases`);
  else if(depth === 'case') parts.push(`Case: ${c.cartonsPerCase} cartons`);
  else if(depth === 'carton') parts.push(`Carton: ${c.wrapsPerCarton} wrap${c.wrapsPerCarton === 1 ? '' : 's'}`);
  else if(depth === 'wrap') parts.push(`Wrap: ${c.piecesPerWrap} pieces`);
  else parts.push('Product: 1 piece');
  const chan = [];
  if(depth === 'pallet') chan.push(`case ${(opened.case ?? 0) + 1} of ${c.cases}`);
  if(depth === 'pallet' || depth === 'case') chan.push(`carton ${(opened.carton ?? 0) + 1} of ${c.cartonsPerCase}`);
  if((depth === 'pallet' || depth === 'case' || depth === 'carton') && c.wrapsPerCarton)
    chan.push(`wrap ${(opened.wrap ?? 0) + 1} of ${c.wrapsPerCarton}`);
  return parts.join(' · ') + (chan.length ? `. Opened: ${chan.join(', ')}` : '');
}

function applyHierarchy(resetCam){
  el('m3fold').classList.remove('on');
  ['product', 'wrap', 'carton', 'case', 'pallet'].forEach(d =>
    el('d_' + d).classList.toggle('on', mode3d === 'hier' && depth === d));
  if(view !== '3d') return;
  fold.stopFold(); fold.showBox(false); showPallet(false); showNest(false); showProduct(false);
  const bundle = hierarchyBundle();
  ['product', 'wrap', 'carton', 'case', 'pallet'].forEach(d =>
    el('d_' + d).disabled = !depthAvailable(bundle, d));
  if(!bundle){ hier.show(false); el('hierHud').style.display = 'none'; el('orbithint').textContent = 'configure a chain in Build first'; return; }
  if(!depthAvailable(bundle, depth)) depth = 'case';
  if(resetCam) fold.setOrbit(0.5, 0.65, 1.35);   // oblique 3/4 view: see the cutaway channel + open top
  const res = hier.buildHierarchy(bundle, depth, hierSel);
  hier.show(true);
  el('orbithint').textContent = 'drag to orbit · scroll to zoom · click a unit to open it';
  el('hierHud').style.display = 'block';
  el('hierHud').textContent = hudText(bundle, res.opened);
  renderLegend(bundle);
}

/** Legend naming every coloured element, plus (at wrap depth) the seal
 *  compensation read straight off the model geometry. */
function renderLegend(bundle){
  const s = inputs.readState();
  const swatches = LEGEND
    .filter(l => bundle.wrapGeo || (l.name !== 'Film' && !l.name.includes('seal')))
    .map(l => `<span class="lg"><span class="sw" style="background:${l.hex}"></span>${l.name}</span>`).join('');
  let readout = '';
  if(depth === 'wrap' && bundle.wrapGeo){
    const inr = bundle.wrapGeo.inner, out = bundle.wrapGeo.outer;   // model dims, mm
    const u = s.unit, f = v => fmtLen(v, u);
    const add = (a, b, note) => `${b - a >= 0 ? '+' : ''}${f(b - a)}${note ? ' ' + note : ''}`;
    const sealsOn = bundle.wraps.seals;
    const hNote = sealsOn.sealType === 'lap' ? '(lap: 0)'
      : sealsOn.finTreatment === 'standing' ? '(standing fin)' : '(folded fin, film gauge)';
    // the end-seal gain lands on whichever axis is the RESOLVED machine
    // direction (L or W, never H) — labeling it unconditionally on L was
    // wrong whenever wrapAxis resolved to W
    const machineAxis = bundle.wraps.wrapAxis;
    const endSealNote = '(2×end seal, machine direction)';
    readout = `<div class="rd">` +
      `Envelope ${f(inr.L)} × ${f(inr.W)} × ${f(inr.H)} ${u}<br>` +
      `Seal add: L ${add(inr.L, out.L, machineAxis === 'L' ? endSealNote : '')} · ` +
      `W ${add(inr.W, out.W, machineAxis === 'W' ? endSealNote : '')} · H ${add(inr.H, out.H, hNote)}<br>` +
      `Wrap outer ${f(out.L)} × ${f(out.W)} × ${f(out.H)} ${u} — grows the carton</div>`;
  }
  el('hierLegend').innerHTML = swatches + readout;
  el('hierLegend').style.display = 'flex';
}

function applyFoldMode(){
  el('m3fold').classList.add('on');
  ['product', 'wrap', 'carton', 'case', 'pallet'].forEach(d => el('d_' + d).classList.remove('on'));
  if(view !== '3d') return;
  hier.show(false); el('hierHud').style.display = 'none'; el('hierLegend').style.display = 'none';
  el('orbithint').textContent = 'drag to orbit · scroll to zoom';
  refresh3d(); fold.showBox(true);
  if(inputs.currentStyle().structure === 'flexible') fold.jumpClosed();
  else fold.startFold();
}

function apply3dMode(){ if(mode3d === 'fold') applyFoldMode(); else applyHierarchy(true); }

/* ---------- view switching ---------- */
function setView(v){
  view = v;
  el('tab2d').classList.toggle('on', v === '2d');
  el('tab3d').classList.toggle('on', v === '3d');
  el('tabPal').classList.toggle('on', v === 'pal');
  el('tabBuild').classList.toggle('on', v === 'build');
  const canvas = v === '3d' || v === 'pal';
  el('svgWrap').style.display   = v === '2d' ? 'flex' : 'none';
  el('cvWrap').style.display    = canvas ? 'block' : 'none';
  el('buildWrap').style.display = v === 'build' ? 'block' : 'none';
  el('hud').style.display       = v === '2d' ? 'flex' : 'none';
  el('orbithint').style.display = canvas ? 'block' : 'none';
  el('mode3d').style.display    = v === '3d' ? 'flex' : 'none';
  el('palletFields').style.display = v === 'pal' ? 'contents' : 'none';
  if(v !== '3d'){ el('hierHud').style.display = 'none'; el('hierLegend').style.display = 'none'; }
  if(v === 'build'){
    syncPalletToProject();
    build.recompute();
  }
  if(canvas){
    if(!fold.isInit()) fold.init3d(el('cvWrap'));
    if(v === '3d'){
      showPallet(false);
      apply3dMode();
    }else{
      fold.showBox(false); showNest(false); showProduct(false); hier.show(false);
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

el('units').addEventListener('change', () => {
  if(!inputs.switchUnits()) return;
  build.onUnitsChanged(inputs.getUnit());   // Build length fields follow the toggle
  refreshAll();
});
el('palUnits').addEventListener('change', () => {
  if(inputs.switchPalUnits() && view === 'pal') refreshPal();
});

el('tab2d').addEventListener('click', () => setView('2d'));
el('tab3d').addEventListener('click', () => setView('3d'));
el('tabPal').addEventListener('click', () => setView('pal'));
el('tabBuild').addEventListener('click', () => setView('build'));
el('m3fold').addEventListener('click', () => { mode3d = 'fold'; apply3dMode(); });
['product', 'wrap', 'carton', 'case', 'pallet'].forEach(d =>
  el('d_' + d).addEventListener('click', () => {
    if(el('d_' + d).disabled) return;
    mode3d = 'hier'; depth = d; hierSel = {};   // fresh depth resets the open channel to defaults
    apply3dMode();
  }));

// click a unit in the hierarchy to open it; the cascade re-opens below it
(function wireHierPick(){
  const canvas = () => fold.getDomElement();
  let downX = 0, downY = 0, moved = false;
  document.addEventListener('pointerdown', e => {
    if(view === '3d' && mode3d === 'hier' && e.target === canvas()){ downX = e.clientX; downY = e.clientY; moved = false; }
  });
  document.addEventListener('pointermove', e => {
    if(Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) moved = true;
  });
  document.addEventListener('pointerup', e => {
    if(view !== '3d' || mode3d !== 'hier' || e.target !== canvas()) return;
    if(moved){
      // orbit ended: recompute the near-corner defaults for the new camera
      // (rebuild once here, NOT every frame). Manual overrides persist.
      applyHierarchy(false);
      return;
    }
    const r = canvas().getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    const hit = hier.pick(nx, ny);
    if(!hit) return;
    // set the picked tier and clear deeper tiers so they default under it
    const order = ['case', 'carton', 'wrap'];
    const at = order.indexOf(hit.tier);
    hierSel[hit.tier] = hit.index;
    for(let i = at + 1; i < order.length; i++) delete hierSel[order[i]];
    applyHierarchy(false);   // keep the camera where the user left it
  });
})();
el('btnDXF').addEventListener('click', () => {
  const s = inputs.readState();
  if(s.style.structure === 'flexible') return;   // no die, no DXF
  downloadDXF(s.style.geometry(s.params), s.params, s.unit, s.style.id.toUpperCase());
});
el('btnArt').addEventListener('click', () => {
  const s = inputs.readState();
  downloadArtwork(s.style.geometry(s.params), s.unit);
});
el('btnSpec').addEventListener('click', () => {
  const s = inputs.readState();
  navigator.clipboard.writeText(filmSpecText(s.style.geometry(s.params), s.unit));
  el('btnSpec').textContent = 'Copied ✓';
  setTimeout(() => el('btnSpec').textContent = 'Copy film spec', 1200);
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

// Build view: candidate table + selection -> hierarchy 3D / apply-to-case.
// Only a real row selection (non-null) rebuilds the hierarchy; recompute's
// null callback is ignored to avoid reentrancy.
build.initBuild(row => { if(row && view === '3d' && mode3d === 'hier') applyHierarchy(false); }, inputs.getUnit());
el('bUse').addEventListener('click', () => {
  const row = build.getSelected();
  if(!row) return;
  el('style').value = 'fefco201';
  applyStyle(styleById('fefco201'));
  inputs.setParamValues(row.caseParams);
  refreshAll();
  setView('2d');
});
// pallet inputs feed the Build chain too
['pal', 'palMaxH'].forEach(id => el(id).addEventListener('input', () => {
  if(view === 'build'){ syncPalletToProject(); build.recompute(); }
}));
el('palPattern').addEventListener('change', () => {
  if(view === 'build'){ syncPalletToProject(); build.recompute(); }
});
