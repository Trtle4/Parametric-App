/**
 * Application wiring: the ACTIVE-LEVEL selector, view switching, event
 * listeners, readouts. There is one source of truth — the project. The rails
 * edit a level of it (inputs.mountLevel); every view (2D/3D/DXF/artwork/
 * readouts) renders that same level's resolved geometry via levelGeometry().
 * No detached style instance, so 2D, 3D, and DXF cannot disagree. Fold
 * builders resolve via the registry-keyed map in render/folds/index.js.
 */
import {styleById} from '../core/styles/index.js';
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
import * as save from './save.js';
import {newProject, levelGeometry, linkFor} from '../core/project.js';

let view = '2d';
let mode3d = 'hier';           // 'fold' | 'hier'
let depth = 'case';            // hierarchy depth: product|wrap|carton|case|pallet
let hierSel = {};              // opened index per tier {case,carton,wrap}

/* ---------- the active level: the ONE thing the rails + 2D/3D/DXF show ----
 * There is no detached style instance any more (Path A is gone). The rails
 * mount a level of the project; 2D/3D/DXF read that same level's resolved
 * geometry via levelGeometry(). Everything below routes through `project`. */
const LEVELS = {
  wrap:   {label: 'Wrap',   styleId: 'flowwrap', geoLevel: 'wrap',
           paramsOf: p => p.primary.wrap.params, optionsOf: p => p.primary.wrap.options,
           lockedOf: p => p.primary.wrap.locked, setLocked: (p, v) => { p.primary.wrap.locked = v; },
           dimsReadOnly: true},   // wrap dims are solved from the collation; locking still lives in Build (Step 5)
  carton: {label: 'Carton', styleId: 'a6120', geoLevel: 'carton',
           paramsOf: p => p.secondary.params, optionsOf: p => p.secondary.options,
           lockedOf: p => linkFor(p, 'secondary').locked, setLocked: (p, v) => { linkFor(p, 'secondary').locked = v; },
           dimsReadOnly: false},
  case:   {label: 'Case',   styleId: 'fefco201', geoLevel: 'case',
           paramsOf: p => p.tertiary.params, optionsOf: p => p.tertiary.options,
           lockedOf: p => linkFor(p, 'tertiary').locked, setLocked: (p, v) => { linkFor(p, 'tertiary').locked = v; },
           dimsReadOnly: false}
};
let activeLevel = 'case';

const selKey = () => build.getSelectedCandidateKey();
/** The resolved Geometry for the active level — the single source shared by
 *  the 2D dieline, the 3D fold, and the DXF export. */
function activeGeometry(){
  return levelGeometry(build.project, LEVELS[activeLevel].geoLevel, build.getRounding(), selKey());
}
function activeStyle(){ return styleById(LEVELS[activeLevel].styleId); }

/* ---------- refreshers: every view renders the ACTIVE LEVEL of the project */
function refresh2d(){
  const u = inputs.getUnit();
  const g = activeGeometry();
  if(!g){
    el('svg').innerHTML = '';
    el('blank').textContent = 'does not fit'; el('area').textContent = '--'; el('styleStats').innerHTML = '';
    return;
  }
  const {w, h} = draw2d(el('svg'), g, u, build.project.printText);
  const areaU = u === 'mm' ? 'm²' : 'ft²';
  const wq = fromMM(w, u), hq = fromMM(h, u);
  const areaConv = u === 'mm' ? (wq*hq)/1e6 : (wq*hq)/144;
  el('blank').textContent = `${fmtLen(w, u)} × ${fmtLen(h, u)} ${u}`;
  el('area').textContent  = `${areaConv.toFixed(3)} ${areaU}`;
  const style = activeStyle();
  el('styleStats').innerHTML = (style.readouts ? style.readouts(g) : []).map(r =>
    `<div class="stat"><span class="lab">${r.label}</span><span class="val">${
      r.len !== undefined ? `${fmtLen(r.len, u)} ${u}` : r.text}</span></div>`
  ).join('');
}

function refresh3d(){
  const g = activeGeometry();
  if(!g) return;
  const lvl = LEVELS[activeLevel];
  fold.buildBox(foldBuilders[lvl.styleId], g, build.project.printText, lvl.optionsOf(build.project));
}

