/**
 * Application wiring: the ACTIVE-LEVEL selector, view switching, event
 * listeners, readouts. There is one source of truth — the project. The rails
 * edit a level of it (inputs.mountLevel); every view (2D/3D/DXF/artwork/
 * readouts) renders that same level's resolved geometry via levelGeometry().
 * No detached style instance, so 2D, 3D, and DXF cannot disagree. Fold
 * builders resolve via the registry-keyed map in render/folds/index.js.
 */
import {styles, styleById} from '../core/styles/index.js';
import {finGainAxis} from '../core/styles/flowwrap.js';
import {fromMM, fmtLen} from '../core/units.js';
import * as inputs from './inputs.js';
import {el} from './inputs.js';
import {draw2d, apply2dView, view2d} from '../render/dieline2d.js';
import {drawProduct2d, resolveProductPiece} from '../render/product2d.js';
import * as fold from '../render/fold3d.js';
import {dimsSVG, splitHeight} from '../render/dims3d.js';
import {foldBuilders} from '../render/folds/index.js';
import {buildPallet, showPallet, PALLET_HEIGHT} from '../render/pallet3d.js';
import {buildShelf, showShelf} from '../render/shelf3d.js';
import {fitInto, orientDims} from '../core/containment.js';
import {stackAnalysis, boxesAboveBottom, DERATINGS} from '../core/bct.js';
import {showNest, showProduct} from '../render/nest3d.js';
import * as hier from '../render/hierarchy3d.js';
import {LEGEND} from '../render/hierarchy3d.js';
import * as viewcube from '../render/viewcube.js';
import {downloadDXF} from '../export/dxf.js';
import {downloadArtwork, filmSpecText} from '../export/artwork.js';
import {downloadSvgPNG, savePNG} from '../export/png.js';
import * as build from './build.js';
import * as save from './save.js';
import * as notify from './notify.js';
import {newProject, levelGeometry, resolveActiveRow, resolveChainShape, describeChain, linkFor, styleDefaults, styleOptionDefaults} from '../core/project.js';

let view = '2d';
let mode3d = 'hier';           // 'fold' | 'hier'
let hierSel = {};              // opened index per tier {case,carton,wrap}

// Dims overlay: L×W×H callouts on the active component, off by default. Each
// view's refresh caches the subject's OUTER dims (mm, centred on the origin —
// the shared world convention x=L,y=H,z=W); drawDims picks the right one for
// the current view and reprojects it every frame so the numbers track the orbit.
let showDims = false;
const subjectDims = {fold: null, nest: null, pal: null};

// Retail shelf view state — a visualization config, not a design parameter,
// so it lives here (like `view`/`mode3d`), never on the project. Counts are a
// number or 'auto' (fill to the shelf). `front` is which face points at the
// shopper, as an orientation string consumed by fitInto/orientDims (see
// FRONT_PANELS): o[0]=across, o[1]=depth (back-to-front), o[2]=up.
const shelf = {width: 1000, depth: 500, height: 300, facings: 'auto', stack: 'auto', deep: 'auto', front: 'LWH'};
// front-panel choices: which pack FACE points at the shopper. The front face
// is (across × up), so the depth axis is the middle char. Defaults to L×H —
// the carton's printed front panel, upright.
const FRONT_PANELS = [
  {v: 'LWH', label: 'L × H face (upright)'},
  {v: 'WLH', label: 'W × H face (turned)'},
  {v: 'LHW', label: 'L × W face (laid flat)'}
];

/* ---------- the active level: the ONE thing the rails + 2D/3D/DXF show ----
 * There is no detached style instance any more (Path A is gone). The rails
 * mount a level of the project; 2D/3D/DXF read that same level's resolved
 * geometry via levelGeometry(). The active level IS the hierarchy depth —
 * one control, not two — so the selector and the 3D cascade can never point
 * at different levels. `kind` routes the rails: 'style' levels have a style
 * with param descriptors; 'product' is the collation; 'pallet' is the load. */
const LEVELS = {
  product:{label: 'Product', kind: 'product'},
  wrap:   {label: 'Wrap',   kind: 'style', tier: 'primary', geoLevel: 'wrap',
           styleIdOf: p => p.primary.wrap.styleId, setStyleId: (p, id) => { p.primary.wrap.styleId = id; },
           paramsOf: p => p.primary.wrap.params, setParams: (p, o) => { p.primary.wrap.params = o; },
           optionsOf: p => p.primary.wrap.options, setOptions: (p, o) => { p.primary.wrap.options = o; },
           lockedOf: p => p.primary.wrap.locked, setLocked: (p, v) => { p.primary.wrap.locked = v; },
           derivedFrom: p => 'the ' + plainNoun('collation'), fitsOf: row => row.wrapFits,
           enabledOf: p => !!p.primary.wrap},
  carton: {label: 'Carton', kind: 'style', tier: 'secondary', geoLevel: 'carton',
           styleIdOf: p => p.secondary.styleId, setStyleId: (p, id) => { p.secondary.styleId = id; },
           paramsOf: p => p.secondary.params, setParams: (p, o) => { p.secondary.params = o; },
           optionsOf: p => p.secondary.options, setOptions: (p, o) => { p.secondary.options = o; },
           lockedOf: p => linkFor(p, 'secondary').locked, setLocked: (p, v) => { linkFor(p, 'secondary').locked = v; },
           derivedFrom: p => 'the ' + plainNoun(p.primary.wrap ? 'wrap' : 'collation'),
           fitsOf: row => row.secondaryFits,
           enabledOf: p => p.secondary.enabled !== false},
  case:   {label: 'Case',   kind: 'style', tier: 'tertiary', geoLevel: 'case',
           styleIdOf: p => p.tertiary.styleId, setStyleId: (p, id) => { p.tertiary.styleId = id; },
           paramsOf: p => p.tertiary.params, setParams: (p, o) => { p.tertiary.params = o; },
           optionsOf: p => p.tertiary.options, setOptions: (p, o) => { p.tertiary.options = o; },
           lockedOf: p => linkFor(p, 'tertiary').locked, setLocked: (p, v) => { linkFor(p, 'tertiary').locked = v; },
           // re-pointed per the enabled chain (describeChain), never hardcoded
           derivedFrom: p => `the ${plainNoun(describeChain(p).childNoun)}`,
           fitsOf: row => row.tertiaryFits,
           enabledOf: p => p.tertiary.enabled !== false},
  pallet: {label: 'Pallet', kind: 'pallet'}
};
// wrap disables by going null (the pre-existing pattern) rather than an
// `enabled` flag, so there's no styleId to read once disabled — fall back
// to the natural style for THAT tier, for display purposes only; it never
// touches the actual (still-null) state
const DISABLED_STYLE_FALLBACK = {wrap: 'flowwrap', carton: 'a6120', case: 'fefco201'};
const activeStyleId = () => {
  const lvl = LEVELS[activeLevel];
  if(!lvl.enabledOf(build.project)) return DISABLED_STYLE_FALLBACK[activeLevel];
  return lvl.styleIdOf(build.project);
};
const LEVEL_ORDER = ['product', 'wrap', 'carton', 'case', 'pallet'];
let activeLevel = 'case';
const isStyleLevel = () => LEVELS[activeLevel].kind === 'style';

const selKey = () => build.getSelectedCandidateKey();
/** The resolved Geometry for the active level — the single source shared by
 *  the 2D dieline, the 3D fold, and the DXF export. null for product/pallet
 *  (no dieline geometry). */
function activeGeometry(){
  if(!isStyleLevel()) return null;
  return levelGeometry(build.project, LEVELS[activeLevel].geoLevel, build.getRounding(), selKey());
}
function activeStyle(){ return isStyleLevel() ? styleById(activeStyleId()) : null; }
/** The resolved chain row, for the per-level fit flags (wrapFits/
 *  secondaryFits/tertiaryFits) the lock control reads — a level's OWN misfit,
 *  never the chain's combined result. */
function activeRow(){
  if(!isStyleLevel()) return null;
  return resolveActiveRow(build.project, build.getRounding(), selKey());
}

/* ---------- refreshers: every view renders the ACTIVE LEVEL of the project */

/** Mirror the active level's summary readouts into the right-rail readout
 *  (#blank/#area), the canvas title block, and the mobile spec panel — all
 *  from ONE writer (refresh2d), so the three displays can never drift. The
 *  outer-dims text is also fed to the title block/mobile panel here; the
 *  rail keeps its own #styleStats block (set alongside in refresh2d). */
function setSummary(blank, outer, area){
  el('blank').textContent = blank; el('tbBlank').textContent = blank; el('msBlank').textContent = blank;
  el('area').textContent  = area;  el('tbArea').textContent  = area;  el('msArea').textContent  = area;
  el('tbOuter').textContent = outer; el('msOuter').textContent = outer;
}

function refresh2d(){
  const u = inputs.getUnit();
  if(activeLevel === 'product'){
    // the piece alone: a multiview drawing, not a dieline (product2d.js's
    // own doc comment explains why it can't be — no blank/cut/crease/
    // compensation, no Geometry contract). Never the collation/wrap/
    // anything above the piece — those already have a 3D view + fill
    // readout.
    const piece = resolveProductPiece(build.project.primary);
    if(!piece){
      el('svg').innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-3)" font-family="var(--mono)" font-size="14">No piece configured yet</text>`;
    }else{
      drawProduct2d(el('svg'), piece, u);
    }
    setSummary('—', '—', '--'); el('styleStats').innerHTML = '';
    return;
  }
  if(!isStyleLevel()){
    // pallet has no dieline — say so plainly rather than showing a blank
    // or a stale drawing from another level
    el('svg').innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-3)" font-family="var(--mono)" font-size="14">No dieline for the ${LEVELS[activeLevel].label} level — select Wrap, Carton, or Case</text>`;
    setSummary('—', '—', '--'); el('styleStats').innerHTML = '';
    return;
  }
  const g = activeGeometry();
  if(!g){
    el('svg').innerHTML = '';
    setSummary('does not fit', '—', '--'); el('styleStats').innerHTML = '';
    return;
  }
  const {w, h} = draw2d(el('svg'), g, u, build.project.printText);
  const areaU = u === 'mm' ? 'm²' : 'ft²';
  const wq = fromMM(w, u), hq = fromMM(h, u);
  const areaConv = u === 'mm' ? (wq*hq)/1e6 : (wq*hq)/144;
  const outerText = `${fmtLen(g.outer.L, u)} × ${fmtLen(g.outer.W, u)} × ${fmtLen(g.outer.H, u)} ${u}`;
  setSummary(`${fmtLen(w, u)} × ${fmtLen(h, u)} ${u}`, outerText, `${areaConv.toFixed(3)} ${areaU}`);
  const style = activeStyle();
  // every level's outer (formed) dimensions, stated plainly — for the wrap
  // this is the envelope PLUS seals, the number that actually sizes the
  // carton; reading it should never require doing the compensation
  // arithmetic by hand
  const outerStat = `<div class="stat"><span class="lab">Outer dimensions</span><span class="val">${outerText}</span></div>`;
  el('styleStats').innerHTML = outerStat + (style.readouts ? style.readouts(g) : []).map(r =>
    `<div class="stat"><span class="lab">${r.label}</span><span class="val">${
      r.len !== undefined ? `${fmtLen(r.len, u)} ${u}` : r.text}</span></div>`
  ).join('');
}

function refresh3d(){
  const g = activeGeometry();
  if(!g) return;                                  // product/pallet fold nothing — the nest renders them
  const lvl = LEVELS[activeLevel];
  const builder = foldBuilders[activeStyleId()];
  // a style with no registered fold-open animation (e.g. the tray styles,
  // which only ship a 2D dieline + fold-flat 3D geometry today) must never
  // crash the fold view — hide the box rather than call an undefined
  // builder. The hierarchy/cutaway view (mode3d 'hier') is unaffected,
  // since it renders every style's static erected geometry directly, not
  // through foldBuilders.
  if(!builder){ fold.showBox(false); subjectDims.fold = null; return; }
  fold.buildBox(builder, g, build.project.printText, lvl.optionsOf(build.project));
  subjectDims.fold = {L: g.outer.L, W: g.outer.W, H: g.outer.H};
}

/** The pallet-stats readout: the OUTERMOST enabled tier on the pallet — the
 *  case (the shipper) normally, or the carton once the case is disabled —
 *  independent of the active level, the pallet result the chain produced. */
function refreshPal(){
  const p = build.project.pallet;
  // the pallet carries the OUTERMOST enabled tier — the case normally, or the
  // carton once the case is disabled. outerNoun is 'case' or 'carton'.
  const outerNoun = describeChain(build.project).outerNoun;
  // ONE authoritative pallet result: the resolved candidate row's OWN fit —
  // the exact filled-unit count the Build table and the 3D hierarchy already
  // show, read straight off the row. The readout NEVER re-packs the pallet
  // itself: that independent second computation is what silently diverged
  // (it stacked the resolved case at a layer pitch borrowed from an unrelated
  // candidate row, reporting 132 where only 72 physically fit).
  const row = resolveActiveRow(build.project, build.getRounding(), selKey());
  const g = row && row.geo ? row.geo[outerNoun] : null;
  if(!g){
    ['palPat', 'palCnt', 'palTot', 'palCov'].forEach(id => el(id).textContent = '--');
    el('tbPallet').textContent = '—'; el('msPallet').textContent = '—';
    el('palRowLabel').style.display = 'none';
    subjectDims.pal = null;
    clearBCT();
    drawDims();
    return;
  }
  const perLayer = row.casesPerLayer, layers = row.caseLayers, total = row.casesPerPallet;
  const label = row.casesFit ? row.casesFit.label : '';
  el('palPat').textContent = perLayer > 0 ? label + (p.pattern === 'interlock' ? ' · interlocked' : '') : 'does not fit';
  el('palCnt').textContent = perLayer > 0 ? `${perLayer} × ${layers}` : '--';
  el('palTot').textContent = total > 0 ? `${total} ${outerNoun}s` : '0';
  el('palCov').textContent = perLayer > 0 ? `${row.coveragePct}%` : '--';
  const palText = total > 0 ? `${total} ${outerNoun}s` : (perLayer > 0 ? '—' : 'does not fit');
  el('tbPallet').textContent = palText; el('msPallet').textContent = palText;
  // which candidate row every view (2D/3D/DXF/readout) is reflecting (UAT #B2):
  // resolveActiveRow re-derives a fresh row, so locate it in the Build rows by
  // its candidate key rather than by identity.
  const rows = build.getRows();
  const sel = build.getSelectedCandidateKey();
  const sameKey = (a, b) => a && b && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz && a.orientation === b.orientation;
  const idx = rows.findIndex(r => sameKey(r, row));
  const rl = el('palRowLabel');
  if(idx >= 0){
    const basis = sameKey(sel, row) ? 'selected candidate' : 'best cartons/pallet';
    rl.innerHTML = `<span class="rl-eyebrow">showing</span>${basis} · row ${idx + 1} of ${rows.length}` +
      ` &middot; <span class="rl-link">open Build</span>`;
    rl.style.display = 'flex';
  }else{
    rl.style.display = 'none';
  }
  renderBCT(g, {perLayer, layers, total, coveragePct: row.coveragePct});
  // the loaded-pallet Dims box: deck footprint x (pallet deck + case stack),
  // doubled when double-stacked — the same totalH pallet3d centres on the origin.
  // effH is the chain's per-unit stacking pitch (row.unitStackH): for an open
  // tray with proud contents it is the standing-content height.
  const effH = row.unitStackH || g.outer.H;
  const oneLoadH = PALLET_HEIGHT + layers*effH;
  const nLoads = (p.stacking && p.stacking.doubleStack) ? 2 : 1;
  // palletMM flags this as a pallet subject so the Dims overlay splits the
  // height into Pallet (deck) / Load (stack) / Total
  subjectDims.pal = {L: p.L, W: p.W, H: nLoads*oneLoadH, palletMM: PALLET_HEIGHT};
  // the 3D Palletize view renders the SAME placements the chain solved (never a
  // second fitInto), so the boxes on screen match the readout count exactly
  if(view === 'pal') buildPallet(g, {L: p.L, W: p.W, maxH: p.maxH}, row.arr.cases.placements, layers, effH, true, nLoads === 2);
  drawDims();
}

/* ---------- stacking strength (BCT) — engineering guidance, not a guarantee ----
 * The load-bearing bottom box is the CASE (the shipper on the pallet). McKee's
 * ECT short form (core/bct.js) predicts SHORT-TERM lab compression; the safety
 * factor absorbs the field deratings, shown in the "how" panel. Registered via
 * refreshPal (a recompute consumer), so it updates live on every input. */
function clearBCT(){
  ['bctRatio', 'bctVal', 'bctLoad'].forEach(id => el(id).textContent = '--');
  el('bctRatio').style.color = ''; el('bctNote').textContent = ''; el('bctHowBody').innerHTML = '';
}
function renderBCT(g, stats){
  const st = build.project.pallet.stacking || {};
  // the load-bearing bottom box is the OUTERMOST tier on the pallet — the case
  // normally, the carton once the case is disabled (project.tertiary is then
  // off, so reading it would misjudge the style). Identical for the default
  // case-enabled chain, where outerKey is 'tertiary'.
  const isRSC = build.project[describeChain(build.project).outerKey].styleId === 'fefco201';
  const boxesAbove = boxesAboveBottom(stats.layers || 0, !!st.doubleStack);
  const a = stackAnalysis({
    ectLbPerIn: st.ect, caliperMm: g.meta.caliper || 0, L_mm: g.outer.L, W_mm: g.outer.W,
    boxesAbove, unitWeightLb: st.unitWeightLb, targetRatio: st.target, isRSC
  });
  const noLoad = a.ratio === Infinity;
  el('bctRatio').textContent = (noLoad ? '— : 1' : `${a.ratio.toFixed(2)} : 1`) + ` (target ${(+st.target).toFixed(1)})`;
  el('bctRatio').style.color = noLoad ? 'var(--ink-3)' : (a.meetsTarget ? 'var(--valid)' : 'var(--danger)');
  el('bctVal').textContent = `${Math.round(a.bctLb)} lb${a.approximate ? ' · approx' : ''}`;
  el('bctLoad').textContent = `${Math.round(a.loadLb)} lb  (${boxesAbove} box${boxesAbove === 1 ? '' : 'es'} × ${st.unitWeightLb} lb${st.doubleStack ? ', double-stack' : ''})`;
  el('bctNote').innerHTML = (noLoad ? '' : a.meetsTarget ? '' : '<strong>Below target.</strong> ') +
    (a.approximate ? 'Non-RSC style — McKee is a rougher estimate here. ' : '') + 'An estimate, not a guarantee.';
  el('bctNote').style.color = (!noLoad && !a.meetsTarget) ? 'var(--danger)' : 'var(--ink-3)';
  const f2 = v => (+v).toFixed(2);
  el('bctHowBody').innerHTML =
    `<div class="bcteq">BCT = 5.87 × ECT × √(caliper × perimeter)</div>` +
    `<table class="bcttbl">` +
      `<tr><td>ECT</td><td>${st.ect} lb/in</td></tr>` +
      `<tr><td>caliper</td><td>${f2(a.caliperIn)} in</td></tr>` +
      `<tr><td>perimeter 2(L+W)</td><td>${f2(a.perimeterIn)} in</td></tr>` +
      `<tr><td>→ BCT</td><td>${Math.round(a.bctLb)} lb${a.approximate ? ' (approx — non-RSC)' : ''}</td></tr>` +
      `<tr><td>load = boxes × weight</td><td>${boxesAbove} × ${st.unitWeightLb} = ${Math.round(a.loadLb)} lb</td></tr>` +
      `<tr><td>safety = BCT ÷ load</td><td>${noLoad ? '∞' : f2(a.ratio)} : 1 (target ${(+st.target).toFixed(1)})</td></tr>` +
    `</table>` +
    `<div class="bctderate">McKee predicts <em>short-term lab</em> strength. Real field strength is reduced by:` +
      `<ul>${DERATINGS.map(d => `<li>${d}</li>`).join('')}</ul>` +
      `The safety factor is what absorbs these.</div>`;
}