function refreshPal(){
  const g = activeGeometry();
  const p = build.project.pallet;
  if(!g){ ['palPat', 'palCnt', 'palTot', 'palCov'].forEach(id => el(id).textContent = '--'); return; }
  const stats = buildPallet(g, {L: p.L, W: p.W, maxH: p.maxH}, p.pattern, view === 'pal');
  el('palPat').textContent = stats.perLayer > 0 ? stats.label + (p.pattern === 'interlock' ? ' · interlocked' : '') : 'does not fit';
  el('palCnt').textContent = stats.perLayer > 0 ? `${stats.perLayer} × ${stats.layers}` : '--';
  el('palTot').textContent = stats.total > 0 ? `${stats.total} boxes` : '0';
  el('palCov').textContent = stats.perLayer > 0 ? `${stats.coveragePct}%` : '--';
}

function refreshAll(){
  refresh2d();
  if(view === '3d') refresh3d();
  if(view === 'pal') refreshPal();
}

/* ---------- active-level selection + mounting ---------- */
/** Mount the active level into the rails: solved dims show as derived (read-
 *  only intent), the level's own params/options bind live to the project. */
function mountActiveLevel(){
  const lvl = LEVELS[activeLevel], proj = build.project;
  const locked = lvl.lockedOf(proj);
  const g = activeGeometry();
  const effectiveDims = (!locked && g) ? g.inner : null;   // derived dims when solved
  inputs.mountLevel(activeStyle(), lvl.paramsOf(proj), lvl.optionsOf(proj), {
    effectiveDims,
    dimsReadOnly: lvl.dimsReadOnly,
    onInput: ({group}) => {
      // typing a dimension of a solved (rigid) level implicitly locks it, so
      // the chain honours the typed value and 2D/3D/DXF show what was typed
      if(group === 'dims' && !lvl.dimsReadOnly) lvl.setLocked(proj, true);
      onProjectEdited();
    }
  });
}

function setActiveLevel(level){
  activeLevel = level;
  const style = activeStyle();
  el('brandCode').textContent = style.brand.code;
  el('brandName').textContent = style.brand.sub;
  // flexible styles have no die -> no DXF; their deliverables are the film
  // spec + artwork template
  const flex = style.structure === 'flexible';
  el('btnDXF').disabled = flex;
  el('btnDXF').title = flex ? 'No die for a flexible style — export the artwork template instead' : '';
  el('btnArt').style.display = flex ? '' : 'none';
  el('btnSpec').style.display = flex ? '' : 'none';
  if(el('style').value !== level) el('style').value = level;
  mountActiveLevel();
  refreshAll();
}

/** A rail edit already mutated the project in place; re-run the views (each
 *  re-solves the chain via levelGeometry) and schedule an autosave. Does NOT
 *  read the Build DOM — the rails are the writer here, Build's fields are
 *  re-synced from the project when that tab is next shown. */
function onProjectEdited(){
  refreshAll();
  if(view === '3d' && mode3d === 'hier') applyHierarchy(false);
  save.scheduleAutosave(gatherSaveState);
}

/** Assemble the hierarchy bundle by READING the arrangements the chain
 *  already retained on the row (row.geo + row.arr). No re-solving here —
 *  single source of truth with the Build table. */