/* ---------- retail shelf fill: fitInto with the shelf as the parent cavity ----
 * The sellable pack is the outermost USER-FACING unit — the carton if there is
 * one, else the case (the shipper). The shelf opening (width × depth × height)
 * is a plain fitInto cavity and the pack outer is the child, fixed to the
 * chosen front-panel orientation. fitInto returns the MAX fill; a user-set
 * facings/stack/deep selects a subset of those SAME placements (kept from the
 * back wall forward), so the count and the render come from one packing result
 * — never a second hand-rolled grid. containment.js is untouched. */

/** The sellable pack noun + its resolved geometry for the current chain. */
function shelfSellable(){
  const proj = build.project;
  const noun = (proj.secondary.enabled !== false) ? 'carton' : 'case';
  const row = resolveActiveRow(proj, build.getRounding(), selKey());
  return {noun, geo: row && row.geo ? row.geo[noun] : null};
}

const shelfKey = v => +v.toFixed(3);   // stable grouping key for placement coords

function refreshShelf(){
  if(view !== 'shelf') return;         // only compute while the shelf view is up
  const {noun, geo} = shelfSellable();
  el('spUnit').textContent = noun + 's';
  if(!geo){
    el('shReadout').innerHTML = 'No sellable pack geometry for this chain.';
    showShelf(false);
    return;
  }
  const cavity = {L: shelf.width, W: shelf.depth, H: shelf.height};
  // fixed to the front-panel orientation — the shopper-facing face is the
  // user's choice, not a solver optimization; 'column' gives a clean aligned
  // grid to subset. x = facings (across), y = depth (back→front), z = stack.
  const arr = fitInto({outer: geo.outer, allowedOrientations: [shelf.front], styleId: geo.meta.style},
                      cavity, {wall: 0, between: 0}, 'column');
  const xs = [...new Set(arr.placements.map(p => shelfKey(p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(arr.placements.map(p => shelfKey(p.y)))].sort((a, b) => a - b);
  const zs = [...new Set(arr.placements.map(p => shelfKey(p.z)))].sort((a, b) => a - b);
  const maxF = xs.length, maxD = ys.length, maxS = zs.length;
  const eff = (v, max) => (v === 'auto' || !(v >= 1)) ? max : Math.min(max, Math.round(v));
  const facings = eff(shelf.facings, maxF), stack = eff(shelf.stack, maxS), deep = eff(shelf.deep, maxD);
  // subset: left-most facings, bottom stack, back-most `deep` rows (largest y —
  // the back wall sits at +depth), i.e. stocked from the back forward.
  const keepX = new Set(xs.slice(0, facings));
  const keepZ = new Set(zs.slice(0, stack));
  const keepY = new Set(ys.slice(ys.length - deep));
  const placements = arr.placements.filter(p =>
    keepX.has(shelfKey(p.x)) && keepZ.has(shelfKey(p.z)) && keepY.has(shelfKey(p.y)));
  const total = facings*stack*deep;

  const od = orientDims(geo.outer, shelf.front);
  const pct = (a, b) => b > 0 ? Math.round(a/b*100) : 0;
  el('shReadout').innerHTML = (maxF && maxD && maxS)
    ? `<b>${total}</b> ${noun}${total === 1 ? '' : 's'} on shelf<br>` +
      `${facings} facings × ${stack} high × ${deep} deep` +
      `<div class="sp-util">uses ${pct(facings*od.l, shelf.width)}% width · ` +
      `${pct(stack*od.h, shelf.height)}% height · ${pct(deep*od.w, shelf.depth)}% depth</div>`
    : `<b>0</b> on shelf<div class="sp-util">the ${noun} does not fit this shelf opening in the chosen orientation</div>`;

  buildShelf(od, shelf, placements, true);
}

/* ---------- active-level selection + mounting ---------- */
/** Show only the rail sections the active level uses. Style + product use the
 *  dim/material field slots; pallet uses its own field block; product/pallet
 *  have no style-view options. */
function toggleRailSections(kind){
  const styleOrProduct = kind === 'style' || kind === 'product';
  el('levelEnable').style.display = (kind === 'style') ? 'contents' : 'none';
  el('levelStyle').style.display = (kind === 'style') ? 'contents' : 'none';
  el('levelLock').style.display = (kind === 'style') ? 'contents' : 'none';
  el('dimFields').style.display = styleOrProduct ? 'contents' : 'none';
  el('matFields').style.display = styleOrProduct ? 'contents' : 'none';
  el('optFields').style.display = (kind === 'style') ? 'contents' : 'none';
  el('palletFields').style.display = (kind === 'pallet') ? 'contents' : 'none';
}

/* ---------- optional levels: enable/disable + the always-visible chain
 * string. secondary(carton)/tertiary(case) carry their own `enabled` flag;
 * wrap's is `primary.wrap !== null` (the existing pattern). A level's actual
 * parent is the next enabled level above it — resolveChainShape in
 * project.js is the single source for that fold; this file only surfaces
 * it (the toggle, the warning, the chain string), never re-derives it. --- */

const TIER_LABEL = {wrap: 'wrap', carton: 'carton', case: 'case'};

function isTierEnabled(level){ return LEVELS[level].enabledOf(build.project); }

/** A fresh default wrap object (mirrors newProject()'s shape) — re-enabling
 *  the wrap tier after it was disabled starts from sane defaults rather
 *  than reading back stale/undefined fields. */
function newDefaultWrap(){
  return {
    styleId: 'flowwrap',
    params: {sealType: 'fin', finHeight: 8, finSealBand: 5, finTreatment: 'folded', finFace: 'bottom',
             lapOverlap: 12, endSealWidth: 10, endSealBleed: 3,
             girthBasis: 'rectangular', roundDiameter: 0, gauge: 30, density: 0.92,
             L: 90, W: 50, H: 120},
    options: styleOptionDefaults('flowwrap'), locked: false   // machine direction fixed at L; no wrapAxis
  };
}

/** What the new pairing will be once `level` is disabled — shown in the
 *  warning so a toggle-off is never silent about what re-points to what. */
function pairingAfterDisabling(level){
  const proj = build.project;
  const contentNoun = plainNoun('collation');
  if(level === 'wrap') return `the ${contentNoun} will feed the ${isTierEnabled('carton') ? 'carton' : 'case'} directly`;
  if(level === 'carton') return `the ${proj.primary.wrap ? 'wrap' : contentNoun} will feed the case directly`;
  if(level === 'case') return 'the carton will ride the pallet directly, with no case';
  return '';
}

function setTierEnabled(level, on){
  const proj = build.project;
  if(level === 'wrap') proj.primary.wrap = on ? newDefaultWrap() : null;
  else if(level === 'carton') proj.secondary.enabled = on;
  else if(level === 'case') proj.tertiary.enabled = on;
  setActiveLevel(activeLevel);   // re-derive brand/rails/views for the new chain shape
  projectChanged();              // the one notify: chain + every registered display, incl. Build/3D-hier
}

/** Disabling is never silent: it shows a loud warning naming the new
 *  pairing and requires a deliberate confirm. Enabling just flips the flag
 *  back (or rebuilds a default wrap) — there's nothing destructive about
 *  restoring a tier. Refuses to leave both carton and case disabled. */
function toggleTier(level){
  if(isTierEnabled(level)){
    if(level === 'carton' && !isTierEnabled('case')){
      showNotice('Can\'t disable the carton — the case is already disabled, and at least one packaging level must stay enabled.', true);
      return;
    }
    if(level === 'case' && !isTierEnabled('carton')){
      showNotice('Can\'t disable the case — the carton is already disabled, and at least one packaging level must stay enabled.', true);
      return;
    }
    showNotice(`Disable the ${TIER_LABEL[level]}? ${pairingAfterDisabling(level)}.`, true, [
      {label: `Disable ${TIER_LABEL[level]}`, onClick: () => { setTierEnabled(level, false); el('loadNotice').style.display = 'none'; }},
      {label: 'Cancel', onClick: () => { el('loadNotice').style.display = 'none'; }}
    ]);
  }else{
    setTierEnabled(level, true);
  }
}

/** The enable/disable control for the active tier (wrap/carton/case).
 *  Content and Pallet are always on — no control needed. */
function mountEnableToggle(){
  const host = el('levelEnable');
  const lvl = LEVELS[activeLevel];
  if(lvl.kind !== 'style'){ host.innerHTML = ''; return; }
  const on = isTierEnabled(activeLevel);
  host.innerHTML =
    `<div class="field"><label>Tier <span class="hint">${on ? 'in the chain' : 'skipped'}</span></label>
      <div class="inp"><button type="button" id="tierToggleBtn" class="btn">${on ? `Disable ${lvl.label.toLowerCase()}` : `Enable ${lvl.label.toLowerCase()}`}</button></div>
    </div>`;
  el('tierToggleBtn').addEventListener('click', () => toggleTier(activeLevel));
}

/** Map internal chain nouns to plain user-facing language (UAT #6): the
 *  model's 'collation' is packaging jargon — show "product" everywhere it
 *  reaches the UI. Code/internal names (collation.js, project.collation) stay. */
function plainNoun(noun){ return noun === 'collation' ? 'product' : noun; }

/** Short style/content label for a chain-strip node. */
function nodeStyleLabel(k){
  const proj = build.project;
  if(k === 'product'){
    const c = proj.primary.collation;
    return `${c.piece.kind === 'cylinder' ? 'cylinders' : 'pieces'} ${c.nx}×${c.ny}`;
  }
  if(k === 'pallet'){
    const u = inputs.getPalUnit();
    return `${Math.round(fromMM(proj.pallet.L, u))}×${Math.round(fromMM(proj.pallet.W, u))} ${u}`;
  }
  if(!isTierEnabled(k)) return '';
  const s = styleById(LEVELS[k].styleIdOf(proj));
  return (s.brand && s.brand.code) ? s.brand.code : s.name;
}

/** Present-tense re-point note for a disabled optional tier — what NOW feeds
 *  the next enabled tier in its place. Rides the chain-strip arrow so the
 *  parent re-point is permanently visible, not a transient toast (UAT #4). */
function repointNote(k){
  const proj = build.project;
  const contentNoun = plainNoun('collation');
  if(k === 'wrap')   return `${contentNoun} feeds ${isTierEnabled('carton') ? 'carton' : 'case'} directly`;
  if(k === 'carton') return `${proj.primary.wrap ? 'wrap' : contentNoun} feeds case directly`;
  if(k === 'case')   return 'carton rides the pallet directly';
  return '';
}

/** The always-visible, interactive chain strip (UAT #4/#5): every level as a
 *  clickable node showing its style; the active level highlighted; disabled
 *  optional tiers struck-through with an enable affordance; and each arrow
 *  after a skipped tier labeled with the re-point. Derived from the enabled
 *  chain, never hardcoded. Registered with recompute() (see notify block). */
const CHAIN_OPTIONAL = {wrap: true, carton: true, case: true};
function renderChainString(){
  const host = el('chainString');
  host.className = 'chainStrip';
  host.innerHTML = '';
  LEVEL_ORDER.forEach((k, i) => {
    const enabled = CHAIN_OPTIONAL[k] ? isTierEnabled(k) : true;
    const node = document.createElement('div');
    node.className = 'cs-node' + (k === activeLevel ? ' active' : '') + (enabled ? '' : ' disabled');
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `${LEVELS[k].label}${enabled ? '' : ' (disabled)'}`);
    const styleLbl = nodeStyleLabel(k);
    node.innerHTML = `<span class="cs-lvl">${LEVELS[k].label}</span>` +
      `<span class="cs-style">${enabled ? styleLbl : 'skipped'}</span>`;
    if(CHAIN_OPTIONAL[k]){
      const tog = document.createElement('button');
      tog.className = 'cs-tog';
      tog.textContent = enabled ? 'in chain' : 'enable';
      tog.title = enabled ? `Disable ${k}` : `Enable ${k}`;
      tog.addEventListener('click', e => { e.stopPropagation(); toggleTier(k); });
      node.appendChild(tog);
    }
    // node body: click to make active (enabled), or to enable it (disabled)
    const activate = () => { enabled ? setActiveLevel(k) : toggleTier(k); };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); activate(); } });
    host.appendChild(node);
    if(i < LEVEL_ORDER.length - 1){
      const arrow = document.createElement('div');
      arrow.className = 'cs-arrow';
      const note = (CHAIN_OPTIONAL[k] && !enabled) ? repointNote(k) : '';
      arrow.innerHTML = `<span class="cs-ar">&#9656;</span>` + (note ? `<span class="cs-repoint">${note}</span>` : '');
      host.appendChild(arrow);
    }
  });
}

/** The lock/unlock control for the active level's dimensions. Solved (the
 *  default) is read-only and marked as derived from the level's own content;
 *  unlocking is the ONE deliberate action that makes dims editable and hands
 *  control to the user — never an implicit side effect of typing. While
 *  locked, the level's content is checked against the typed dims and a
 *  misfit is surfaced here loudly, not hidden in a readout elsewhere. */
function mountLockControl(){
  const host = el('levelLock');
  const lvl = LEVELS[activeLevel], proj = build.project;
  if(lvl.kind !== 'style'){ host.innerHTML = ''; return; }
  if(!lvl.enabledOf(proj)){
    host.innerHTML = `<div class="misfit">This tier is disabled — skipped in the chain. Enable it above to size it.</div>`;
    return;
  }
  const locked = lvl.lockedOf(proj);
  const child = lvl.derivedFrom(proj);
  const row = activeRow();
  const g = row ? row.geo[lvl.geoLevel] : null;
  const misfit = locked && row && lvl.fitsOf(row) === false;
  const noSolution = !locked && !g;
  host.innerHTML =
    `<div class="field lockField">
      <label>Dimensions <span class="hint">${locked ? 'locked — user-set' : `derived — solved from ${child}`}</span></label>
      <div class="inp"><button type="button" id="levelLockBtn" class="btn">${locked ? `Solve from ${child}` : 'Unlock to edit'}</button></div>
    </div>` +
    (misfit ? `<div class="misfit"><strong>Does not fit</strong> — ${child} does not fit within these locked dimensions.</div>` : '') +
    (noSolution ? `<div class="misfit"><strong>No solution</strong> — ${child} doesn't resolve to a fit upstream.</div>` : '');
  el('levelLockBtn').addEventListener('click', () => {
    lvl.setLocked(proj, !locked);
    projectChanged();
    mountActiveLevel();   // re-render the rails: fields flip editable<->read-only, values re-sync
  });
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** The dimension-group label belongs to the STYLE, not the rail: "Inside
 *  dimensions" is right for a rigid box (an RSC, a carton — industry
 *  convention), but wrong for film (a flow wrap has no inside; the L/W/H
 *  are the content envelope). Each style names its own label in the
 *  registry (`dimsLabel`); this only reads it, never hardcodes a default
 *  for a specific style. */
function updateDimsLabel(){
  const lvl = LEVELS[activeLevel];
  const fallback = lvl.kind === 'product' ? 'Content' : lvl.kind === 'pallet' ? 'Pallet' : 'Dimensions';
  el('dimsLabel').textContent = lvl.kind === 'style' && lvl.enabledOf(build.project)
    ? (activeStyle().dimsLabel || 'Dimensions') : fallback;
}

/** The 2D tab's own label — "2D Dieline" is right for a rigid box, wrong
 *  for a flow wrap's flat blank (there's no die to speak of) and wrong for
 *  the product level (a multiview drawing, not a cut file at all). Same
 *  precedent as updateDimsLabel: read what the level/style actually is,
 *  never hardcode one word for every kind. Pallet keeps the original text
 *  — it has no 2D view of its own and that isn't changing here. */
function update2dTabLabel(){
  const lvl = LEVELS[activeLevel];
  const word = lvl.kind === 'product' ? 'Drawing'
    : lvl.kind === 'style' ? (activeStyle().structure === 'flexible' ? 'Blank' : 'Dieline')
    : 'Dieline';
  el('tab2d').textContent = `2D ${word}`;
}

/** Orientation + clearance + count/arrangement — Step 5 moved these off
 *  Build's now-removed editing fieldsets and onto whichever rail actually
 *  owns them. "What's inside" always describes the level's actual child,
 *  re-pointed exactly like resolveChainShape/describeChain: the case's
 *  shows the carton's own settings when the carton is enabled, or the
 *  wrap/box/collation's directly once the carton's been skipped. A wrap
 *  has no child count of its own (it always wraps exactly one collation),
 *  so the Wrap rail mounts nothing here. */
function mountPlacement(){
  const host = el('levelPlacement');
  const lvl = LEVELS[activeLevel], proj = build.project;
  if(lvl.kind !== 'style' || !lvl.enabledOf(proj)){ host.innerHTML = ''; return; }

  if(activeLevel === 'carton'){
    const primaryNoun = cap(plainNoun(proj.primary.wrap ? 'wrap' : 'collation'));
    host.innerHTML =
      `<h2 style="margin-top:6px">Inside the carton</h2>
       <div id="plInVert" style="display:contents"></div>
       <div id="plInClear" style="display:contents"></div>
       <div id="plInCount" style="display:contents"></div>`;
    inputs.mountVertControl(el('plInVert'), 'pIn', proj.primary, {}, projectChanged);
    inputs.mountClearanceControl(el('plInClear'), 'pIn', proj.primary.clearance, projectChanged);
    inputs.mountCountArrangement(el('plInCount'), 'pIn', linkFor(proj, 'secondary'), 2, 1, 1, primaryNoun, projectChanged);
    syncRotInert('pIn', linkFor(proj, 'secondary'));
    return;
  }

  if(activeLevel === 'case'){
    const secondaryIn = proj.secondary.enabled !== false;
    const childLevel = secondaryIn ? proj.secondary : proj.primary;
    const childNoun = cap(plainNoun(secondaryIn ? 'carton' : (proj.primary.wrap ? 'wrap' : 'collation')));
    host.innerHTML =
      `<h2 style="margin-top:6px">Inside the case <span class="hint">from the ${childNoun.toLowerCase()}</span></h2>
       <div id="plInVert" style="display:contents"></div>
       <div id="plInClear" style="display:contents"></div>
       <div id="plInCount" style="display:contents"></div>
       <h2 style="margin-top:10px">Case onto the pallet</h2>
       <div id="plOutVert" style="display:contents"></div>
       <div id="plOutClear" style="display:contents"></div>`;
    inputs.mountVertControl(el('plInVert'), 'pIn', childLevel, {}, projectChanged);
    inputs.mountClearanceControl(el('plInClear'), 'pIn', childLevel.clearance, projectChanged);
    inputs.mountCountArrangement(el('plInCount'), 'pIn', linkFor(proj, 'tertiary'), 4, 3, 1, childNoun, projectChanged);
    syncRotInert('pIn', linkFor(proj, 'tertiary'));
    inputs.mountVertControl(el('plOutVert'), 'pOut', proj.tertiary,
      {disabledAxes: ['L', 'W'], disabledReason: 'A shipper does not go on the pallet on its side — say so explicitly if you genuinely need this'},
      projectChanged);
    inputs.mountClearanceControl(el('plOutClear'), 'pOut', proj.tertiary.clearance, projectChanged);
    return;
  }

  host.innerHTML = '';   // wrap: no child count concept
}