function hierarchyBundle(){
  const proj = build.project;
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
  const swatches = LEGEND
    .filter(l => bundle.wrapGeo || (l.name !== 'Film' && !l.name.includes('seal')))
    .map(l => `<span class="lg"><span class="sw" style="background:${l.hex}"></span>${l.name}</span>`).join('');
  let readout = '';
  if(depth === 'wrap' && bundle.wrapGeo){
    const inr = bundle.wrapGeo.inner, out = bundle.wrapGeo.outer;   // model dims, mm
    const u = inputs.getUnit(), f = v => fmtLen(v, u);
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
  if(activeStyle().structure === 'flexible') fold.jumpClosed();
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
    // rebuild the Build fields FROM the project (they may be stale relative to
    // rail edits), preserving the picked candidate — never let Build's own
    // recompute read stale DOM back over a value the rails just wrote
    build.refreshPanel();
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
// the #style dropdown is now the ACTIVE-LEVEL selector: which level of the
// project the rails edit and 2D/3D/DXF show. (Step 2 promotes this to an
// always-visible, labelled selector; for Step 1 it reuses this control.)
const levelSel = el('style');
levelSel.innerHTML = Object.entries(LEVELS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
levelSel.value = activeLevel;
levelSel.addEventListener('change', () => setActiveLevel(levelSel.value));

// pallet fields write straight into project.pallet — the single home for
// pallet dims (no more copy into a detached object)
function commitPallet(){
  const {L, W, maxH} = inputs.readPallet();
  build.project.pallet.L = L; build.project.pallet.W = W; build.project.pallet.maxH = maxH;
  build.project.pallet.pattern = el('palPattern').value;
}
/** Write project.pallet back into the pallet rail fields (after a load). */
function writePalletFields(){
  const p = build.project.pallet, pu = inputs.getPalUnit();
  const fmtP = v => pu === 'mm' ? Math.round(v).toString() : (+v.toFixed(3)).toString();
  el('pal').value = `${fmtP(fromMM(p.L, pu))} x ${fmtP(fromMM(p.W, pu))}`;
  el('palMaxH').value = fmtP(fromMM(p.maxH, pu));
  el('palPattern').value = p.pattern;
}
function onPalletEdited(){
  commitPallet();
  if(view === 'pal') refreshPal();
  else if(view === 'build') build.refreshPanel();
  else if(view === '3d' && mode3d === 'hier') applyHierarchy(false);
  save.scheduleAutosave(gatherSaveState);
}
['pal', 'palMaxH'].forEach(id => el(id).addEventListener('input', onPalletEdited));
el('palPattern').addEventListener('change', onPalletEdited);

el('units').addEventListener('change', () => {
  if(!inputs.switchUnits()) return;
  inputs.remount();                         // rail fields re-displayed in the new unit (values live in the project)
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
// DXF/artwork/spec export the ACTIVE LEVEL's resolved geometry — the SAME
// object the 2D dieline and 3D fold render (activeGeometry). This is the fix
// for the worst face of the Path-A bug: the DXF file could differ from what
// was on screen. Now it cannot: one source.
el('btnDXF').addEventListener('click', () => {
  if(activeStyle().structure === 'flexible') return;   // no die, no DXF
  const g = activeGeometry();
  if(!g) return;
  downloadDXF(g, g.inner, inputs.getUnit(), LEVELS[activeLevel].styleId.toUpperCase());
});
el('btnArt').addEventListener('click', () => {
  const g = activeGeometry();
  if(g) downloadArtwork(g, inputs.getUnit());
});
el('btnSpec').addEventListener('click', () => {
  const g = activeGeometry();
  if(!g) return;
  navigator.clipboard.writeText(filmSpecText(g, inputs.getUnit()));
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

/* ---------- save/load: one project document, two storage layers -------- */

/** Everything a save document needs, read live at call time (never a
 *  stale snapshot) — see persistence.js for what "nothing derived" means here. */
function gatherSaveState(){
  return {
    project: build.project, rounding: build.getRounding(),
    selectedCandidate: build.getSelectedCandidateKey(),
    unit: inputs.getUnit(), palUnit: inputs.getPalUnit()
  };
}

/** A dismissible header notice. `actions` (if given) replace the default
 *  single Dismiss button — used for the restore banner's Discard action. */
function showNotice(msg, isWarn, actions){
  const n = el('loadNotice');
  n.className = 'notice' + (isWarn ? ' warn' : '');
  n.innerHTML = '<span class="noticeMsg"></span>';
  n.querySelector('.noticeMsg').textContent = msg;
  const acts = actions || [{label: 'Dismiss', onClick: () => { n.style.display = 'none'; }}];
  for(const a of acts){
    const b = document.createElement('button');
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    n.appendChild(b);
  }
  n.style.display = 'flex';
}

/** Apply a deserialized {project, rounding, selectedCandidate, unit,
 *  palUnit, migrationsRun, defaulted} to the live app: the unit switch
 *  goes through the SAME pathway as the header toggle (so inputs.js's own
 *  fields convert instead of being silently mislabeled), then the Build
 *  chain is replaced wholesale and the panel rebuilt from it. Migration
 *  and defaulted-field reports surface in the UI, not just the console —
 *  a silently defaulted clearance is a wrong case dimension. */
function applyLoadedState(result){
  if(result.unit && result.unit !== inputs.getUnit()){
    el('units').value = result.unit;
    if(inputs.switchUnits()) build.onUnitsChanged(inputs.getUnit());
  }
  if(result.palUnit && result.palUnit !== inputs.getPalUnit()){
    el('palUnits').value = result.palUnit;
    inputs.switchPalUnits();
  }
  build.loadProject({project: result.project, rounding: result.rounding, selectedCandidate: result.selectedCandidate});
  // pallet rail fields reflect the loaded project.pallet; re-mount the active
  // level so the rails show the loaded project, not the pre-load state
  writePalletFields();
  setActiveLevel(activeLevel);
  setView('build');
  const notes = [];
  if(result.migrationsRun && result.migrationsRun.length) notes.push(`Migrated — ${result.migrationsRun.join('; ')}`);
  if(result.defaulted && result.defaulted.length) notes.push(`Missing from file, defaulted: ${result.defaulted.join(', ')}`);
  showNotice(notes.length ? notes.join(' · ') : 'Project loaded.', notes.length > 0);
}

async function loadProjectFromFile(file){
  try{
    const text = await save.readFileAsText(file);
    const result = save.parseProjectFile(text);
    applyLoadedState(result);
  }catch(e){
    showNotice('Could not load that file: ' + (e.message || e), true);
  }
}

el('btnSaveFile').addEventListener('click', () => {
  const name = prompt('Save as (file name):', 'project');
  if(name === null) return;
  save.downloadProjectFile(gatherSaveState(), name);
});
el('btnLoadFile').addEventListener('click', () => el('fileLoadInput').click());
el('fileLoadInput').addEventListener('change', () => {
  const file = el('fileLoadInput').files[0];
  el('fileLoadInput').value = '';   // allow re-selecting the same file later
  if(file) loadProjectFromFile(file);
});
// drag-and-drop a save file anywhere onto the app
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if(file) loadProjectFromFile(file);
});

/* localStorage slots — convenience only; hidden/disabled outright if
   storage isn't available, so the rest of the app is completely unaffected. */
function refreshSlotSelect(){
  const sel = el('slotSel');
  const slots = save.listSlots();
  sel.innerHTML = slots.map(s => `<option value="${s.index}">${s.index}. ${s.name ? s.name : '(empty)'}</option>`).join('');
  el('btnSlotLoad').disabled = !slots[+sel.value - 1] || !slots[+sel.value - 1].name;
}
if(!save.hasStorage){
  el('slotSel').innerHTML = '<option>localStorage unavailable</option>';
  el('slotSel').disabled = true; el('btnSlotSave').disabled = true; el('btnSlotLoad').disabled = true;
}else{
  refreshSlotSelect();
  el('slotSel').addEventListener('change', refreshSlotSelect);
  el('btnSlotSave').addEventListener('click', () => {
    const i = +el('slotSel').value;
    const existing = save.listSlots()[i - 1];
    const name = prompt('Name this slot:', (existing && existing.name) || `Slot ${i}`);
    if(name === null) return;
    save.saveToSlot(i, name, gatherSaveState());
    refreshSlotSelect();
  });
  el('btnSlotLoad').addEventListener('click', () => {
    const i = +el('slotSel').value;
    const result = save.loadFromSlot(i);
    if(!result){ showNotice(`Slot ${i} is empty or unreadable.`, true); return; }
    applyLoadedState(result);
  });
}

// Build view: candidate table + selection -> hierarchy 3D / apply-to-case.
// Only a real row selection (non-null) rebuilds the hierarchy; recompute's
// null callback is ignored to avoid reentrancy. Every recompute (selection
// or not) is a "project changed" signal, so autosave is scheduled here too.
build.initBuild(row => {
  if(row && view === '3d' && mode3d === 'hier') applyHierarchy(false);
  if(view !== 'build') mountActiveLevel();   // a picked candidate changes the resolved dims the rails show
  save.scheduleAutosave(gatherSaveState);
}, inputs.getUnit());

// mount the default active level (case) and its rails — the single source
// every non-Build view now renders. (Replaces applyStyle(styles[0]).)
writePalletFields();
setActiveLevel('case');

// Autosave restore: convenience only. A corrupt/unreadable autosave is
// silently ignored (readAutosave returns null) rather than blocking startup.
(function tryRestoreAutosave(){
  const result = save.readAutosave();
  if(!result) return;
  applyLoadedState(result);
  showNotice('Restored your last session.', false, [{label: 'Discard', onClick: () => {
    // loadProject's own recompute re-arms an autosave (the same "project
    // changed" hook every edit uses) — clear the write AND cancel that
    // freshly-armed timer, or the default project silently reappears as
    // "your last session" a few hundred ms later.
    build.loadProject({project: newProject(), rounding: '1mm', selectedCandidate: null});
    save.clearAutosave();
    save.cancelAutosave();
    setView('2d');
    el('loadNotice').style.display = 'none';
  }}]);
})();

// "View selected as case": selecting a row already commits that candidate to
// the project (the views resolve it via selKey()); this just focuses the case
// dieline. No more pushing dims into a detached style instance.
el('bUse').addEventListener('click', () => {
  if(!build.getSelected()) return;
  setActiveLevel('case');
  setView('2d');
});