/** The per-level style dropdown, filtered by the registry's `tier`. A style
 *  whose tier matches the level sits under "For this level"; every other
 *  style is offered under "Override (unusual)" — a style used outside its
 *  tier is unusual, not illegal, so it's selectable with a quiet note, never
 *  forbidden. The choice writes to project.<level>.styleId (saved with the
 *  project). Product picks a piece SHAPE instead (mountProduct's #cKind). */
function mountStyleSelector(){
  const host = el('levelStyle');
  const lvl = LEVELS[activeLevel];
  if(lvl.kind !== 'style' || !lvl.enabledOf(build.project)){ host.innerHTML = ''; return; }
  const cur = activeStyleId();
  const natural = styles.filter(s => s.tier === lvl.tier);
  const override = styles.filter(s => s.tier !== lvl.tier);
  const opt = s => `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${s.name}</option>`;
  const offTier = styleById(cur).tier !== lvl.tier;
  host.innerHTML =
    `<div class="field"><label>Style <span class="hint">${lvl.tier} tier</span></label>
      <div class="inp"><select id="levelStyleSel">
        <optgroup label="For this level">${natural.map(opt).join('')}</optgroup>
        ${override.length ? `<optgroup label="Override (unusual)">${override.map(opt).join('')}</optgroup>` : ''}
      </select></div></div>` +
    (offTier ? `<div class="field bnote" style="color:var(--muted);font-size:11px">Using a ${styleById(cur).tier}-tier style at the ${lvl.label.toLowerCase()} level — unusual, but allowed.</div>` : '');
  el('levelStyleSel').addEventListener('change', () => changeLevelStyle(el('levelStyleSel').value));
}

/** Change the active level's style. The param SHAPE differs between styles
 *  (an RSC has glue/slot; a tuck carton has tuck depths), so params reset to
 *  the new style's defaults — but the geometric L/W/H the user set carry
 *  over, since those are the design intent, not a style detail. styleId +
 *  params + options all live in the project, so this is saved/loaded. */
function changeLevelStyle(newId){
  const lvl = LEVELS[activeLevel], proj = build.project;
  const old = lvl.paramsOf(proj);
  const nd = styleDefaults(newId);
  ['L', 'W', 'H'].forEach(k => { if(old[k] != null && nd[k] != null) nd[k] = old[k]; });
  lvl.setStyleId(proj, newId);
  lvl.setParams(proj, nd);
  lvl.setOptions(proj, styleOptionDefaults(newId));
  setActiveLevel(activeLevel);   // re-derive brand/exports/rails/views from the new style
  save.scheduleAutosave(gatherSaveState);
}

/** Mount the active level into the rails. Style levels bind their style
 *  params (solved dims shown as derived); the product level mounts the
 *  collation editor; the pallet level uses the pallet fields already in the
 *  DOM. */
function mountActiveLevel(){
  const lvl = LEVELS[activeLevel], proj = build.project;
  toggleRailSections(lvl.kind);
  mountEnableToggle();
  mountStyleSelector();
  mountLockControl();
  mountPlacement();
  updateDimsLabel();
  update2dTabLabel();
  if(lvl.kind === 'style' && !lvl.enabledOf(proj)){
    // disabled: nothing to mount (wrap's own params object may not even
    // exist — it goes null) — the enable toggle + the "skipped" note above
    // are the whole story here
    el('dimFields').innerHTML = ''; el('matFields').innerHTML = ''; el('optFields').innerHTML = '';
  }else if(lvl.kind === 'style'){
    const locked = lvl.lockedOf(proj);
    const g = activeGeometry();
    const effectiveDims = (!locked && g) ? g.inner : null;   // derived dims when solved
    inputs.mountLevel(activeStyle(), lvl.paramsOf(proj), lvl.optionsOf(proj), {
      effectiveDims,
      locked,
      // dims are read-only unless unlocked (mountLockControl's deliberate
      // toggle); this fires for material/option edits, and for dim edits
      // only once unlocked — never an implicit lock-on-type
      onInput: () => projectChanged()
    });
  }else if(lvl.kind === 'product'){
    // the product 2 x 2 (content mode + piece shape) and its grouping counts
    // are ALWAYS visible — never gated on the chain (that hid On Edge)
    inputs.mountProduct(proj.primary, {onInput: () => projectChanged()});
  }else{
    // pallet: the fields are static DOM; ensure their unit chips are current
    writePalletFields();
  }
}

const LEVEL_BRAND = {
  product: {code: 'PRODUCT', sub: 'Product arrangement'},
  pallet:  {code: 'PALLET',  sub: 'Load on the pallet'}
};

/** DXF/artwork/spec button availability: flexible styles have no die (film
 *  spec + artwork only); a disabled tier has no geometry to export at all.
 *  Registered as a display consumer (see the bottom of this file) so it can
 *  never silently drift from the active level/tier/style state the same
 *  way every other readout can't — even though today the only things that
 *  change it (enable/disable, style change) already force a full remount
 *  through setActiveLevel, which calls this directly too. */
/** The header state chip + mobile spec state marker — honest about export
 *  readiness, driven from the SAME writer as the export-button state so it
 *  can never claim "ready" while the button is disabled. */
function setStateChip(kind, text){
  const chip = el('stateChip');
  chip.className = 'statechip' + (kind === 'valid' ? '' : ' ' + kind);
  chip.innerHTML = `<span class="dot"></span>${text}`;
  el('msState').textContent = '● ' + text;
  el('msState').style.color = kind === 'valid' ? 'var(--valid)' : kind === 'warn' ? 'var(--warn)' : 'var(--ink-3)';
}

function updateExportButtonsState(){
  const lvl = LEVELS[activeLevel];
  if(lvl.kind !== 'style'){
    el('btnDXF').disabled = true;
    el('btnDXF').title = lvl.kind === 'product'
      ? 'A product drawing is not a cut file — select Wrap, Carton, or Case for a dieline'
      : 'No dieline at this level — select Wrap, Carton, or Case';
    el('btnArt').style.display = 'none';
    el('btnSpec').style.display = 'none';
    setStateChip('muted', lvl.kind === 'product' ? 'Product view' : 'No dieline here');
    return;
  }
  const style = activeStyle();
  const flex = style.structure === 'flexible';
  const disabledTier = !lvl.enabledOf(build.project);
  el('btnDXF').disabled = flex || disabledTier;
  el('btnDXF').title = disabledTier ? 'This tier is disabled — nothing to export'
    : flex ? 'No die for a flexible style — export the artwork template instead' : '';
  el('btnArt').style.display = flex ? '' : 'none';
  el('btnSpec').style.display = flex ? '' : 'none';
  setStateChip(disabledTier ? 'muted' : flex ? 'warn' : 'valid',
    disabledTier ? 'Tier disabled' : flex ? 'Flexible — export artwork' : 'Ready to export');
}

/** PNG snapshot buttons: the 2D exists for every level with a 2D drawing
 *  (product/wrap/carton/case), never the pallet; the 3D captures the live
 *  camera, so it's only meaningful while the 3D view is up. Not a live
 *  display — just button availability, refreshed alongside level/view changes. */
function updatePngButtonsState(){
  const no2d = LEVELS[activeLevel].kind === 'pallet';
  el('btnPng2d').disabled = no2d;
  el('btnPng2d').title = no2d ? 'No 2D dieline at the pallet level' : 'Download the 2D dieline/blank as a PNG';
  const can3d = view === '3d' && fold.isInit();
  el('btnPng3d').disabled = !can3d;
  el('btnPng3d').title = can3d ? 'Download the current 3D view as a PNG' : 'Switch to the 3D view to capture the camera';
}

function setActiveLevel(level){
  activeLevel = level;
  const lvl = LEVELS[level];
  if(lvl.kind === 'style'){
    const style = activeStyle();
    el('brandCode').textContent = style.brand.code;
    el('brandName').textContent = style.brand.sub;
  }else{
    el('brandCode').textContent = LEVEL_BRAND[level].code;
    el('brandName').textContent = LEVEL_BRAND[level].sub;
  }
  // title block + mobile spec header follow the active level's part + name
  el('tbPart').textContent = el('brandCode').textContent;
  el('tbLevel').textContent = lvl.label.toUpperCase();
  el('msTitle').textContent = `${el('brandCode').textContent} · ${lvl.label}`;
  updateExportButtonsState();
  updatePngButtonsState();
  if(el('style').value !== level) el('style').value = level;
  // the active level IS the hierarchy depth — keep the 3D depth buttons in sync
  LEVEL_ORDER.forEach(d => el('d_' + d).classList.toggle('on', mode3d === 'hier' && d === level));
  mountActiveLevel();
  renderChainString();
  refresh2d();
  if(view === 'pal') refreshPal();
  if(view === '3d') apply3dMode();
}

/** THE single "project changed" entry point — every control that mutates
 *  the project calls this, and nothing else (never a hand-picked subset of
 *  refreshers; that hand-picked list is exactly what went stale twice:
 *  once for the rails' own Dimensions boxes, once for the 3D hierarchy
 *  view). build.recompute() resolves the chain once — re-enumerating the
 *  outermost tier's candidates, preserving the current selection — and, as
 *  its OWN last step, runs every consumer registered with notify.onRefresh
 *  (see the registration block near the bottom of this file). A consumer
 *  registers itself once, at its own definition site; adding a new one
 *  never means finding and editing a list here. */
function projectChanged(){ build.recompute(); }

/** Resync the placement controls (vertical axis/rotate, clearance/
 *  headspace, child count/arrangement) currently mounted for the active
 *  rail, in place — mirrors mountPlacement()'s own level branching, but
 *  through each control's dedicated refreshXxx (no rebuild, so it can't
 *  steal focus from a field mid-edit). No-op for whichever instances
 *  aren't mounted right now (refreshVertControl/refreshClearanceControl/
 *  refreshCountArrangement all return early when their idp isn't present). */
/** "May rotate about vertical" has no effect when an explicit grid already
 *  fixes the layout (UAT #8) — disable the checkbox and show a hint rather
 *  than leaving a dead-looking control. Driven from the sibling arrangement
 *  link, kept in sync on every recompute (the Arr auto↔explicit toggle routes
 *  through onInput → recompute → refreshPlacementControls). */
function syncRotInert(idp, link){
  const inert = link && link.arrangement !== 'auto';
  const rot = el(idp + 'Rot'); if(rot) rot.disabled = inert;
  const hint = el(idp + 'RotHint'); if(hint) hint.style.display = inert ? '' : 'none';
}

function refreshPlacementControls(){
  const lvl = LEVELS[activeLevel], proj = build.project;
  if(lvl.kind !== 'style' || !lvl.enabledOf(proj)) return;
  if(activeLevel === 'carton'){
    inputs.refreshVertControl('pIn', proj.primary);
    inputs.refreshClearanceControl('pIn', proj.primary.clearance);
    inputs.refreshCountArrangement('pIn', linkFor(proj, 'secondary'));
    syncRotInert('pIn', linkFor(proj, 'secondary'));
  }else if(activeLevel === 'case'){
    const secondaryIn = proj.secondary.enabled !== false;
    const childLevel = secondaryIn ? proj.secondary : proj.primary;
    inputs.refreshVertControl('pIn', childLevel);
    inputs.refreshClearanceControl('pIn', childLevel.clearance);
    inputs.refreshCountArrangement('pIn', linkFor(proj, 'tertiary'));
    syncRotInert('pIn', linkFor(proj, 'tertiary'));
    inputs.refreshVertControl('pOut', proj.tertiary);
    inputs.refreshClearanceControl('pOut', proj.tertiary.clearance);
  }
}

/** Assemble the hierarchy bundle by READING the arrangements the chain
 *  already retained on the row (row.geo + row.arr). No re-solving here —
 *  single source of truth with the Build table. build.recompute() is what
 *  populates getRows()/getSelected(), and it always runs before this can be
 *  called (every project mutation goes through it, and it also runs once
 *  at startup via initBuild) — reaching for a fallback recompute() HERE
 *  would be reentrant: this function is itself reached FROM recompute()'s
 *  own notify.refreshAll(), so a genuinely-empty, steady-state rows array
 *  (a chain with no valid candidates) would recompute forever instead of
 *  just rendering "nothing fits". */
function hierarchyBundle(){
  const proj = build.project;
  const rows = build.getRows();
  // default to the freight-optimal row (max cartons/pallet) so the cascade
  // shows a representative case, not the first enumerated candidate
  const best = rows.reduce((a, b) => (b.cartonsPerPallet > (a ? a.cartonsPerPallet : -1) ? b : a), null);
  const row = build.getSelected() || best;
  if(!row || !row.arr) return null;
  const {cases, cartons, wraps, pieces} = row.arr;
  // the immediate-child-unit placements: `wraps` (the carton's own inner solve)
  // when the carton is an INNER tier, else `cartons` (the outermost tier's
  // childFit) — which already holds those same unit placements when the carton
  // is itself outermost (case disabled) OR is disabled entirely. Keying on
  // `wraps` presence, not on row.geo.carton, is what lets a carton-outermost
  // chain (case off) still render its wrap/pack contents.
  const wrapPlacements = wraps ? wraps.placements : cartons.placements;
  return {
    caseGeo: row.geo.case,
    cartonGeo: row.geo.carton,
    wrapGeo: row.geo.wrap,
    cases: {placements: cases.placements, count: cases.count, deck: cases.deck},
    cartons: {placements: cartons.placements},
    wraps: (pieces && wrapPlacements) ? {
      placements: wrapPlacements, envelope: pieces.envelope, pieces: pieces.placements,
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

// depths reachable given the config (Product/Wrap need a primary/wrap level;
// Carton needs the carton level itself enabled — collapses out when it isn't;
// Case likewise needs the case enabled, or its geometry is null and there is
// nothing to cut away). Pallet is always available while a chain resolves.
function depthAvailable(bundle, d){
  // Product depth needs the collation (bundle.wraps carries the piece even
  // when there's no film). Wrap depth needs an actual WRAP (wrapGeo) — the
  // bundle now carries wraps/pieces without a wrap too (so a wrapless carton/
  // case still renders its product), so wrap availability keys on wrapGeo, not
  // on bundle.wraps.
  if(d === 'product') return !!(bundle && bundle.wraps);
  if(d === 'wrap') return !!(bundle && bundle.wrapGeo);
  if(d === 'carton') return !!(bundle && bundle.cartonGeo);
  if(d === 'case') return !!(bundle && bundle.caseGeo);
  return !!bundle;
}

function hudText(bundle, opened, depth){
  const c = bundle.counts;
  // the immediate child unit inside a carton/case is a "wrap" only when a wrap
  // is in the chain; without one it's the bare product pack.
  const unit = bundle.wrapGeo ? 'wrap' : 'pack';
  const parts = [];
  if(depth === 'pallet') parts.push(`Pallet: ${c.cases} cases`);
  else if(depth === 'case') parts.push(`Case: ${c.cartonsPerCase} cartons`);
  else if(depth === 'carton') parts.push(`Carton: ${c.wrapsPerCarton} ${unit}${c.wrapsPerCarton === 1 ? '' : 's'}`);
  else if(depth === 'wrap') parts.push(`Wrap: ${c.piecesPerWrap} pieces`);
  else parts.push('Product: 1 piece');
  const chan = [];
  if(depth === 'pallet') chan.push(`case ${(opened.case ?? 0) + 1} of ${c.cases}`);
  if(depth === 'pallet' || depth === 'case') chan.push(`carton ${(opened.carton ?? 0) + 1} of ${c.cartonsPerCase}`);
  if((depth === 'pallet' || depth === 'case' || depth === 'carton') && c.wrapsPerCarton)
    chan.push(`${unit} ${(opened.wrap ?? 0) + 1} of ${c.wrapsPerCarton}`);
  return parts.join(' · ') + (chan.length ? `. Opened: ${chan.join(', ')}` : '');
}

function applyHierarchy(resetCam){
  el('m3fold').classList.remove('on');
  LEVEL_ORDER.forEach(d => el('d_' + d).classList.toggle('on', mode3d === 'hier' && activeLevel === d));
  if(view !== '3d') return;
  fold.stopFold(); fold.showBox(false); showPallet(false); showNest(false); showProduct(false);
  const bundle = hierarchyBundle();
  LEVEL_ORDER.forEach(d => el('d_' + d).disabled = !depthAvailable(bundle, d));
  if(!bundle){ hier.show(false); el('hierHud').style.display = 'none'; el('orbithint').textContent = 'configure a chain in Build first'; subjectDims.nest = null; return; }
  // the active level IS the depth; if it isn't reachable for this config
  // (e.g. the case is the active level but has just been disabled), fall back
  // to the outermost depth that IS available — never a hardcoded 'case', which
  // is itself null when the case tier is off. Pallet is always available while
  // a chain resolves, so this find() never comes back empty.
  const depth = depthAvailable(bundle, activeLevel) ? activeLevel
    : ['case', 'carton', 'pallet'].find(d => depthAvailable(bundle, d));
  if(resetCam) fold.setOrbit(fold.HOME_ORBIT.rotX, fold.HOME_ORBIT.rotY, 1.35);   // oblique 3/4 view: see the cutaway channel + open top
  const res = hier.buildHierarchy(bundle, depth, hierSel);
  // at pallet depth, flag it so the Dims overlay splits the height (deck vs load)
  subjectDims.nest = res.outer ? (depth === 'pallet' ? {...res.outer, palletMM: PALLET_HEIGHT} : res.outer) : null;
  hier.show(true);
  el('orbithint').textContent = 'drag to orbit · scroll to zoom · click a unit to open it';
  el('hierHud').style.display = 'block';
  el('hierHud').textContent = hudText(bundle, res.opened, depth);
  renderLegend(bundle, depth);
  drawDims();
}

/** Legend naming every coloured element, plus (at wrap depth) the seal
 *  compensation read straight off the model geometry. */
function renderLegend(bundle, depth){
  const swatches = LEGEND
    .filter(l => bundle.wrapGeo || (l.name !== 'Film' && !l.name.includes('seal')))
    .map(l => `<span class="lg"><span class="sw" style="background:${l.hex}"></span>${l.name}</span>`).join('');
  let readout = '';
  if(depth === 'wrap' && bundle.wrapGeo){
    const inr = bundle.wrapGeo.inner, out = bundle.wrapGeo.outer;   // model dims, mm
    const u = inputs.getUnit(), f = v => fmtLen(v, u);
    const add = (a, b, note) => `${b - a >= 0 ? '+' : ''}${f(b - a)}${note ? ' ' + note : ''}`;
    const sealsOn = bundle.wraps.seals;
    // the fin/lap gain lands on whichever axis finGainAxis(finFace) names —
    // looked up, not hardcoded onto H, so this can never silently disagree
    // with flowwrap.js's own compensation the way the OLD renderer's fixed
    // side-face placement did (Prompt 20, Part A)
    const gainAxis = finGainAxis(sealsOn.finFace);
    const gainNote = sealsOn.sealType === 'lap' ? '(lap: 0)'
      : sealsOn.finTreatment === 'standing' ? `(standing fin, ${sealsOn.finFace || 'bottom'})`
      : `(folded fin, film gauge, ${sealsOn.finFace || 'bottom'})`;
    // the machine direction is FIXED at envelope L — the two end seals land
    // at the L-ends, full height, always. The collation orientation upstream
    // chose what envelope L is (the tube's run), which is what varies the
    // pack shape — the seals never move.
    const endSealNote = '(2×end seal, machine direction)';
    const noteFor = axis => (axis === 'L' ? endSealNote : '') + (gainAxis === axis ? ' ' + gainNote : '');
    readout = `<div class="rd">` +
      `Envelope ${f(inr.L)} × ${f(inr.W)} × ${f(inr.H)} ${u}<br>` +
      `Machine direction = envelope L — tube length ${f(inr.L)} ${u}, seals at the L-ends (fixed)<br>` +
      `Seal add: L ${add(inr.L, out.L, noteFor('L'))} · ` +
      `W ${add(inr.W, out.W, noteFor('W'))} · H ${add(inr.H, out.H, noteFor('H'))}<br>` +
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
  drawDims();   // refresh the callout numbers now; the frame loop reprojects them
}

// product/pallet have no fold — they only exist in the nest cascade, so a
// fold request on those levels falls through to the hierarchy
function apply3dMode(){ if(mode3d === 'fold' && isStyleLevel()) applyFoldMode(); else applyHierarchy(true); }

/* ---------- Dims overlay: L×W×H callouts on the active component ---------- */

// which cached subject box the CURRENT view annotates — mirrors exactly what
// apply3dMode/setView chose to render, so the callouts never label a component
// other than the one on screen (fold falls through to the nest for product/
// pallet, just like the render does).
function currentDimsBox(){
  if(view === 'pal') return subjectDims.pal;
  if(view === '3d') return (mode3d === 'fold' && isStyleLevel()) ? subjectDims.fold : subjectDims.nest;
  return null;
}

// Reproject + redraw the callouts. Registered once with fold.onFrame, so it
// runs every frame and the numbers track the orbit. A no-op (overlay hidden)
// unless the toggle is on AND the current view has a subject to annotate.
function drawDims(){
  const ov = el('dimsOverlay');
  const d = showDims ? currentDimsBox() : null;
  const w = fold.isInit() ? el('cvWrap').clientWidth : 0, h = fold.isInit() ? el('cvWrap').clientHeight : 0;
  if(!d || !w || !h){ if(ov.style.display !== 'none') ov.style.display = 'none'; return; }
  const box = new THREE.Box3(
    new THREE.Vector3(-d.L/2, -d.H/2, -d.W/2),
    new THREE.Vector3( d.L/2,  d.H/2,  d.W/2));
  const u = inputs.getUnit(), lab = v => `${fmtLen(v, u)} ${u}`;
  // at pallet level the height splits into Pallet (deck) / Load (stack) / Total
  let labels;
  if(d.palletMM){
    const s = splitHeight(d.H, d.palletMM);
    labels = {L: lab(d.L), W: lab(d.W), heights: {
      palletMM: s.pallet,
      pallet: `Pallet  ${lab(s.pallet)}`,
      load:   `Load  ${lab(s.load)}`,
      total:  `Total  ${lab(s.total)}`
    }};
  }else{
    labels = {L: lab(d.L), W: lab(d.W), H: lab(d.H)};
  }
  ov.setAttribute('width', w); ov.setAttribute('height', h); ov.setAttribute('viewBox', `0 0 ${w} ${h}`);
  ov.innerHTML = dimsSVG(box, labels, fold.getCamera(), w, h);
  ov.style.display = 'block';
}

/* ---------- view switching ---------- */
function setView(v){
  view = v;
  el('tab2d').classList.toggle('on', v === '2d');
  el('tab3d').classList.toggle('on', v === '3d');
  el('tabPal').classList.toggle('on', v === 'pal');
  el('tabShelf').classList.toggle('on', v === 'shelf');
  el('tabBuild').classList.toggle('on', v === 'build');
  const canvas = v === '3d' || v === 'pal' || v === 'shelf';
  el('svgWrap').style.display   = v === '2d' ? 'flex' : 'none';
  el('cvWrap').style.display    = canvas ? 'block' : 'none';
  el('buildWrap').style.display = v === 'build' ? 'block' : 'none';
  el('hud').style.display       = v === '2d' ? 'flex' : 'none';
  el('orbithint').style.display = canvas ? 'block' : 'none';
  el('mode3d').style.display    = v === '3d' ? 'flex' : 'none';
  el('shelfPanel').style.display = v === 'shelf' ? 'block' : 'none';
  // the title block is a drawing-sheet overlay — the Build view is a table,
  // not a sheet, so hide it there (it would float over the candidate table).
  // The view toolbar STAYS (it holds the tabs — the only way back out of Build).
  el('titleBlock').style.display = v === 'build' ? 'none' : '';
  // the ViewCube mirrors the SAME shared camera the hierarchy/fold views use
  // (fold3d.js's single orbit) — it works at every depth and in FOLD mode
  // for free, since none of that is camera-specific. It does NOT extend to
  // the separate Palletize tab: that view's "pallet" is a different thing
  // from the hierarchy depth of the same name (a flat case-count render,
  // not the cutaway cascade), and the prompt's own depth list (product/
  // wrap/carton/case/pallet) names the hierarchy depths, not that tab.
  el('viewCubeWrap').style.display = (v === '3d' || v === 'shelf') ? 'block' : 'none';
  // (which rail fields show is driven by the ACTIVE LEVEL now, not the view —
  // see toggleRailSections/mountActiveLevel)
  if(v !== '3d'){ el('hierHud').style.display = 'none'; el('hierLegend').style.display = 'none'; }
  if(v === 'build'){
    // rebuild the Build fields FROM the project (they may be stale relative to
    // rail edits), preserving the picked candidate — never let Build's own
    // recompute read stale DOM back over a value the rails just wrote
    build.refreshPanel();
  }
  if(canvas){
    if(!fold.isInit()) fold.init3d(el('cvWrap'));
    if(!viewcube.isMounted()){
      viewcube.mount(el('viewCubeStage'), (rx, ry) => fold.tweenOrbit(rx, ry));
      fold.onFrame(() => viewcube.sync());   // the ONE per-frame hook every camera-follower uses
      el('viewCubeHome').addEventListener('click', () => fold.tweenOrbit(fold.HOME_ORBIT.rotX, fold.HOME_ORBIT.rotY));
      // the 4 orbit arrows are fixed DOM buttons around the cube (never
      // rotate with it, Prompt 21 #1) — each nudges 15° via viewcube's
      // own pure stepOrbit() math, then asks fold3d to tween there
      [['viewCubeTop', 'top'], ['viewCubeBottom', 'bottom'], ['viewCubeLeft', 'left'], ['viewCubeRight', 'right']]
        .forEach(([id, dir]) => el(id).addEventListener('click', () => {
          const o = fold.getOrbit();
          const {rx, ry} = viewcube.stepOrbit(dir, o.rotX, o.rotY);
          fold.tweenOrbit(rx, ry);
        }));
    }
    showShelf(v === 'shelf');   // the shelf subject is hidden in every other canvas view
    if(v === '3d'){
      showPallet(false);
      apply3dMode();
    }else if(v === 'shelf'){
      fold.showBox(false); showNest(false); showProduct(false); hier.show(false); showPallet(false);
      fold.stopFold();
      // a natural shopper angle: mostly front-on (looking at the front panels),
      // tilted down slightly and turned a touch to read the depth of the fill
      fold.setOrbit(0.34, -0.5, 1.6);
      el('orbithint').textContent = 'drag to orbit · scroll to zoom · front panels face you';
      refreshShelf();
    }else{
      fold.showBox(false); showNest(false); showProduct(false); hier.show(false);
      fold.stopFold();
      // frame the loaded pallet with margin on entry (like the hierarchy view
      // resets its camera) so it fits the pane AND leaves room for the Dims
      // callouts to stand outboard of the geometry rather than spilling off
      fold.setOrbit(fold.HOME_ORBIT.rotX, fold.HOME_ORBIT.rotY, 1.7);
      refreshPal();
    }
    fold.resize3d();
    fold.startLoop();
  }
  updatePngButtonsState();   // the 3D snapshot is only capturable while 3D is up
  drawDims();                // show/hide + refresh the Dims callouts for the new view
}

/* ---------- wiring ---------- */
// #style is the always-visible ACTIVE-LEVEL selector: which level of the
// project the rails edit and every view shows. All five levels, in
// content->pallet order. It IS the hierarchy depth too (one control).
const levelSel = el('style');
levelSel.innerHTML = LEVEL_ORDER.map(k => `<option value="${k}">${LEVELS[k].label}</option>`).join('');
levelSel.value = activeLevel;
levelSel.addEventListener('change', () => setActiveLevel(levelSel.value));

// pallet fields write straight into project.pallet — the single home for
// pallet dims (no more copy into a detached object)
function commitPallet(){
  const {L, W, maxH} = inputs.readPallet();
  build.project.pallet.L = L; build.project.pallet.W = W; build.project.pallet.maxH = maxH;
  build.project.pallet.pattern = el('palPattern').value;
  // stacking (BCT) inputs -> project.pallet.stacking (one writer)
  const st = build.project.pallet.stacking || (build.project.pallet.stacking = {});
  st.ect = Math.max(0, +el('bctEct').value || 0);
  st.unitWeightLb = Math.max(0, +el('bctWeight').value || 0);
  st.target = Math.max(0, +el('bctTarget').value || 0);
  st.doubleStack = el('bctDouble').checked;
}
/** Write project.pallet back into the pallet rail fields (after a load). */
function writePalletFields(){
  const p = build.project.pallet, pu = inputs.getPalUnit();
  const fmtP = v => pu === 'mm' ? Math.round(v).toString() : (+v.toFixed(3)).toString();
  el('pal').value = `${fmtP(fromMM(p.L, pu))} x ${fmtP(fromMM(p.W, pu))}`;
  el('palMaxH').value = fmtP(fromMM(p.maxH, pu));
  el('palPattern').value = p.pattern;
  const st = p.stacking || {};
  el('bctEct').value = st.ect ?? 32;
  el('bctWeight').value = st.unitWeightLb ?? 20;
  el('bctTarget').value = st.target ?? 3;
  el('bctDouble').checked = !!st.doubleStack;
}
function onPalletEdited(){
  commitPallet();
  // pallet dims feed casesPerPallet/coverage (the Build table AND the
  // hierarchy view), not just the palletize view — projectChanged() covers
  // all of them instead of a hand-picked subset keyed off the current tab
  projectChanged();
}
['pal', 'palMaxH', 'bctEct', 'bctWeight', 'bctTarget'].forEach(id => el(id).addEventListener('input', onPalletEdited));
['palPattern', 'bctDouble'].forEach(id => el(id).addEventListener('change', onPalletEdited));

el('units').addEventListener('change', () => {
  if(!inputs.switchUnits()) return;
  mountActiveLevel();                       // rail fields re-displayed in the new unit (values live in the project)
  build.onUnitsChanged(inputs.getUnit());   // recomputes + notifies every registered consumer
});
el('palUnits').addEventListener('change', () => {
  if(inputs.switchPalUnits() && view === 'pal') refreshPal();
});

el('tab2d').addEventListener('click', () => setView('2d'));
el('tab3d').addEventListener('click', () => setView('3d'));
el('tabPal').addEventListener('click', () => setView('pal'));
el('tabShelf').addEventListener('click', () => setView('shelf'));
el('tabBuild').addEventListener('click', () => setView('build'));
// the "which candidate row" label (pallet readout) jumps to the Build table
el('palRowLabel').addEventListener('click', () => setView('build'));

/* ---------- retail shelf controls: view-local state, live-update the fill --- */
el('shFront').innerHTML = FRONT_PANELS.map(f => `<option value="${f.v}">${f.label}</option>`).join('');
(function writeShelfFields(){
  el('shWidth').value = shelf.width; el('shDepth').value = shelf.depth; el('shHeight').value = shelf.height;
  el('shFront').value = shelf.front;
  el('shFacings').value = shelf.facings === 'auto' ? '' : shelf.facings;
  el('shStack').value = shelf.stack === 'auto' ? '' : shelf.stack;
  el('shDeep').value = shelf.deep === 'auto' ? '' : shelf.deep;
})();
const shelfDim = (v, fb) => { const n = Math.round(+v); return Number.isFinite(n) && n >= 1 ? n : fb; };
const shelfCount = raw => raw.trim() === '' ? 'auto' : Math.max(1, Math.round(+raw) || 1);
el('shWidth').addEventListener('input',  () => { shelf.width  = shelfDim(el('shWidth').value,  shelf.width);  refreshShelf(); });
el('shDepth').addEventListener('input',  () => { shelf.depth  = shelfDim(el('shDepth').value,  shelf.depth);  refreshShelf(); });
el('shHeight').addEventListener('input', () => { shelf.height = shelfDim(el('shHeight').value, shelf.height); refreshShelf(); });
el('shFront').addEventListener('change', () => { shelf.front = el('shFront').value; refreshShelf(); });
el('shFacings').addEventListener('input', () => { shelf.facings = shelfCount(el('shFacings').value); refreshShelf(); });
el('shStack').addEventListener('input',   () => { shelf.stack   = shelfCount(el('shStack').value);   refreshShelf(); });
el('shDeep').addEventListener('input',    () => { shelf.deep    = shelfCount(el('shDeep').value);    refreshShelf(); });
el('m3fold').addEventListener('click', () => { mode3d = 'fold'; apply3dMode(); });
// Dims: toggle the L×W×H callout overlay (off by default). drawDims runs on
// the render loop, so flipping the flag is enough; call it once for immediacy.
el('m3dims').addEventListener('click', () => {
  showDims = !showDims;
  el('m3dims').classList.toggle('on', showDims);
  drawDims();
});
// Reproject the Dims callouts every frame so they track the orbit. Registered
// once here (fold3d's frame-callback Set exists from import, before init3d), NOT
// inside the viewcube-mount guard — that guard can already be satisfied by the
// time the 3D view first opens, which would silently drop the registration.
fold.onFrame(drawDims);
// the 3D depth buttons ARE active-level buttons — one control, so the rails
// and the cascade always point at the same level
LEVEL_ORDER.forEach(d =>
  el('d_' + d).addEventListener('click', () => {
    if(el('d_' + d).disabled) return;
    mode3d = 'hier'; hierSel = {};   // fresh depth resets the open channel to defaults
    setActiveLevel(d);
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
  downloadDXF(g, g.inner, inputs.getUnit(), activeStyleId().toUpperCase());
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

// PNG snapshots — one-shot client-side actions (GitHub Pages, no server), NOT
// registered with recompute(). Filenames mirror the DXF's level+dims shape.
function pngBaseName(){
  const u = inputs.getUnit();
  const d = v => Math.round(fromMM(v, u));
  const code = isStyleLevel() ? activeStyleId().toUpperCase() : LEVELS[activeLevel].label.toUpperCase();
  const g = activeGeometry();
  return g ? `${code}_${d(g.inner.L)}x${d(g.inner.W)}x${d(g.inner.H)}_${u}` : code;
}
// 2D: the full blank/dieline from geometry, view-independent (ignores zoom/pan).
el('btnPng2d').addEventListener('click', () => {
  if(LEVELS[activeLevel].kind === 'pallet') return;   // no 2D at the pallet level
  const suffix = isStyleLevel() ? (activeStyle().structure === 'flexible' ? 'blank' : 'dieline') : 'product';
  downloadSvgPNG(el('svg'), `${pngBaseName()}_${suffix}.png`);
});
// 3D: exactly the on-screen camera (fold3d reads its own canvas; the ViewCube
// is a separate renderer, never composited in).
el('btnPng3d').addEventListener('click', () => {
  const url = fold.capturePNG(2);
  if(url) savePNG(url, `${pngBaseName()}_${activeLevel}_3d.png`);
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
  // rebuilding <option>s replaces the DOM the browser tracks selection on —
  // without re-marking the CURRENT value as selected, the select snaps back
  // to its first option every time this runs, including when IT ITSELF is
  // the thing that just fired (this function is the select's own 'change'
  // handler): pick slot 3, the rebuild it triggers reverts to slot 1 before
  // the user can do anything with the pick. Read the value BEFORE rebuild,
  // re-apply it after.
  const cur = sel.options.length ? +sel.value : 1;
  sel.innerHTML = slots.map(s => `<option value="${s.index}"${s.index === cur ? ' selected' : ''}>${s.index}. ${s.name ? s.name : '(empty)'}</option>`).join('');
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

/* ---------- self-registered display consumers ---------------------------
 * Every display that reads project/chain state registers its OWN refresher
 * here, once — see notify.js. build.recompute() (called by projectChanged,
 * by build.js's own row-selection/rounding/load paths, and once here at
 * startup via initBuild) runs every one of these as its last step. Nothing
 * in this file calls them separately, and this list is not itself a thing
 * to keep in sync with anything — it exists once, at startup, and every
 * entry reads live app/project state fresh on each call, so there is
 * nothing here that could go stale the way onProjectEdited's hand-picked
 * body used to.
 *
 * Each refresher guards its own relevance (e.g. "only if view is '3d'")
 * rather than being conditionally registered — registration is permanent;
 * relevance is the refresher's own business, exactly like refresh2d/
 * refresh3d/refreshPal already did before this rework. */
notify.onRefresh('railDims', () => {
  const lvl = LEVELS[activeLevel];
  // A disabled tier has no params/lock to read (wrap goes null outright), so
  // there are no derived dims boxes to resync — and reading lockedOf on a
  // null level would throw. Bail on !enabled BEFORE touching lockedOf.
  if(!isStyleLevel() || !lvl.enabledOf(build.project) || lvl.lockedOf(build.project)) return;
  const g = activeGeometry();
  inputs.refreshDims(g ? g.inner : null);
});
notify.onRefresh('placement', refreshPlacementControls);
notify.onRefresh('lockControl', mountLockControl);
notify.onRefresh('chainString', renderChainString);
notify.onRefresh('dieline2d', refresh2d);
notify.onRefresh('fold3d', () => { if(view === '3d' && mode3d === 'fold' && isStyleLevel()) refresh3d(); });
notify.onRefresh('hier3d', () => { if(view === '3d' && mode3d === 'hier') applyHierarchy(false); });
// refreshPal now does the CHEAP pallet stats + BCT readout on every recompute
// (right-rail readout is always visible); it only builds the heavy 3D pallet
// when the Palletize view is up. So it runs unconditionally here — this is what
// makes the BCT readout update live on box/ECT/weight/double-stack/style edits.
notify.onRefresh('palletize', refreshPal);
// the retail shelf reflects the sellable pack's geometry, so it re-fills on
// every project change too (refreshShelf no-ops unless the Shelf view is up).
notify.onRefresh('shelf', refreshShelf);
notify.onRefresh('exportButtons', updateExportButtonsState);
notify.onRefresh('autosave', () => save.scheduleAutosave(gatherSaveState));

// Build view: candidate table only (build.js owns it). initBuild's own
// recompute() populates rows/selected and runs the registration above once
// at startup, exactly like every later edit does.
build.initBuild(inputs.getUnit());

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
    // loadProject's own recompute() only RESYNCS the rail's existing
    // fields in place (via the registered display consumers) — it never
    // rebuilds them, since most edits don't need to. But this IS a
    // wholesale project replacement (a fresh default project, possibly a
    // different style/structure than whatever was showing), so the rail's
    // STRUCTURE has to be rebuilt too, not just its values — force that
    // explicitly rather than leaving fields from the discarded project's
    // style mounted underneath fresh values that don't match their shape.
    setActiveLevel(activeLevel);
    el('loadNotice').style.display = 'none';
  }}]);
})();

// "View selected": selecting a row already commits that candidate to the
// project (the views resolve it via selKey()); this just focuses the
// OUTERMOST tier's dieline — the case, or the carton itself once the case
// is disabled (Step 4) — never hardcoded to "case".
el('bUse').addEventListener('click', () => {
  if(!build.getSelected()) return;
  setActiveLevel(describeChain(build.project).outerKey === 'tertiary' ? 'case' : 'carton');
  setView('2d');
});
