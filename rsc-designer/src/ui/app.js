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
import {toMM, fromMM, fmtLen, fmtInputValue} from '../core/units.js';
import * as inputs from './inputs.js';
import {el} from './inputs.js';
import {draw2d, apply2dView, view2d} from '../render/dieline2d.js';
import {auxLegendRows} from '../render/auxlayers.js';
import {isDisplayGeo, openabilityWarning, perfSpecRows} from '../core/perf.js';
import {drawProduct2d, resolveProductPiece} from '../render/product2d.js';
import {drawTray2d, TRAY_LINE_TYPES} from '../render/tray2d.js';
import {dateStamp} from '../core/stamp.js';
import {fmtMoney} from '../core/cost.js';
import * as fold from '../render/fold3d.js';
import {dimsSVG, splitHeight} from '../render/dims3d.js';
import {foldBuilders} from '../render/folds/index.js';
import {PALLET_HEIGHT, MIN_FAITHFUL_DECK_H} from '../render/palletmesh.js';
import {buildShelf, showShelf, clearShelfBays, faceUpRoll} from '../render/shelf3d.js';
import {fitInto, orientDims} from '../core/containment.js';
import {stackAnalysis, boxesAboveBottom, DERATINGS} from '../core/bct.js';
import {showNest, showProduct} from '../render/nest3d.js';
import * as hier from '../render/hierarchy3d.js';
import {LEGEND} from '../render/hierarchy3d.js';
import * as viewcube from '../render/viewcube.js';
import {downloadDXF} from '../export/dxf.js';
import {downloadArtwork, downloadArtworkPNG, filmSpecText} from '../export/artwork.js';
import {loadArtworkFile, defaultFit, composeArtCanvas, artImage} from '../render/artwork.js';
import {buildWrapArt, showWrapArt, clearWrapArt} from '../render/artwork3d.js';
import {downloadSvgPNG, savePNG, saveBlob} from '../export/png.js';
import {buildPalletPdf} from '../export/palletpdf.js';
import * as build from './build.js';
import * as save from './save.js';
import * as notify from './notify.js';
import {newProject, levelGeometry, resolveActiveRow, resolveChainShape, describeChain, linkFor, styleDefaults, styleOptionDefaults, styleOpenTopDefault, applyPatternSelection, trayAutoCells} from '../core/project.js';
import {analyzeSensitivity} from '../core/sensitivity.js';
import {collate} from '../core/collation.js';
import {buildTray3d, trayToSTL} from '../render/tray3d.js';
import {parseTrayLink, buildTrayLink} from '../core/cookietraylink.js';

let view = '2d';
// FEATURE FLAG: the FOLD 3D mode has never shown a real fold animation, so it's
// hidden for now. All the fold code stays intact (refresh3d, applyFoldMode, the
// notify('fold3d') consumer, the m3fold handler) — flip this to true to bring
// the button back once the animation is real. The default mode is 'hier', so
// hiding Fold never affects the 3D view's default.
const FOLD_VIEW_ENABLED = false;
let mode3d = 'hier';           // 'fold' | 'hier'
let hierSel = {};              // opened index per tier {case,carton,wrap}
// Solid (look AT the pack — graphics) vs Cutaway (look INSIDE — fit) in the
// hierarchy view. null = follow the smart default (Solid when the pack shown
// has artwork); true/false = a user override held until artwork or depth
// changes re-picks the default.
let solidOverride = null;

// Dims overlay: L×W×H callouts on the active component, off by default. Each
// view's refresh caches the subject's OUTER dims (mm, centred on the origin —
// the shared world convention x=L,y=H,z=W); drawDims picks the right one for
// the current view and reprojects it every frame so the numbers track the orbit.
let showDims = false;
const subjectDims = {fold: null, nest: null};

// Retail shelf view state — a visualization config, not a design parameter,
// so it lives here (like `view`/`mode3d`), never on the project. Counts are a
// number or 'auto' (fill to the shelf). `front` is which face points at the
// shopper, as an orientation string consumed by fitInto/orientDims (see
// FRONT_PANELS): o[0]=across, o[1]=depth (back-to-front), o[2]=up.
// `rot` spins the FORWARD FACE in its own plane (about the depth axis) by
// 0/90/180/270°, clockwise to the shopper — like turning a framed picture on
// the wall. Face selection picks WHICH face the shopper sees; rot spins whatever
// face is forward, and the same face stays forward (never a side/back). 90°/270°
// swap the face's two dims (across ↔ up; depth unchanged), so its width×height
// on the shelf changes and the fill (facings/stack/count/occupied) recomputes.
const shelf = {width: 1000, depth: 500, height: 300, facings: 'auto', stack: 'auto', deep: 'auto', front: 'auto', rot: 0, cutaway: false};
/* COMPARE STATE — view state, never project state. `project` is a snapshot
 * deserialized from a save slot: a separate object graph with its own artwork
 * and its own rates, solved through the same pure core functions and never
 * through build.js's caches. Nothing here is written by anything but the
 * compare control. */
const compare = {on: false, slot: null, project: null, name: ''};
// the shelf's natural angle IS the shopper's: mostly front-on (looking at the
// front panels), tilted down slightly and turned a touch to read the depth of
// the fill. One source for both entry and the ViewCube Home reset.
const SHELF_ORBIT = {rotX: 0.34, rotY: -0.5, span: 1.6};
// front-panel choices: which pack FACE points at the shopper. The front face
// is (across × up), so the depth axis is the middle char. Defaults to L×H —
// the carton's printed front panel, upright.
const FRONT_PANELS = [
  {v: 'auto', label: 'Auto (the pack\u2019s own front)'},
  {v: 'LWH', label: 'L × H face (upright)'},
  {v: 'WLH', label: 'W × H face (turned)'},
  {v: 'LHW', label: 'L × W face (laid flat)'}
];

/* Which face a pack is MERCHANDISED on is a property of the pack, not of the
 * shelf. The default used to be a flat 'LWH' — right for an upright tube
 * carton, whose printed panel is a wall, and wrong for anything whose display
 * face is not a wall: a shrink-wrapped tray came to the shelf standing on its
 * long edge, presenting 49mm of film end and hiding the open face the product
 * is actually seen through. Each style declares its own display face as the
 * axis of that face's outward NORMAL (meta.frontFace), and that normal IS the
 * depth axis of the orientation string (o[1]) — so the mapping is total and
 * there is one rule, not one per pack type. */
const FRONT_BY_NORMAL = {W: 'LWH', L: 'WLH', H: 'LHW'};
const packFrontOrientation = geo =>
  (geo && geo.meta && FRONT_BY_NORMAL[geo.meta.frontFace]) || 'LWH';

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
           setOpenTop: (p, v) => { p.primary.wrap.openTop = v; },
           paramsOf: p => p.primary.wrap.params, setParams: (p, o) => { p.primary.wrap.params = o; },
           optionsOf: p => p.primary.wrap.options, setOptions: (p, o) => { p.primary.wrap.options = o; },
           lockedOf: p => p.primary.wrap.locked, setLocked: (p, v) => { p.primary.wrap.locked = v; },
           derivedFrom: p => 'the ' + plainNoun('collation'), fitsOf: row => row.wrapFits,
           enabledOf: p => !!p.primary.wrap},
  carton: {label: 'Carton', kind: 'style', tier: 'secondary', geoLevel: 'carton',
           styleIdOf: p => p.secondary.styleId, setStyleId: (p, id) => { p.secondary.styleId = id; },
           setOpenTop: (p, v) => { p.secondary.openTop = v; },
           perfKey: 'secondary',
           paramsOf: p => p.secondary.params, setParams: (p, o) => { p.secondary.params = o; },
           optionsOf: p => p.secondary.options, setOptions: (p, o) => { p.secondary.options = o; },
           lockedOf: p => linkFor(p, 'secondary').locked, setLocked: (p, v) => { linkFor(p, 'secondary').locked = v; },
           derivedFrom: p => 'the ' + plainNoun(p.primary.wrap ? 'wrap' : 'collation'),
           fitsOf: row => row.secondaryFits,
           enabledOf: p => p.secondary.enabled !== false},
  case:   {label: 'Case',   kind: 'style', tier: 'tertiary', geoLevel: 'case',
           styleIdOf: p => p.tertiary.styleId, setStyleId: (p, id) => { p.tertiary.styleId = id; },
           setOpenTop: (p, v) => { p.tertiary.openTop = v; },
           perfKey: 'tertiary',   // the project key carrying this level's perforation
           paramsOf: p => p.tertiary.params, setParams: (p, o) => { p.tertiary.params = o; },
           optionsOf: p => p.tertiary.options, setOptions: (p, o) => { p.tertiary.options = o; },
           lockedOf: p => linkFor(p, 'tertiary').locked, setLocked: (p, v) => { linkFor(p, 'tertiary').locked = v; },
           // re-pointed per the enabled chain (describeChain), never hardcoded
           derivedFrom: p => `the ${plainNoun(describeChain(p).childNoun)}`,
           fitsOf: row => row.tertiaryFits,
           enabledOf: p => p.tertiary.enabled !== false},
  // The thermoformed tray: an OPTIONAL, NON-style level. It has no blank, no
  // cut path and no creases, so it deliberately has no styleId, no geoLevel
  // and no DXF — the product2d.js precedent (a sibling with its own view).
  // activeGeometry() already returns null for a non-style level.
  tray:   {label: 'Tray', kind: 'tray',
           enabledOf: p => !!(p.tray && p.tray.enabled),
           setEnabled: (p, v) => { p.tray.enabled = v; }},
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
const LEVEL_ORDER = ['product', 'tray', 'wrap', 'carton', 'case', 'pallet'];
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
/** The resolved tray stage on screen (`solveTrayStage`'s result), or null when
 *  the tray is out of the chain. ONE accessor, so the 2D drawing, the STL
 *  export and the Cookie-Tray link all describe the same tray — the drawing
 *  must never be able to show a tray the exports don't. */
function activeTray(){
  const row = resolveActiveRow(build.project, build.getRounding(), selKey());
  return (row && row.tray) || null;
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
  if(activeLevel === 'tray'){
    // the thermoformed tray: a multiview drawing, not a dieline (tray2d.js's
    // own doc comment explains why it can't be one — no blank, no cut, no
    // crease, nothing to DXF). Reads the SAME resolved stage the 3D depth,
    // the STL and the Cookie-Tray link read.
    const tray = activeTray();
    if(!tray){
      el('svg').innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-3)" font-family="var(--mono)" font-size="14">Enable the tray to draw it</text>`;
      setSummary('—', '—', '--'); el('styleStats').innerHTML = '';
      return;
    }
    drawTray2d(el('svg'), tray, u, dateStamp());
    const o = tray.outer;
    // the tray has no blank and no board area; its OUTER is the envelope the
    // chain is sized from, so that is the one summary field it can honestly fill
    const outerText = `${fmtLen(o.L, u)} × ${fmtLen(o.W, u)} × ${fmtLen(o.H, u)} ${u}`;
    setSummary('—', outerText, '--');
    const stat = (lab, val) => `<div class="stat"><span class="lab">${lab}</span><span class="val">${val}</span></div>`;
    el('styleStats').innerHTML =
      stat('Envelope', outerText) +
      stat('Tray height', `${fmtLen(tray.params.overallH, u)} ${u}`) +
      stat('Cells', `${tray.nCells} × ${tray.perCell} = ${tray.total}`) +
      stat('Cell', `${fmtLen(tray.params.cellLen, u)} × ${fmtLen(tray.params.cellWid, u)} × ${fmtLen(tray.params.cellH, u)} ${u}`) +
      levelUnitCostStat();
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
  const {w, h} = draw2d(el('svg'), g, u, build.project.printText, artFor(activeLevel, g));
  update2dTabLabel();          // the legend is a claim about THIS render's layers
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
  // MATERIAL COST for one of THIS level's units, beside the area/mass it is
  // computed from — read off row.cost.perUnit, the same one derivation the
  // roll-up panel and the Build column read. Never multiplied again here.
  const costStat = levelUnitCostStat();
  // OPENABILITY. Warn, never block: an asymmetric or unusual build is
  // legitimate, and a pack that will not open is a design error to show, not
  // a state to forbid. Nothing on any write path consults this.
  const warn = openabilityWarning(g, (LEVELS[activeLevel].perfKey && build.project[LEVELS[activeLevel].perfKey].perf) || null);
  const warnStat = warn
    ? `<div class="stat" data-warn="openability" style="grid-column:1/-1">` +
      `<span class="lab" style="color:var(--warn)">⚠ ${warn.title}</span>` +
      `<span class="val" style="font-size:11px;line-height:1.5;font-weight:400">${warn.detail}</span></div>`
    : '';
  el('styleStats').innerHTML = outerStat + costStat + warnStat + (style.readouts ? style.readouts(g) : []).map(r =>
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
  if(!builder){ fold.showBox(false); showWrapArt(false); subjectDims.fold = null; return; }
  fold.buildBox(builder, g, build.project.printText, lvl.optionsOf(build.project));
  subjectDims.fold = {L: g.outer.L, W: g.outer.W, H: g.outer.H};
  // artwork cladding: if this level has uploaded art AND the style publishes a
  // panel map, clad the pack with the art (UV-mapped per artMap) and hide the
  // plain kraft box; otherwise ensure any old ribbon is gone and the box shows.
  // Owned HERE so both the fold-mode entry and the recompute notifier apply it.
  const art = artFor(activeLevel, g);
  if(art && !g.meta.artMap.flat){          // flat maps (tray) get 2D+template only, no 3D tube
    // re-render once the image has decoded (composeArtCanvas needs it complete)
    const img = artImage(art.src, () => { if(view === '3d' && mode3d === 'fold' && isStyleLevel()) refresh3d(); });
    const canvas = composeArtCanvas(g.meta.artMap, art, img, 1600);
    if(canvas){ buildWrapArt(g, canvas, true); fold.showBox(false); return; }
  }
  clearWrapArt(); fold.showBox(true);
}

/** The uploaded artwork record for a level, but only when the level's style
 *  actually publishes a panel map (geo.meta.artMap) — the one gate that says
 *  "this style supports the round-trip". null otherwise, so 2D/3D/UI all agree. */
function artFor(level, g){
  const geo = g || (isStyleLevel() ? activeGeometry() : null);
  if(!geo || !geo.meta.artMap) return null;
  const a = build.project.artwork && build.project.artwork[level];
  return (a && a.src) ? a : null;
}

/** The composed art-on-template CANVAS for a level's geometry (or null) — the
 *  texture source every rendered instance of that pack shares. `flat` maps
 *  (tray) have no 3D tube, so they never texture the 3D. Re-renders the
 *  hierarchy once the image decodes (composeArtCanvas needs it complete). */
function artCanvasFor(level, geo, onDecode, proj = build.project){
  if(!geo || !geo.meta.artMap || geo.meta.artMap.flat) return null;
  const a = proj.artwork && proj.artwork[level];
  if(!a || !a.src) return null;
  const img = artImage(a.src, onDecode || (() => { if(view === '3d' && mode3d === 'hier') applyHierarchy(false); }));
  return composeArtCanvas(geo.meta.artMap, a, img, 1024);   // instances are small — 1024 is ample
}

/** The pack shown at a hierarchy depth has artwork? (pallet shows the
 *  outermost pack — case, or carton once the case is off.) Drives the Solid
 *  default: you want to look AT a printed pack, INTO a plain one. */
function depthHasArt(depth, bundle){
  if(depth === 'carton') return !!(bundle.cartonGeo && artFor('carton', bundle.cartonGeo));
  if(depth === 'case')   return !!(bundle.caseGeo && artFor('case', bundle.caseGeo));
  if(depth === 'wrap')   return !!(bundle.wrapGeo && artFor('wrap', bundle.wrapGeo));
  if(depth === 'pallet') return !!((bundle.caseGeo && artFor('case', bundle.caseGeo)) ||
                                   (bundle.cartonGeo && artFor('carton', bundle.cartonGeo)));
  return false;
}

/** Effective Solid state for a depth: the user override if set, else the smart
 *  default (art present → Solid). */
function solidActive(depth, bundle){
  return solidOverride !== null ? solidOverride : depthHasArt(depth, bundle);
}

/* ---------- artwork panel (template / upload / fit / remove) ---------- */

/** This level can round-trip artwork iff its style publishes a panel map. */
function artSupported(){
  const g = isStyleLevel() ? activeGeometry() : null;
  return !!(g && g.meta.artMap);
}

/** Show + populate the artwork panel for the active level (2D/3D views only).
 *  Reads state from the project's artwork record — the single writer. */
function updateArtPanel(){
  const show = artSupported() && (view === '2d' || view === '3d');
  el('artPanel').style.display = show ? 'block' : 'none';
  if(!show) return;
  el('artLevelName').textContent = LEVELS[activeLevel].label.toLowerCase();
  const art = build.project.artwork[activeLevel];
  const has = !!(art && art.src);
  el('artControls').style.display = has ? 'block' : 'none';
  el('artHint').style.display = has ? 'none' : 'block';
  if(has){
    el('artFit').value = art.fit || 'stretch';
    el('artDx').value = art.dx || 0;
    el('artDy').value = art.dy || 0;
    el('artScale').value = Math.round((art.scale || 1)*100);
    el('artInfo').textContent = `${art.natW}×${art.natH}px source · ${Math.round((art.bytes || 0)/1024)} KB stored`;
  }
}

/** Re-render after an artwork change through the ONE notification path: every
 *  view consumer (2D dieline, 3D fold) already re-reads the project's artwork,
 *  and autosave picks up the new bytes. Then resync the panel controls. */
function afterArtChange(){
  solidOverride = null;   // adding/removing art re-picks the Solid default
  projectChanged();
  updateArtPanel();
}

/** Apply a fit-control edit to the active level's artwork record (the writer). */
function editArt(patch){
  const art = build.project.artwork[activeLevel];
  if(!art) return;
  Object.assign(art, patch);
  afterArtChange();
}

/** The pallet-stats readout: the OUTERMOST enabled tier on the pallet — the
 *  case (the shipper) normally, or the carton once the case is disabled —
 *  independent of the active level, the pallet result the chain produced. */
function refreshPal(){
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
    clearBCT();
    drawDims();
    return;
  }
  const perLayer = row.casesPerLayer, layers = row.caseLayers, total = row.casesPerPallet;
  // the label is the pattern candidate's own, self-describing (palletpatterns
  // bakes ' · interlocked' into interlocked variants) — nothing appended here
  const label = row.casesFit ? row.casesFit.label : '';
  el('palPat').textContent = perLayer > 0 ? label : 'does not fit';
  el('palCnt').textContent = perLayer > 0 ? `${perLayer} × ${layers}` : '--';
  el('palTot').textContent = total > 0 ? `${total} ${outerNoun}s` : '0';
  el('palCov').textContent = perLayer > 0 ? `${row.coveragePct}%` : '--';
  const palText = total > 0 ? `${total} ${outerNoun}s` : (perLayer > 0 ? '—' : 'does not fit');
  el('tbPallet').textContent = palText; el('msPallet').textContent = palText;
  // which candidate row every view (2D/3D/DXF/readout) is reflecting (UAT #B2):
  // resolveActiveRow re-derives a fresh row, so locate it in the Build rows by
  // its candidate key rather than by identity.
  const sel = build.getSelectedCandidateKey();
  const sameKey = (a, b) => a && b && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz && a.orientation === b.orientation;
  // position in the Build table's CURRENT sort — the SAME ordered list the table
  // and the 3D cycle arrows read (build.getCycleState), never a raw-enumeration
  // index, so this readout, the highlighted table row and the arrows can never
  // report different positions for the one candidate on screen.
  const cyc = build.getCycleState();
  const rl = el('palRowLabel');
  if(cyc.pos >= 1){
    const basis = sameKey(sel, row) ? 'selected candidate' : 'best cartons/pallet';
    rl.innerHTML = `<span class="rl-eyebrow">showing</span>${basis} · row ${cyc.pos} of ${cyc.total}` +
      ` &middot; <span class="rl-link">open Build</span>`;
    rl.style.display = 'flex';
  }else{
    rl.style.display = 'none';
  }
  renderBCT(g, {perLayer, layers, total, coveragePct: row.coveragePct});
  drawDims();
}

/* ---------- dimensional sensitivity: which case dimension is binding ---------
 * Read-only analysis (core/sensitivity.js) of what the smallest change to each
 * case dimension would buy or cost on the pallet. Shown at PALLET level: the
 * quantities are cases/cartons per pallet — the same numbers the adjacent
 * pallet-stats block reports — and the pallet rail already owns the other
 * "how do I fit more on this deck" controls (deck dims, stack pattern). At
 * case level the engineer is sizing the case around its own contents, not
 * reading deck efficiency.
 *
 * NEVER mutates anything: the perturbed sizes are hypotheticals, not
 * selectable configurations. ~40 pallet solves in ~1-7 ms (binary search over
 * a monotone count), so it runs LIVE on the one notifier like every other
 * display — no Analyze button — and is skipped outright at other levels. */
function refreshSensitivity(){
  const show = activeLevel === 'pallet';
  el('sensBlock').style.display = show ? '' : 'none';
  if(!show) return;                      // not on screen: don't spend the solves
  const row = resolveActiveRow(build.project, build.getRounding(), selKey());
  const a = row ? analyzeSensitivity(build.project, row) : null;
  if(!a){
    el('sensBase').textContent = '--';
    el('sensBody').innerHTML = '';
    el('sensNote').textContent = '';
    return;
  }
  const u = inputs.getUnit(), f = v => fmtLen(v, u);
  el('sensNoun').textContent = a.outerNoun;
  el('sensBase').textContent = a.baseline.cases > 0
    ? `${a.baseline.cases} ${a.outerNoun}s · ${a.baseline.cartons} ${a.childNoun}s`
    : 'does not fit';
  const pct = Math.round(a.searchFraction*100);
  el('sensBody').innerHTML = a.axes.map(ax => {
    const gain = ax.gain.found
      ? `<div class="sensline gain"><span>&darr; ${f(ax.gain.step)} ${u}</span>` +
        `<span class="amt">+${ax.gain.cases} ${a.outerNoun}s · +${ax.gain.cartons} ${a.childNoun}s</span></div>` +
        (ax.gain.perCarton
          ? `<div class="senspc">&asymp; ${f(ax.gain.perCarton)} ${u} per ${a.childNoun} &mdash; approximate</div>` : '')
      : `<div class="sensline none"><span>&darr; no gain within ${pct}%</span>` +
        `<span class="amt">&mdash;</span></div>`;
    const head = ax.headroom.found
      ? `<div class="sensline loss"><span>&uarr; ${f(ax.headroom.mm)} ${u} headroom</span>` +
        `<span class="amt">then ${ax.headroom.cases} ${a.outerNoun}s</span></div>`
      : `<div class="sensline none"><span>&uarr; headroom &gt; ${pct}%</span>` +
        `<span class="amt">&mdash;</span></div>`;
    return `<div class="sensax"><div class="axname">${ax.label} <span>${f(ax.current)} ${u}</span></div>${gain}${head}</div>`;
  }).join('');
  el('sensNote').innerHTML =
    `<strong>Sensitivity, not a configuration.</strong> A smaller ${a.outerNoun} holds less — ` +
    `reducing it requires the ${a.childNoun}/product to reduce accordingly. Per-${a.childNoun} ` +
    `figures are approximate: they ignore caliper and clearances. One dimension at a time; ` +
    `searched to &plusmn;${pct}%.`;
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
  // McKee ASSUMES A CLOSED BOX. A container in display state has no lid and a
  // profiled front, so the formula does not describe it — and a plausible
  // wrong stacking number is worse than none, because nobody re-checks a
  // number that looked reasonable. No derate, no interpolation, no invented
  // display-state formula: the number is suppressed and says why.
  if(isDisplayGeo(g)){
    clearBCT();
    el('bctRatio').textContent = 'not applicable — display state';
    el('bctRatio').style.color = 'var(--ink-3)';
    el('bctNote').innerHTML = '<strong>Not applicable.</strong> McKee assumes a closed box. ' +
      'This container is perforated for display, so it has no lid and no continuous front panel. ' +
      'Set the perforation back to shipping state for a stacking estimate.';
    el('bctNote').style.color = 'var(--ink-3)';
    return;
  }
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

/** The sellable pack noun + its resolved geometry for the current chain.
 *  Carton if there is one, else the WRAP if there is one, else the case.
 *  The wrap was missing from this rule, so a tray -> wrap -> case chain
 *  merchandised the shipper: a shrink-wrapped tray of product IS the retail
 *  unit, and nobody puts the case on a shelf. The tray makes that chain
 *  ordinary rather than exotic, which is what exposed it. */
function shelfSellable(proj = build.project, key = selKey()){
  const noun = (proj.secondary.enabled !== false) ? 'carton'
             : proj.primary.wrap ? 'wrap'
             : 'case';
  const row = resolveActiveRow(proj, build.getRounding(), key);
  return {noun, row, geo: row && row.geo ? row.geo[noun] : null};
}

const shelfKey = v => +v.toFixed(3);   // stable grouping key for placement coords

/**
 * THE shelf fill for ONE design, in ONE bay.
 *
 * Lifted out of refreshShelf so compare mode can call it twice — once per
 * design — rather than growing a second implementation of the same packing,
 * orientation and subsetting rules. The single shelf is this function called
 * once; a comparison is it called twice with different projects. There is no
 * second fill anywhere.
 *
 * Reads ONLY the project it is handed. `proj` is the live project for design A
 * and a slot-loaded snapshot for design B, and nothing here writes to either.
 *
 * @returns {Object|null} everything the renderer and the readout need, or null
 *   when the chain has no sellable pack geometry at all.
 */
function shelfFill(proj, key, onArtDecode){
  const {noun, row, geo} = shelfSellable(proj, key);
  if(!geo) return {noun, geo: null, row};
  const cavity = {L: shelf.width, W: shelf.depth, H: shelf.height};
  // artwork on the sellable pack → every facing pack shows it, printed FRONT to
  // the shopper. That pins the orientation to the print front ('LWH', the pack's
  // canonical footprint), overriding the manual front selector so the packed
  // slot matches the textured geometry.
  const sellCanvas = artCanvasFor(noun, geo, onArtDecode, proj);
  const artInfo = sellCanvas ? {am: geo.meta.artMap, canvas: sellCanvas} : null;
  // Whether a PRINTED pack can still be turned to another face depends on where
  // its art lives. A wrap's art rides the real pillow geometry (closedWrapParts
  // + bodyRingUVs), which orients like any other geometry, so every face stays
  // selectable. A tube pack's art is packArtGeometry — built already laid out
  // for that pack's own front — so turning it to another face would carry the
  // layout rather than re-derive it, and the selector stays pinned. The old
  // rule locked on "has artwork" alone, which took the control away from wraps
  // that never needed it locked. ONE expression, read by the lock and by the
  // renderer's own choice of path below.
  const artOnBody = noun === 'wrap';
  const artPinsFront = !!artInfo && !artOnBody;
  // 'auto' (the default) follows the PACK's declared display face; an explicit
  // pick from the selector still wins. A pinned-front pack takes that same
  // face — the printed front and the merchandised front are one face, so this
  // is the same value, not a second convention.
  const packFront = packFrontOrientation(geo);
  const frontO = (artPinsFront || shelf.front === 'auto') ? packFront : shelf.front;
  // rotate 90°/270° spins the FORWARD FACE in its own plane (about the depth
  // axis, like turning a framed picture on the wall) — the same face stays
  // toward the shopper, never a side or the back. So the two dims OF THAT FACE
  // swap: across (o[0]) ↔ up (o[2]); depth (o[1]) is unchanged. A non-square
  // face therefore lands a different width×height on the shelf at 90°/270°, so
  // the fill recomputes. The renderer spins each pack about the depth axis to
  // match. (This is NOT the vertical/lazy-Susan turn, which would swap
  // across/depth and rotate a side face into view.)
  // ...and the pack's declared UP on that face (meta.frontUp) is a quarter-turn
  // in exactly the same plane, so it simply ADDS to the user's rotation. It
  // applies only while the DECLARED face is the one being shown: on a face the
  // user picked by hand there is no declared up to honour, and Rotate is theirs
  // to set. One effective angle drives the fill and the render together.
  const baseRoll = faceUpRoll(frontO, geo.meta.frontFace,
                              frontO === packFront ? geo.meta.frontUp : null);
  const rotDeg = ((baseRoll + shelf.rot) % 360 + 360) % 360;
  const spun = (rotDeg % 180) !== 0;
  const fillO = spun ? frontO[2] + frontO[1] + frontO[0] : frontO;
  // fixed to the front-panel orientation — the shopper-facing face is the
  // user's choice, not a solver optimization; 'column' gives a clean aligned
  // grid to subset. x = facings (across), y = depth (back→front), z = stack.
  const arr = fitInto({outer: geo.outer, allowedOrientations: [fillO], styleId: geo.meta.style},
                      cavity, {wall: 0, between: 0}, 'column');
  const xs = [...new Set(arr.placements.map(p => shelfKey(p.x)))].sort((a, b) => a - b);
  const ys = [...new Set(arr.placements.map(p => shelfKey(p.y)))].sort((a, b) => a - b);
  const zs = [...new Set(arr.placements.map(p => shelfKey(p.z)))].sort((a, b) => a - b);
  const maxF = xs.length, maxD = ys.length, maxS = zs.length;
  const eff = (v, max) => (v === 'auto' || !(v >= 1)) ? max : Math.min(max, Math.round(v));
  const facings = eff(shelf.facings, maxF), stack = eff(shelf.stack, maxS), deep = eff(shelf.deep, maxD);
  // subset: `facings` columns, bottom stack, back-most `deep` rows (largest y —
  // the back wall sits at +depth), i.e. stocked from the back forward. The
  // facings BLOCK is centred on the shelf regardless of count: take the first
  // `facings` columns then shift every kept pack in x so the block's own centre
  // sits on the shelf centreline (x=0). One facing → centred; N → symmetric.
  const keptXs = xs.slice(0, facings);
  const blockCentre = (keptXs[0] + keptXs[keptXs.length - 1]) / 2;
  const keepX = new Set(keptXs.map(shelfKey));
  const keepZ = new Set(zs.slice(0, stack));
  const keepY = new Set(ys.slice(ys.length - deep));
  const placements = arr.placements
    .filter(p => keepX.has(shelfKey(p.x)) && keepZ.has(shelfKey(p.z)) && keepY.has(shelfKey(p.y)))
    .map(p => ({...p, x: p.x - blockCentre}));   // re-centre the facings block on the shelf
  const total = facings*stack*deep;

  // odFoot = the shelf footprint AFTER the in-plane spin (across = odFoot.l, up =
  // odFoot.h, depth = odFoot.w) — drives the readout and matches the grid fitInto
  // just laid on fillO. At 90°/270° across and up have swapped, so odFoot.l/h are
  // the transposed pair (odFoot.w/depth stays). odGeo = the pack's TRUE
  // front-facing dims (front face = odGeo.l × odGeo.h); buildShelf builds the box
  // from these and spins it about the depth axis by shelf.rot, so the same face
  // stays forward and its width×height on the shelf matches odFoot.
  const odFoot = orientDims(geo.outer, fillO);
  const odGeo = orientDims(geo.outer, frontO);
  return {noun, row, geo, artInfo, artOnBody, artPinsFront, frontO, rotDeg,
          placements, facings, stack, deep, total, maxF, maxD, maxS, odFoot, odGeo,
          fits: !!(maxF && maxD && maxS)};
}

/** The occupancy line both the single readout and the comparison table use. */
function shelfOccupancy(fill){
  const u = inputs.getUnit(), f = v => fmtLen(v, u);
  const pct = (a, b) => b > 0 ? Math.round(a/b*100) : 0;
  return {
    size: `${f(fill.facings*fill.odFoot.l)} × ${f(fill.deep*fill.odFoot.w)} × ${f(fill.stack*fill.odFoot.h)} ${u}`,
    widthPct: pct(fill.facings*fill.odFoot.l, shelf.width),
    heightPct: pct(fill.stack*fill.odFoot.h, shelf.height),
    depthPct: pct(fill.deep*fill.odFoot.w, shelf.depth)
  };
}

function refreshShelf(){
  if(view !== 'shelf') return;         // only compute while the shelf view is up
  if(compare.on){ refreshCompare(); return; }
  clearShelfBays(['single']);          // leaving compare disposes A and B
  const fill = shelfFill(build.project, selKey(), () => { if(view === 'shelf') refreshShelf(); });
  el('spUnit').textContent = fill.noun + 's';
  if(!fill.geo){
    el('shReadout').innerHTML = 'No sellable pack geometry for this chain.';
    showShelf(false);
    return;
  }
  el('shFront').disabled = fill.artPinsFront;
  el('shFront').title = fill.artPinsFront ? 'Front follows the uploaded artwork' : '';
  const occ = shelfOccupancy(fill);
  el('shReadout').innerHTML = fill.fits
    ? `<b>${fill.total}</b> ${fill.noun}${fill.total === 1 ? '' : 's'} on shelf<br>` +
      `${fill.facings} facings × ${fill.stack} high × ${fill.deep} deep` +
      `<div class="sp-util">occupies ${occ.size} ` +
      `(${occ.widthPct}% width · ${occ.heightPct}% height · ${occ.depthPct}% depth)</div>`
    : `<b>0</b> on shelf<div class="sp-util">the ${fill.noun} does not fit this shelf opening in the chosen orientation</div>`;

  // Cutaway: open ONLY the shopper-facing pack (its real contents), the rest
  // stay solid printed packs. The bundle carries the pieces/wraps to drill; it
  // resolves the SAME selected candidate as the sellable geo above, so the open
  // pack matches the facings around it.
  // ONE bundle for the shelf: the opened pack drills it, and the SOLID facings
  // are built from it too when the sellable pack is a filmed wrap (a pillow,
  // not a box — see shelf3d). Resolving it once means the facings and the
  // opened pack can never describe different packs.
  const needBundle = shelf.cutaway || fill.artOnBody;
  const bundle = needBundle ? hierarchyBundle() : null;
  // frontAxis travels WITH frontO: the orientation says which axis is the depth
  // axis, the axis alone says nothing about which of that axis's two faces is
  // the display face. Sending only the orientation is what pointed a wrapped
  // tray's open top at the back wall.
  // the sellable pack's RESOLVED geometry travels with the fill, so a shelf
  // renders display state when that container is set to it — one source, the
  // same object the dieline and the DXF read.
  const shelfOpts = {frontO: fill.frontO, frontAxis: fill.geo.meta.frontFace, packGeo: fill.geo,
    ...(shelf.cutaway ? {cutaway: true, bundle, noun: fill.noun} : {}),
    ...(fill.artOnBody ? {wrapBundle: bundle} : {})};
  buildShelf(fill.odGeo, shelf, fill.placements, true, fill.artInfo, fill.rotDeg, shelfOpts);
}

/* ---------- compare: two complete designs, two identical bays ------------
 * A is the live project. B is a SNAPSHOT deserialized out of a save slot —
 * its own object graph, its own artwork, its own rates — solved through the
 * same pure core functions and never through build.js's row cache or
 * selection, which belong to the live project alone. Nothing in this path
 * writes to the live project, and B is read-only by construction: to change
 * it you load it, edit it as the active project, and save it back.
 *
 * The bays are IDENTICAL: one shelf spec, applied twice. That is what keeps
 * the two counts directly comparable — each is a full-bay number, not a
 * half-bay number needing mental doubling.
 */
const BAY_GAP = 120;                        // mm of aisle between the two bays

function compareLoad(slotIndex){
  const st = save.loadFromSlot(slotIndex);
  if(!st || !st.project) return null;
  const meta = save.listSlots()[slotIndex - 1];
  return {project: st.project, name: (meta && meta.name) || `Slot ${slotIndex}`};
}

/** Design B's fill — resolved from ITS OWN project, with its own row, so no
 *  part of the live build state is consulted or written. */
function compareFillB(){
  if(!compare.project) return null;
  return shelfFill(compare.project, null, () => { if(view === 'shelf' && compare.on) refreshShelf(); });
}

function refreshCompare(){
  clearShelfBays(['A', 'B']);               // entering compare disposes the single bay
  const fillA = shelfFill(build.project, selKey(), () => { if(view === 'shelf') refreshShelf(); });
  const fillB = compareFillB();
  el('spUnit').textContent = fillA.noun + 's';
  // the front selector applies to BOTH bays (it is shelf-view state, not a
  // property of either design); 'auto' — the default — lets each design present
  // by its own declared face, which is the honest merchandising comparison.
  el('shFront').disabled = fillA.artPinsFront || (fillB && fillB.artPinsFront);
  el('shFront').title = el('shFront').disabled ? 'Front follows the uploaded artwork' : '';

  const span = Math.max(shelf.width*2 + BAY_GAP, shelf.depth, shelf.height)*0.62;
  const half = (shelf.width + BAY_GAP)/2;
  const build1 = (fill, id, offsetX, label) => {
    if(!fill || !fill.geo) return;
    const bundle = fill.artOnBody
      ? (id === 'A' ? hierarchyBundle() : hierarchyBundle(compare.project, fill.row))
      : null;
    buildShelf(fill.odGeo, shelf, fill.placements, true, fill.artInfo, fill.rotDeg, {
      frontO: fill.frontO, frontAxis: fill.geo.meta.frontFace, packGeo: fill.geo,
      ...(fill.artOnBody ? {wrapBundle: bundle} : {}),
      bayId: id, offsetX, label, camSpan: span
    });
  };
  // A on the shopper's LEFT, B on the right — reading order. The bay offset is
  // set on the group's position in the PIVOT's frame, so it is unaffected by
  // the group's own 180° turn: -x is screen-left from the shopper view
  // (measured, not assumed — the first draft put A on the right).
  build1(fillA, 'A', -half, `A · current`);
  build1(fillB, 'B', +half, `B · ${compare.name}`);
  showShelf(true);
  writeCompareReadout(fillA, fillB);
}

/** The comparison table — the point of the view. Every figure is read from the
 *  two fills and the two rows; none is recomputed here. */
function writeCompareReadout(a, b){
  const cell = f => {
    if(!f || !f.geo) return {head: '—', lines: ['no sellable pack']};
    const occ = shelfOccupancy(f);
    const c = f.row && f.row.cost;
    return {head: `<b>${f.total}</b> ${f.noun}${f.total === 1 ? '' : 's'}`,
      lines: [`${f.facings} × ${f.stack} high × ${f.deep} deep`,
              occ.size,
              `${occ.widthPct}% width · ${occ.heightPct}% height`,
              c && c.packCost != null ? `${fmtMoney(c.packCost)} / ${f.noun}` : 'cost —']};
  };
  const A = cell(a), B = cell(b);
  const rows = ['On shelf', 'Facings × stack × deep', 'Occupies', 'Utilisation', 'Material cost'];
  const va = [A.head, ...A.lines], vb = [B.head, ...B.lines];
  el('shReadout').innerHTML =
    `<div class="cmp"><div class="cmp-h cmp-sp">&nbsp;</div>` +
    `<div class="cmp-h">A · current</div><div class="cmp-h">B · ${compare.name}</div>` +
    rows.map((r, i) => `<div class="cmp-k">${r}</div><div class="cmp-v">${va[i]}</div><div class="cmp-v">${vb[i]}</div>`).join('') +
    `</div>`;
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
  el('trayFields').style.display = (kind === 'tray') ? 'contents' : 'none';
}

/* ---------- optional levels: enable/disable + the always-visible chain
 * string. secondary(carton)/tertiary(case) carry their own `enabled` flag;
 * wrap's is `primary.wrap !== null` (the existing pattern). A level's actual
 * parent is the next enabled level above it — resolveChainShape in
 * project.js is the single source for that fold; this file only surfaces
 * it (the toggle, the warning, the chain string), never re-derives it. --- */

const TIER_LABEL = {tray: 'tray', wrap: 'wrap', carton: 'carton', case: 'case'};

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
  if(level === 'tray') return `the ${contentNoun} will feed the ${isTierEnabled('wrap') ? 'wrap' : (isTierEnabled('carton') ? 'carton' : 'case')} directly, with no tray`;
  if(level === 'wrap') return `the ${isTierEnabled('tray') ? 'tray' : contentNoun} will feed the ${isTierEnabled('carton') ? 'carton' : 'case'} directly`;
  if(level === 'carton') return `the ${proj.primary.wrap ? 'wrap' : contentNoun} will feed the case directly`;
  if(level === 'case') return 'the carton will ride the pallet directly, with no case';
  return '';
}

function setTierEnabled(level, on){
  const proj = build.project;
  if(level === 'tray'){
    proj.tray.enabled = on;
    // "2 cells x 10 products per cell, on edge" is the specified default when
    // the tray is switched on. Per-cell belongs to the COLLATION, so this is a
    // write to that one owner — not a copy stored on the tray.
    if(on){
      proj.tray.nCells = 2;
      const c = proj.primary.collation;
      c.pieceOrientation = 'on-edge'; c.stackAxis = 'X';
      c.perStack = 10; c.nx = 1; c.ny = 1;
    }
  }
  else if(level === 'wrap') proj.primary.wrap = on ? newDefaultWrap() : null;
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
  // style tiers AND the tray (a non-style optional level) both get the toggle
  if(!CHAIN_OPTIONAL[activeLevel]){ host.innerHTML = ''; return; }
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
  if(k === 'tray'){
    if(!isTierEnabled('tray')) return '';
    const tr = proj.tray;
    return `${tr.nCells} cell${tr.nCells === 1 ? '' : 's'}`;
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
  if(k === 'tray')   return `${contentNoun} feeds ${isTierEnabled('wrap') ? 'wrap' : (isTierEnabled('carton') ? 'carton' : 'case')} directly`;
  if(k === 'wrap')   return `${isTierEnabled('tray') ? 'tray' : contentNoun} feeds ${isTierEnabled('carton') ? 'carton' : 'case'} directly`;
  if(k === 'carton') return `${proj.primary.wrap ? 'wrap' : contentNoun} feeds case directly`;
  if(k === 'case')   return 'carton rides the pallet directly';
  return '';
}

/** The always-visible, interactive chain strip (UAT #4/#5): every level as a
 *  clickable node showing its style; the active level highlighted; disabled
 *  optional tiers struck-through with an enable affordance; and each arrow
 *  after a skipped tier labeled with the re-point. Derived from the enabled
 *  chain, never hardcoded. Registered with recompute() (see notify block). */
const CHAIN_OPTIONAL = {tray: true, wrap: true, carton: true, case: true};
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
/** The 2D legend, per level kind. A legend is a CLAIM about what is on
 *  screen — the same rule the 3D HUD's swatches follow — and a multiview has
 *  no cut and no crease to name: the product and tray drawings are solid
 *  outlines, with the tray adding dashed HIDDEN detail (its drafted base and
 *  its cell troughs, seen through the wall). Written from the level by the
 *  same update that names the tab, so the two cannot disagree. */
const LEGEND_2D = {
  style:   [['var(--cut)', 'solid', 'Cut'], ['var(--crease)', 'dashed', 'Crease']],
  product: [['var(--ink)', 'solid', 'Outline']],
  // read off the drawing's OWN vocabulary, never a second list beside it
  tray:    TRAY_LINE_TYPES.map(t => [t.color, t.dash ? 'dashed' : 'solid', t.label]),
  pallet:  []
};

function update2dTabLabel(){
  const lvl = LEVELS[activeLevel];
  const word = lvl.kind === 'product' || lvl.kind === 'tray' ? 'Drawing'
    : lvl.kind === 'style' ? (activeStyle().structure === 'flexible' ? 'Blank' : 'Dieline')
    : 'Dieline';
  el('tab2d').textContent = `2D ${word}`;
  // AUX LAYERS append themselves. No layer is named here: auxLegendRows reads
  // the SAME style map render/auxlayers.js draws from, and returns a row only
  // for a layer actually PRESENT in this geometry's `aux`. So a legend can
  // neither claim a line the blank does not carry nor describe one the
  // renderer drew differently.
  const rows = (LEGEND_2D[lvl.kind] || []).concat(auxLegendRows(activeGeometry()));
  el('hud2dKeys').innerHTML = rows.map(([c, style, label]) =>
    `<span class="k"><span class="swatch" style="border-top-color:${c};border-top-style:${style}"></span>${label}</span>`
  ).join('');
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
    inputs.mountCountArrangement(el('plInCount'), 'pIn', linkFor(proj, 'tertiary'), 4, 3, 1, childNoun, projectChanged, true);
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
  const openTopNew = styleOpenTopDefault(newId);
  // carry the footprint the user set (L/W = design intent); carry H too UNLESS
  // the new style is open-top — a tray's WALL height is its own low design input,
  // not a closed box's enclosing height, so start it at the tray's own sensible
  // (low) default and let the user raise it to a full-height tray if they want.
  (openTopNew ? ['L', 'W'] : ['L', 'W', 'H']).forEach(k => { if(old[k] != null && nd[k] != null) nd[k] = old[k]; });
  lvl.setStyleId(proj, newId);
  lvl.setParams(proj, nd);
  lvl.setOptions(proj, styleOptionDefaults(newId));
  // openTop is a containment fact carried by the new style (the FEFCO 0300 tray
  // is open, a case is closed) — re-derive it on a style swap, exactly as the
  // load path does (persistence.js), so switching TO the tray stops the fit
  // check gating on height (open tray corrals footprint only) and switching
  // AWAY restores closed-box height constraint.
  if(lvl.setOpenTop) lvl.setOpenTop(proj, openTopNew);
  projectChanged();              // re-enumerate the chain: the Build rows the 3D/pallet read
                                 // must reflect the NEW style, not the stale old one
  setActiveLevel(activeLevel);   // re-derive brand/exports/rails/views from the new style
  save.scheduleAutosave(gatherSaveState);
}

/** Mount the active level into the rails. Style levels bind their style
 *  params (solved dims shown as derived); the product level mounts the
 *  collation editor; the pallet level uses the pallet fields already in the
 *  DOM. */
/** The cell dimensions the tray stage WOULD derive from the current product,
 *  so the tray rail can show them as placeholders behind an empty (auto)
 *  field. Read-only: this asks the same core module the chain uses, it never
 *  computes a second answer of its own. */
/** Apply a pasted Cookie-Tray share link to the tray level. Returns a short
 *  status string for the panel. Imported dimensions are PINNED (see
 *  parseTrayLink): the link describes a specific tray, and treating its
 *  omitted-because-default values as "auto" would rebuild a different one. */
function applyTrayLink(text){
  let parsed = null;
  try{ parsed = parseTrayLink(text); }catch(e){ return 'Could not read that link.'; }
  if(!parsed) return 'No Cookie-Tray parameters found in that link.';
  const tr = build.project.tray;
  tr.nCells = parsed.nCells;
  tr.params = {...parsed.params};
  // the product half, when present, writes the COLLATION — the one owner of
  // per-cell content — rather than being stored on the tray
  const pr = parsed.product, col = build.project.primary.collation;
  if(pr.productType === 'round' && pr.cookieDiameter > 0)
    col.piece = {kind: 'cylinder', diameter: pr.cookieDiameter,
                 thickness: pr.cookieThickness > 0 ? pr.cookieThickness : col.piece.thickness};
  else if(pr.productType === 'rectangle' && pr.productWidth > 0)
    col.piece = {kind: 'box', L: pr.productThickness || 90, W: pr.productWidth, H: pr.productHeight || 20};
  if(pr.qtyTotal > 0){
    const per = Math.max(1, Math.ceil(pr.qtyTotal/parsed.nCells));
    col.pieceOrientation = 'on-edge'; col.stackAxis = 'X';
    col.perStack = per; col.nx = 1; col.ny = 1;
  }
  projectChanged();
  mountActiveLevel();
  return `Applied ${parsed.keysFound.length} parameters — dimensions are pinned; reset a field to auto to re-derive.`;
}

/** THE three linked quantities — cells, products per cell, total — read by
 *  the Tray rail and the Product rail alike, so the two can never display
 *  different numbers. Derived from the only two STORED values there are:
 *  project.tray.nCells and the collation's own grid. */
function trayQuantities(){
  const proj = build.project;
  const cells = Math.max(1, Math.round((proj.tray && proj.tray.nCells) || 1));
  const perCell = Math.max(1, collate(proj.primary.collation).count);
  return {cells, perCell, total: cells*perCell};
}

/** THE rule for an edit to any of those three, from either rail.
 *  CELLS IS THE ANCHOR — it moves only when the user edits cells directly:
 *      total   -> cells hold, per-cell absorbs
 *      perCell -> cells hold, total follows
 *      cells   -> per-cell holds, total follows
 *  Total is DERIVED and now writable, which is not a third stored value: an
 *  edited total resolves to a per-cell and writes THAT. The collation owns
 *  per-cell, and its plan grid (nx x ny) is fixed here, so the run length
 *  (perStack) is the factor that absorbs the change — the same owner-write
 *  the rest of the collation rail uses.
 *
 *  ROUNDING: total/cells is not generally whole, and per-cell is itself a
 *  product, so the write is rounded to the nearest integer and every display
 *  reads the true value back from the SAME source (trayQuantities). 80 over
 *  3 cells stores per-cell 27 and the total reads 81 — a total the two
 *  factors cannot produce is never stored and never shown at rest. */
function applyTrayQuantity(field, value){
  const proj = build.project, tr = proj.tray, col = proj.primary.collation;
  const v = Math.max(1, Math.round(+value || 1));
  if(field === 'cells'){
    tr.nCells = v;                                    // per-cell untouched; total follows
  }else{
    const wantPer = field === 'total' ? v/Math.max(1, Math.round(tr.nCells || 1)) : v;
    const others = Math.max(1, col.nx*col.ny);
    col.perStack = Math.max(1, Math.round(wantPer/others));
  }
  projectChanged();                                   // the one notifier; no remount (keeps focus)
}

/** A Cookie-Tray link describing the tray currently on screen. */
function currentTrayLink(){
  const tray = activeTray();
  return tray ? buildTrayLink(build.project, tray) : null;
}

function trayAutoDims(){
  const tr = build.project.tray;
  if(!tr) return {};
  try{
    // THE derivation solveTrayStage uses, not a second copy of it: this readout
    // is what the rail offers as the "auto" value, so an expression of its own
    // here would let the displayed auto disagree with the tray actually built.
    // (It did: this held `env.W + 2*side` for the width, which a multi-stack
    // collation inflated by a whole product.)
    const {cellLen, cellWid} = trayAutoCells(build.project);
    const cellH = cellWid/2;                     // depth follows the auto width
    const ov = tr.params || {};
    const eff = k => (typeof ov[k] === 'number' ? ov[k] : ({cellLen, cellWid, cellH})[k]);
    return {cellLen, cellWid, cellH,
            pitch: eff('cellWid') + (typeof ov.divider === 'number' ? ov.divider
                                     : (typeof ov.wall === 'number' ? ov.wall : 3))};
  }catch(e){ return {}; }
}

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
    // the product 2 x 2 (orientation + piece shape) and its grouping counts
    // are ALWAYS visible — never gated on the chain (that hid On Edge).
    // Product is always the base: no disable, no content-type selector.
    // `project` lets the collation panel host the SHARED cell-count control
    // (a second control onto project.tray.nCells) and the derived total.
    inputs.mountProduct(proj.primary, {project: proj, quantities: trayQuantities,
                                      onQuantity: applyTrayQuantity, onInput: () => projectChanged()});
  }else if(lvl.kind === 'tray'){
    inputs.mountTray(proj, {autoDims: trayAutoDims(), remount: () => mountActiveLevel(),
                            // the three linked quantity fields: one derivation
                            // read, one rule written — shared with the Product rail
                            quantities: trayQuantities, onQuantity: applyTrayQuantity,
                            onImportLink: applyTrayLink, onExportLink: currentTrayLink,
                            onInput: () => projectChanged()});
  }else{
    // pallet: the fields are static DOM; ensure their unit chips are current
    writePalletFields();
  }
  mountCostRates();
}

/** The rate panel — GLOBAL, so it mounts alongside whichever level's rail is
 *  up rather than belonging to one. `rows` is the set of levels the chain
 *  actually has, so a project with no tray is never asked for a tray rate. */
function chainCostRows(){
  const proj = build.project;
  const rows = new Set(['pallet']);
  if(isTierEnabled('carton')) rows.add('carton');
  if(isTierEnabled('case')) rows.add('case');
  if(proj.primary && proj.primary.wrap) rows.add('film');
  if(isTierEnabled('tray')) rows.add('tray');
  return rows;
}
/**
 * The cost roll-up readout. Reads `row.cost` — the ONE cost the chain derived
 * with every other derived value — and formats it. Nothing here multiplies a
 * rate: if this function did its own arithmetic there would be two costs, and
 * the panel and the Build column would be free to disagree.
 *
 * Registered with the single recompute notifier, so a rate edit, a level
 * change and a candidate cycle all refresh it by the same path.
 */
/** The active level's own material cost — one carton, one case, one pack's
 *  film, one tray — as a rail stat, or '' when this level has no material
 *  term. Reads row.cost.perUnit; the multiplication happened once, in the
 *  chain, next to the quantity it used. */
function levelUnitCostStat(){
  const row = resolveActiveRow(build.project, build.getRounding(), selKey());
  const pu = row && row.cost && row.cost.perUnit;
  if(!pu) return '';
  const v = activeLevel === 'carton' ? pu.carton
    : activeLevel === 'case' ? pu.case
    : activeLevel === 'wrap' ? pu.film
    : activeLevel === 'tray' ? pu.tray : null;
  if(v == null) return '';
  const noun = activeLevel === 'wrap' ? 'film / pack' : `material / ${LEVELS[activeLevel].label.toLowerCase()}`;
  return `<div class="stat"><span class="lab">Cost · ${noun}</span><span class="val">${fmtMoney(v)}</span></div>`;
}

function refreshCost(){
  const host = el('costReadout');
  if(!host) return;
  const row = resolveActiveRow(build.project, build.getRounding(), selKey());
  const c = row && row.cost;
  if(!c || c.packCost == null){
    host.innerHTML = `<div class="stat"><span class="lab">Material cost</span><span class="val">—</span></div>`;
    return;
  }
  const {outerNoun} = describeChain(build.project);
  const packNoun = build.project.primary && build.project.primary.wrap ? 'pack' : 'unit';
  const stat = (lab, val) => `<div class="stat"><span class="lab">${lab}</span><span class="val">${val}</span></div>`;
  // the breakdown names which terms are actually in the number, so a chain
  // without a carton reads as "no carton term" rather than a silently cheaper pack
  const parts = c.terms.map(k => `${k} ${fmtMoney(c.perPack[k])}`).join(' · ');
  host.innerHTML =
    stat(`Material / ${packNoun}`, fmtMoney(c.packCost)) +
    stat(`Material / 1000 ${packNoun}s`, fmtMoney(c.per1000Packs)) +
    stat(`Material / ${outerNoun}`, fmtMoney(c.perCase)) +
    stat('Material / pallet (incl. trip)', fmtMoney(c.perPallet)) +
    `<div class="bnote">Per ${packNoun}: ${parts}` +
    (c.missing.length ? ` · not in this chain: ${c.missing.join(', ')}` : '') + '</div>';
}

function mountCostRates(){
  inputs.mountCost(build.project, {
    rows: chainCostRows(),
    remount: () => mountCostRates(),
    onInput: () => projectChanged()
  });
}

const LEVEL_BRAND = {
  product: {code: 'PRODUCT', sub: 'Product arrangement'},
  tray:    {code: 'TRAY',    sub: 'Thermoformed sizing tray'},
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
  // STL belongs to the tray alone: it is a 3D part, not a dieline. STEP stays
  // in Cookie-Tray (a B-rep format needs the kernel this app does not have).
  el('btnSTL').style.display = (activeLevel === 'tray' && isTierEnabled('tray')) ? '' : 'none';
  if(lvl.kind !== 'style'){
    el('btnDXF').disabled = true;
    el('btnDXF').title = lvl.kind === 'product'
      ? 'A product drawing is not a cut file — select Wrap, Carton, or Case for a dieline'
      : lvl.kind === 'tray'
      ? 'A thermoformed tray has no die — export the STL for the 3D part'
      : 'No dieline at this level — select Wrap, Carton, or Case';
    el('btnArt').style.display = 'none';
    el('btnSpec').style.display = 'none';
    setStateChip('muted', lvl.kind === 'product' ? 'Product view'
      : lvl.kind === 'tray' ? 'Tray view' : 'No dieline here');
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
  solidOverride = null;   // each level/depth re-picks its smart Solid/Cutaway default
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
  updateArtPanel();
  refreshSensitivity();      // pallet-level panel: show/hide + recompute for the new level
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
/** @param {Object} [proj] the project to describe — defaults to the live one.
 *  @param {Object} [rowIn] its already-resolved row; only a project that is NOT
 *  the live one supplies this, because build.js's row cache and selection
 *  belong to the live project alone. Passing another project's row through the
 *  live caches is exactly the contamination compare mode must not cause. */
function hierarchyBundle(proj = build.project, rowIn = null){
  let row;
  if(rowIn){
    row = applyPatternSelection(rowIn, proj);
  }else{
    const rows = build.getRows();
    // default to the freight-optimal row (max cartons/pallet) so the cascade
    // shows a representative case, not the first enumerated candidate
    const best = rows.reduce((a, b) => (b.cartonsPerPallet > (a ? a.cartonsPerPallet : -1) ? b : a), null);
    // the committed pallet-pattern pick applies here exactly as in
    // resolveActiveRow (the SAME project.js adjuster) — the rendered pallet
    // and the readout can never show different arrangements
    row = applyPatternSelection(build.getSelected() || best, proj);
  }
  if(!row || !row.arr) return null;
  const {cases, cartons, wraps, pieces} = row.arr;
  // the immediate-child-unit placements: `wraps` (the carton's own inner solve)
  // when the carton is an INNER tier, else `cartons` (the outermost tier's
  // childFit) — which already holds those same unit placements when the carton
  // is itself outermost (case disabled) OR is disabled entirely. Keying on
  // `wraps` presence, not on row.geo.carton, is what lets a carton-outermost
  // chain (case off) still render its wrap/pack contents.
  const wrapPlacements = wraps ? wraps.placements : cartons.placements;
  // per-pack-type art canvases ride the bundle itself, so EVERY consumer —
  // the hierarchy and the shelf — reads the same art from the same place.
  // This used to be bolted on by applyHierarchy after the fact, which meant
  // the shelf's bundle carried no art at all: the very gap that pushed the
  // shelf's printed facings onto their own forked geometry path.
  const art = {
    carton: artCanvasFor('carton', row.geo.carton, null, proj),
    case:   artCanvasFor('case', row.geo.case, null, proj),
    wrap:   artCanvasFor('wrap', row.geo.wrap, null, proj)
  };
  return {
    art,
    caseGeo: row.geo.case,
    cartonGeo: row.geo.carton,
    wrapGeo: row.geo.wrap,
    // the tray, when it is in the chain: its resolved params + envelope, so
    // the tray depth can render and the Dims overlay can label it
    tray: row.tray || null,
    // loadH/unitStackH are the CHAIN's own pallet load height and per-unit
    // stacking pitch (project.js chainMetrics), carried so the render stacks
    // and reports at the height the fit actually reserved instead of measuring
    // its own — which is what project.js exposes them for.
    cases: {placements: cases.placements, count: cases.count, deck: cases.deck,
            loadH: row.loadH, unitStackH: row.unitStackH},
    cartons: {placements: cartons.placements},
    wraps: (pieces && wrapPlacements) ? {
      placements: wrapPlacements, envelope: pieces.envelope, pieces: pieces.placements,
      // THE envelope the film was actually sized around — the wrap's own
      // inner, which the chain solved. With a tray in the chain this is the
      // TRAY, not the bare collation; the renderer must loft the pillow
      // around the same box the film was cut for.
      filmEnvelope: row.geo.wrap ? row.geo.wrap.inner : (row.tray ? row.tray.outer : pieces.envelope),
      // the per-CELL piece run, so the tray can load its cells from the one
      // collation rather than a second placement source
      cellPieces: pieces.placements,
      piece: pieces.piece, stackAxis: pieces.stackAxis, seals: pieces.seals,
      nx: pieces.nx, ny: pieces.ny,            // collation grid — used to detect a single round slug
      wrapAxis: pieces.wrapAxis                // resolved 'L'|'W' — the renderer's taper/fin axis
    } : null,
    counts: {
      cases: cases.count, cartonsPerCase: proj.links[0].count,
      wrapsPerCarton: wraps ? wraps.count : 0,
      piecesPerWrap: pieces ? pieces.placements.length : 0
    },
    // warehouse double-stack (two unit loads high): read from the ONE home,
    // project.pallet.stacking — the render draws the second deck+load and the
    // BCT doubles its column from this same flag
    doubleStack: !!(proj.pallet.stacking && proj.pallet.stacking.doubleStack)
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
  // the tray depth exists only while the tray is in the chain
  if(d === 'tray') return !!(bundle && bundle.tray);
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
  const hasCase = !!bundle.caseGeo;                     // pallet's outer unit is a case, else a carton
  const parts = [];
  if(depth === 'tray' && bundle.tray){
    const tr = bundle.tray, u = inputs.getUnit(), f = v => fmtLen(v, u);
    const o = tr.outer, own = tr.params.overallH;
    // the render draws the TRAY; the chain hands the wrap an envelope that also
    // covers any proud product. Say both, so the Dims number (the drawn part)
    // and the envelope can never look like a contradiction.
    return `Tray: ${tr.nCells} cell${tr.nCells === 1 ? '' : 's'} × ${tr.perCell} = ${tr.total} products` +
      ` · envelope ${f(o.L)} × ${f(o.W)} × ${f(o.H)} ${u}` +
      (tr.proud ? ` (product stands proud — tray itself is ${f(own)} ${u} tall)` : '') +
      // the stage says WHICH axis missed and why: a misfit here is usually a
      // collation the tray model cannot express (more than one stack across a
      // cell), not a mistyped dimension — "too wide" alone read as arithmetic,
      // and was shown even when it was the LENGTH that missed
      (tr.fits ? '' : ` · DOES NOT FIT — ${tr.misfitReason}`);
  }
  if(depth === 'pallet') parts.push(`Pallet: ${c.cases} ${hasCase ? 'cases' : 'cartons'}`);
  else if(depth === 'case') parts.push(`Case: ${c.cartonsPerCase} cartons`);
  else if(depth === 'carton') parts.push(`Carton: ${c.wrapsPerCarton} ${unit}${c.wrapsPerCarton === 1 ? '' : 's'}`);
  else if(depth === 'wrap') parts.push(`Wrap: ${c.piecesPerWrap} pieces`);
  else parts.push('Product: 1 piece');
  const chan = [];
  // pallet channel: which OUTER unit is opened (case if present, else carton),
  // read from the distinct 'pallet' selection key.
  if(depth === 'pallet') chan.push(`${hasCase ? 'case' : 'carton'} ${(opened.pallet ?? 0) + 1} of ${c.cases}`);
  if(hasCase && (depth === 'pallet' || depth === 'case')) chan.push(`carton ${(opened.carton ?? 0) + 1} of ${c.cartonsPerCase}`);
  if((depth === 'pallet' || depth === 'case' || depth === 'carton') && c.wrapsPerCarton)
    chan.push(`${unit} ${(opened.wrap ?? 0) + 1} of ${c.wrapsPerCarton}`);
  const capped = hier.artCappedCount ? hier.artCappedCount() : 0;
  const capNote = capped > 0 ? ` · ${capped} beyond the ${hier.ART_INSTANCE_CAP}-instance art cap render flat` : '';
  return parts.join(' · ') + (chan.length ? `. Opened: ${chan.join(', ')}` : '') + capNote;
}

function applyHierarchy(resetCam){
  el('m3fold').classList.remove('on');
  LEVEL_ORDER.forEach(d => el('d_' + d).classList.toggle('on', mode3d === 'hier' && activeLevel === d));
  if(view !== '3d') return;
  fold.stopFold(); fold.showBox(false); showWrapArt(false); showNest(false); showProduct(false);
  const bundle = hierarchyBundle();
  LEVEL_ORDER.forEach(d => el('d_' + d).disabled = !depthAvailable(bundle, d));
  if(!bundle){ hier.show(false); el('hierHud').style.display = 'none'; el('orbithint').textContent = 'configure a chain in Build first'; subjectDims.nest = null; return; }
  // per-pack-type art textures: one composed canvas per level, shared across
  // every instance of that pack by the renderer (art is a pack property, not
  // an instance property).
  // the active level IS the depth; if it isn't reachable for this config
  // (e.g. the case is the active level but has just been disabled), fall back
  // to the outermost depth that IS available — never a hardcoded 'case', which
  // is itself null when the case tier is off. Pallet is always available while
  // a chain resolves, so this find() never comes back empty.
  const depth = depthAvailable(bundle, activeLevel) ? activeLevel
    : ['case', 'carton', 'pallet'].find(d => depthAvailable(bundle, d));
  if(resetCam) fold.setOrbit(fold.HOME_ORBIT.rotX, fold.HOME_ORBIT.rotY, 1.35);   // oblique 3/4 view: see the cutaway channel + open top
  const solid = solidActive(depth, bundle);
  el('m3viewmode').style.display = '';                 // shown in hierarchy mode
  el('m3solid').classList.toggle('on', solid);
  el('m3cut').classList.toggle('on', !solid);
  const res = hier.buildHierarchy(bundle, depth, hierSel, solid);
  // at pallet depth, flag it so the Dims overlay splits the height (deck vs load)
  // palletMM is the TOTAL timber in the stack (drawDims splits H into
  // Pallet / Load / Total): two decks when double-stacked, so the second
  // deck is never mislabeled as load height.
  // It reads the CHAIN's own deck height (pallet.baseH — what the fit budgets
  // and what buildPallet stacks the load at), NOT palletmesh's PALLET_HEIGHT
  // constant. Those are two independent 127s coupled only by a comment, and
  // the split believed the wrong one: at baseH 140 the overlay read Pallet 254
  // / Load 2316 where the truth is 280 / 2290. Total was right either way,
  // which is why it went unnoticed — the error is a pure transfer between the
  // two component lines, nLoads x (baseH - 127).
  const deckMM = (bundle.cases && bundle.cases.deck && typeof bundle.cases.deck.baseH === 'number')
    ? bundle.cases.deck.baseH : PALLET_HEIGHT;
  subjectDims.nest = res.outer ? (depth === 'pallet' ? {...res.outer, palletMM: deckMM*(bundle.doubleStack ? 2 : 1)} : res.outer) : null;
  hier.show(true);
  el('orbithint').textContent = solid
    ? 'drag orbit · right-drag pan · scroll zoom · Solid — artwork on every face'
    : 'drag orbit · right-drag pan · scroll zoom · click a unit to open it';
  el('hierHud').style.display = 'block';
  el('hierHud').textContent = hudText(bundle, res.opened, depth);
  renderLegend(bundle, depth, solid);
  drawDims();
}

/** Legend naming every coloured element, plus (at wrap depth) the seal
 *  compensation read straight off the model geometry. */
function renderLegend(bundle, depth, solid){
  // A swatch is a claim about what is on screen. Solid draws a CLOSED pack —
  // plain unprinted film, no seal colouring — so naming the cutaway's film and
  // seal colours there would caption colours the render does not contain.
  const swatches = LEGEND
    .filter(l => solid ? !l.cutaway : !l.solid)
    .filter(l => bundle.wrapGeo || (l.name !== 'Film' && l.name !== 'Unprinted film' && !l.name.includes('seal')))
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
    // end-seal ANGLE readout — jaw clearance, the pack-length RANGE, and film
    // area, all read from the wrap style's meta.seal / meta.film. This whole
    // function re-runs on every recompute (the hier3d refresher), so the
    // numbers update live as the two angle sliders drag.
    const s = bundle.wrapGeo.meta.seal, film = bundle.wrapGeo.meta.film;
    if(s){
      const band = s.packLengthMax - s.packLengthAtAngle;
      readout += `<div class="rd">` +
        `End seals — internal ${Math.round(s.internalAngle)}° (film ramp) · external ${Math.round(s.externalAngle)}° (seal lay)<br>` +
        `Jaw clearance ${f(s.jawClearance)} ${u} / end — the flat crimp starts this far off the product (never flush)<br>` +
        `Pack length ${f(s.packLengthAtAngle)} ${u} at this lay — the carton is sized to THIS<br>` +
        `If the seal stands (90°): ${f(s.packLengthMax)} ${u} — reference tolerance +${f(band)} ${u}, does not resize the carton<br>` +
        `Film area ${(film.filmAreaM2*1e6).toFixed(0)} mm²/pack (${film.filmAreaM2.toFixed(4)} m²) — grows with a shallower ramp</div>`;
    }
  }
  el('hierLegend').innerHTML = swatches + readout;
  el('hierLegend').style.display = 'flex';
}

function applyFoldMode(){
  el('m3fold').classList.add('on');
  ['product', 'wrap', 'carton', 'case', 'pallet'].forEach(d => el('d_' + d).classList.remove('on'));
  if(view !== '3d') return;
  hier.show(false); el('hierHud').style.display = 'none'; el('hierLegend').style.display = 'none';
  el('m3viewmode').style.display = 'none';   // Solid/Cutaway is a hierarchy-mode control
  el('orbithint').textContent = 'drag orbit · right-drag pan · scroll zoom';
  refresh3d();   // owns box vs. artwork-cladding visibility
  if(activeStyle().structure === 'flexible') fold.jumpClosed();
  else fold.startFold();
  drawDims();   // refresh the callout numbers now; the frame loop reprojects them
}

// product/pallet have no fold — they only exist in the nest cascade, so a
// fold request on those levels falls through to the hierarchy
function apply3dMode(){ if(mode3d === 'fold' && isStyleLevel()) applyFoldMode(); else applyHierarchy(true); updateCandidateCycle(); }

/** The 3D build-candidate cycle arrows. Visible only at case/pallet hierarchy
 *  depth (where a case-candidate list exists); hidden elsewhere. Shows the
 *  ON-SCREEN candidate's place in the Build table's CURRENT sort ("N of M") plus
 *  its identity, and disables an arrow at each end (no wrap). build.getCycleState
 *  and build.stepCandidate read/step the SAME sortedRows() the table renders, so
 *  arrows, table highlight and committed build never disagree. Registered as
 *  build's cycle listener (fires on every table render — recompute, re-sort,
 *  row-click, step) AND called here on view/depth change. */
function updateCandidateCycle(){
  const seg = el('candCycle');
  const show = view === '3d' && mode3d === 'hier' && (activeLevel === 'case' || activeLevel === 'pallet');
  // ONE pair of arrows, two ranked lists by depth: case depth cycles the
  // Build table's case candidates; pallet depth cycles the active row's
  // pallet-PATTERN candidates (the same list chainMetrics ranked — no
  // parallel list). Both read/step through build.js, both clamp, no wrap.
  const pal = activeLevel === 'pallet';
  const {pos, total, label} = pal ? build.getPatternCycleState() : build.getCycleState();
  if(!show || total < 1){ seg.style.display = 'none'; return; }
  seg.style.display = 'flex';
  const t = pal ? 'pallet pattern (ranked by cartons/pallet)' : 'build candidate (current sort)';
  el('candPrev').title = `Previous ${t}`;
  el('candNext').title = `Next ${t}`;
  el('candPos').textContent = `${pos} of ${total}`;
  el('candKey').textContent = label;
  el('candPrev').disabled = pos <= 1;
  el('candNext').disabled = pos >= total;
}

/* ---------- Dims overlay: L×W×H callouts on the active component ---------- */

// which cached subject box the CURRENT view annotates — mirrors exactly what
// apply3dMode/setView chose to render, so the callouts never label a component
// other than the one on screen (fold falls through to the nest for product/
// pallet, just like the render does).
function currentDimsBox(){
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
  el('tabShelf').classList.toggle('on', v === 'shelf');
  el('tabBuild').classList.toggle('on', v === 'build');
  const canvas = v === '3d' || v === 'shelf';
  el('svgWrap').style.display   = v === '2d' ? 'flex' : 'none';
  el('cvWrap').style.display    = canvas ? 'block' : 'none';
  el('buildWrap').style.display = v === 'build' ? 'block' : 'none';
  el('hud').style.display       = v === '2d' ? 'flex' : 'none';
  el('orbithint').style.display = canvas ? 'block' : 'none';
  el('mode3d').style.display    = v === '3d' ? 'flex' : 'none';
  el('modeShelf').style.display = v === 'shelf' ? 'flex' : 'none';
  el('shelfPanel').style.display = v === 'shelf' ? 'block' : 'none';
  if(v === 'shelf') refreshCompareControl();   // slots may have changed since last time
  updateArtPanel();
  // the title block is a drawing-sheet overlay — the Build view is a table,
  // not a sheet, so hide it there (it would float over the candidate table).
  // The view toolbar STAYS (it holds the tabs — the only way back out of Build).
  el('titleBlock').style.display = v === 'build' ? 'none' : '';
  // the ViewCube mirrors the SAME shared camera the hierarchy/fold/shelf views
  // use (fold3d.js's single orbit) — it works at every 3D depth (product…pallet)
  // and in FOLD mode for free, since none of that is camera-specific.
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
      // Home returns each view to its OWN natural angle — for the shelf that's
      // the shopper 3/4, its entry default; every other canvas view uses the
      // shared isometric home.
      el('viewCubeHome').addEventListener('click', () => {
        const home = (view === 'shelf') ? SHELF_ORBIT : fold.HOME_ORBIT;
        fold.tweenOrbit(home.rotX, home.rotY);
        fold.resetPan();                          // Home recentres the pan too
      });
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
      apply3dMode();
    }else{   // shelf
      fold.showBox(false); showWrapArt(false); showNest(false); showProduct(false); hier.show(false);
      fold.stopFold();
      fold.setOrbit(SHELF_ORBIT.rotX, SHELF_ORBIT.rotY, SHELF_ORBIT.span);
      el('orbithint').textContent = 'drag orbit · right-drag pan · scroll zoom · front panels face you';
      refreshShelf();
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
  const {L, W, maxH, baseH} = inputs.readPallet();
  build.project.pallet.L = L; build.project.pallet.W = W; build.project.pallet.maxH = maxH;
  // deck height drives FOUR things — the fit's height budget, where the load
  // rests, the Dims Pallet/Load split, and the drawn timber — so it has one
  // writer here like every other pallet field. 0/blank keeps the last good
  // value rather than collapsing the deck mid-typing.
  if(baseH > 0) build.project.pallet.baseH = baseH;
  syncBaseHNote();
  // switching pattern FAMILY re-filters the ranked list, so a held index
  // would silently point at an unrelated layout — restart at the family's
  // best. (Deck/height edits keep the index; the clamp absorbs shrinkage.)
  if(el('palPattern').value !== build.project.pallet.pattern) build.project.pallet.patternIndex = 0;
  build.project.pallet.pattern = el('palPattern').value;
  // stacking (BCT) inputs -> project.pallet.stacking (one writer)
  const st = build.project.pallet.stacking || (build.project.pallet.stacking = {});
  st.ect = Math.max(0, +el('bctEct').value || 0);
  st.unitWeightLb = Math.max(0, +el('bctWeight').value || 0);
  st.target = Math.max(0, +el('bctTarget').value || 0);
  st.doubleStack = el('bctDouble').checked;
}
/** Write project.pallet back into the pallet rail fields (after a load). */
/** Warn at the mesh's faithful-shape boundary rather than drawing something
 *  that misrepresents the pallet. Below MIN_FAITHFUL_DECK_H the timber can no
 *  longer be fixed boards + a fork notch, so it degrades to a proportional
 *  miniature — say so instead of letting the render imply a real fork opening
 *  that isn't there. The value is still honoured; this is a note, not a clamp:
 *  the chain's arithmetic is exact at any height. */
function syncBaseHNote(){
  const n = el('palBaseHNote');
  if(!n) return;
  const h = build.project.pallet.baseH ?? PALLET_HEIGHT;
  const below = h < MIN_FAITHFUL_DECK_H;
  n.style.display = below ? '' : 'none';
  if(below) n.textContent =
    `Below ${fmtLen(MIN_FAITHFUL_DECK_H, inputs.getPalUnit())} ${inputs.getPalUnit()} the timber is drawn as a scaled miniature — ` +
    `boards and fork opening no longer at real proportions. The load height and fit are unaffected.`;
}

function writePalletFields(){
  const p = build.project.pallet, pu = inputs.getPalUnit();
  const fmtP = v => pu === 'mm' ? Math.round(v).toString() : (+v.toFixed(3)).toString();
  el('pal').value = `${fmtP(fromMM(p.L, pu))} x ${fmtP(fromMM(p.W, pu))}`;
  el('palMaxH').value = fmtP(fromMM(p.maxH, pu));
  el('palBaseH').value = fmtP(fromMM(p.baseH ?? PALLET_HEIGHT, pu));
  el('palPattern').value = p.pattern;
  syncBaseHNote();
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
['pal', 'palMaxH', 'palBaseH', 'bctEct', 'bctWeight', 'bctTarget'].forEach(id => el(id).addEventListener('input', onPalletEdited));
['palPattern', 'bctDouble'].forEach(id => el(id).addEventListener('change', onPalletEdited));

el('units').addEventListener('change', () => {
  if(!inputs.switchUnits()) return;
  mountActiveLevel();                       // rail fields re-displayed in the new unit (values live in the project)
  writeShelfFields();                       // the shelf panel reads the same unit source — re-display it too
  build.onUnitsChanged(inputs.getUnit());   // recomputes + notifies every registered consumer
});
el('palUnits').addEventListener('change', () => {
  if(inputs.switchPalUnits()) refreshPal();   // pallet dims re-display; keep the readout in sync
});

// STL export: the tray mesh's own triangles, built from the SAME ported
// dimensions the envelope comes from. No CAD kernel — STL is a triangle soup.
el('btnSTL').addEventListener('click', () => {
  const tray = activeTray();
  if(!tray){ showNotice('Enable the tray to export it.', true); return; }
  const {group} = buildTray3d(tray.params);
  const text = trayToSTL(group, 'cookie-tray');
  const blob = new Blob([text], {type: 'model/stl'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'cookie-tray.stl';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

el('tab2d').addEventListener('click', () => setView('2d'));
el('tab3d').addEventListener('click', () => setView('3d'));
el('tabShelf').addEventListener('click', () => setView('shelf'));
el('tabBuild').addEventListener('click', () => setView('build'));
// the "which candidate row" label (pallet readout) jumps to the Build table
el('palRowLabel').addEventListener('click', () => setView('build'));

/* ---------- retail shelf controls: view-local state, live-update the fill --- */
el('shFront').innerHTML = FRONT_PANELS.map(f => `<option value="${f.v}">${f.label}</option>`).join('');
// shelf dims live in mm (like every project value); they DISPLAY and READ in
// the app's current unit — the SAME single source (inputs.getUnit + core/units)
// every other field uses, so a units switch reaches them too. writeShelfFields
// is re-run on that switch, exactly like the rail's mountActiveLevel.
function writeShelfFields(){
  const u = inputs.getUnit();
  el('shWidth').value  = fmtInputValue(fromMM(shelf.width, u), u);
  el('shDepth').value  = fmtInputValue(fromMM(shelf.depth, u), u);
  el('shHeight').value = fmtInputValue(fromMM(shelf.height, u), u);
  const step = u === 'in' ? '0.25' : '10';
  ['shWidth', 'shDepth', 'shHeight'].forEach(id => el(id).step = step);
  el('uShW').textContent = el('uShD').textContent = el('uShH').textContent = u;
  el('shFront').value = shelf.front;
  el('shRotVal').textContent = shelf.rot + '°';
  el('shFacings').value = shelf.facings === 'auto' ? '' : shelf.facings;
  el('shStack').value = shelf.stack === 'auto' ? '' : shelf.stack;
  el('shDeep').value = shelf.deep === 'auto' ? '' : shelf.deep;
}
writeShelfFields();
// read the field back to mm through the current unit (input is in that unit)
const shelfDim = (v, fb) => { const n = toMM(+v, inputs.getUnit()); return Number.isFinite(n) && n >= 1 ? n : fb; };
const shelfCount = raw => raw.trim() === '' ? 'auto' : Math.max(1, Math.round(+raw) || 1);
el('shWidth').addEventListener('input',  () => { shelf.width  = shelfDim(el('shWidth').value,  shelf.width);  refreshShelf(); });
el('shDepth').addEventListener('input',  () => { shelf.depth  = shelfDim(el('shDepth').value,  shelf.depth);  refreshShelf(); });
el('shHeight').addEventListener('input', () => { shelf.height = shelfDim(el('shHeight').value, shelf.height); refreshShelf(); });
el('shFront').addEventListener('change', () => { shelf.front = el('shFront').value; refreshShelf(); });
// each click turns the pack 90° in plan: 0→90→180→270→0. Shelf-local only —
// it never touches the upstream carton/case design, just how the pack sits here.
el('shRotate').addEventListener('click', () => { shelf.rot = (shelf.rot + 90) % 360; el('shRotVal').textContent = shelf.rot + '°'; refreshShelf(); });
el('shFacings').addEventListener('input', () => { shelf.facings = shelfCount(el('shFacings').value); refreshShelf(); });
el('shStack').addEventListener('input',   () => { shelf.stack   = shelfCount(el('shStack').value);   refreshShelf(); });
el('shDeep').addEventListener('input',    () => { shelf.deep    = shelfCount(el('shDeep').value);    refreshShelf(); });
// Shelf Solid / Cutaway — mirrors the hierarchy toggle. Cutaway opens ONLY the
// shopper-facing pack (its real contents); every other facing stays solid.
const setShelfCut = on => { shelf.cutaway = on; el('shSolid').classList.toggle('on', !on); el('shCut').classList.toggle('on', on); if(view === 'shelf') refreshShelf(); };
el('shSolid').addEventListener('click', () => setShelfCut(false));
el('shCut').addEventListener('click',   () => setShelfCut(true));

/* ---------- compare: enter/exit, and the slot picker ----------
 * Deliberately two controls, not a mode system: pick a slot, press Compare;
 * press it again to go back. Empty slots disable the button rather than
 * failing on click. */
function refreshCompareControl(){
  const sel = el('shCmpSlot'), btn = el('shCompare');
  const slots = save.listSlots();
  const cur = compare.on ? String(compare.slot) : (sel.value || '');
  sel.innerHTML = slots.map(o =>
    `<option value="${o.index}"${String(o.index) === cur ? ' selected' : ''}${o.name ? '' : ' disabled'}>` +
    `${o.index}. ${o.name || '(empty)'}</option>`).join('');
  const filled = slots.filter(o => o.name);
  if(!filled.length){
    sel.innerHTML = '<option>no saved designs</option>';
    sel.disabled = true; btn.disabled = true;
    btn.title = 'Save a design to a slot first — B is a saved snapshot';
    return;
  }
  sel.disabled = compare.on;                      // B is fixed while comparing
  if(!slots[+sel.value - 1] || !slots[+sel.value - 1].name) sel.value = String(filled[0].index);
  btn.disabled = false;
  btn.title = compare.on ? 'Back to the single shelf' : 'Show this saved design beside the current one';
  btn.textContent = compare.on ? 'Exit compare' : 'Compare';
  btn.classList.toggle('on', compare.on);
}
el('shCmpSlot').addEventListener('change', refreshCompareControl);
el('shCompare').addEventListener('click', () => {
  if(compare.on){
    compare.on = false; compare.project = null; compare.slot = null; compare.name = '';
  }else{
    const i = +el('shCmpSlot').value;
    const loaded = compareLoad(i);
    if(!loaded){ showNotice('That slot is empty — save a design to it first.', true); return; }
    // B is a SNAPSHOT: its own deserialized object graph, never a reference
    // into the live project, so no edit on either side can reach the other.
    compare.on = true; compare.slot = i; compare.project = loaded.project; compare.name = loaded.name;
  }
  refreshCompareControl();
  refreshShelf();
});
el('m3fold').addEventListener('click', () => { if(!FOLD_VIEW_ENABLED) return; mode3d = 'fold'; apply3dMode(); });
// hide the Fold toggle while the feature is flagged off (its whole seg row) —
// the code path stays, only the entry point is removed
if(!FOLD_VIEW_ENABLED){ const seg = el('m3fold').closest('.seg'); if(seg) seg.style.display = 'none'; }
// Solid / Cutaway override (hierarchy mode). Sets a sticky override that holds
// until the depth/level or the artwork changes (which reset to the smart default).
el('m3solid').addEventListener('click', () => { solidOverride = true;  if(view === '3d' && mode3d === 'hier') applyHierarchy(false); });
el('m3cut').addEventListener('click',   () => { solidOverride = false; if(view === '3d' && mode3d === 'hier') applyHierarchy(false); });
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
    // set the picked tier and clear deeper tiers so they default under it.
    // 'pallet' is the outermost selection (which case/carton is opened ON the
    // pallet) — distinct from the inner 'carton' key so the two never collide.
    const order = ['pallet', 'case', 'carton', 'wrap'];
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

/* ---------- artwork panel wiring ---------- */
el('btnArtTplSvg').addEventListener('click', () => { const g = activeGeometry(); if(g) downloadArtwork(g, inputs.getUnit()); });
el('btnArtTplPng').addEventListener('click', () => { const g = activeGeometry(); if(g) downloadArtworkPNG(g, inputs.getUnit()); });
el('btnArtUpload').addEventListener('click', () => el('artFileInput').click());
el('artFileInput').addEventListener('change', async () => {
  const file = el('artFileInput').files && el('artFileInput').files[0];
  el('artFileInput').value = '';                      // allow re-selecting the same file
  if(!file) return;
  const btn = el('btnArtUpload'); const label = btn.textContent; btn.textContent = 'Reading…'; btn.disabled = true;
  try{
    const rec = await loadArtworkFile(file);
    build.project.artwork[activeLevel] = {...rec, ...defaultFit()};
    afterArtChange();
    showNotice(`Artwork mapped onto the ${LEVELS[activeLevel].label.toLowerCase()} — ${rec.natW}×${rec.natH}px, stored downscaled at ${Math.round(rec.bytes/1024)} KB in the save file.`, false);
  }catch(e){
    showNotice(`Couldn't read that image: ${e.message}`, true);
  }finally{ btn.textContent = label; btn.disabled = false; }
});
el('artFit').addEventListener('change', () => editArt({fit: el('artFit').value}));
el('artDx').addEventListener('input', () => editArt({dx: +el('artDx').value || 0}));
el('artDy').addEventListener('input', () => editArt({dy: +el('artDy').value || 0}));
el('artScale').addEventListener('input', () => editArt({scale: Math.max(1, +el('artScale').value || 100)/100}));
el('btnArtRemove').addEventListener('click', () => {
  delete build.project.artwork[activeLevel];
  clearWrapArt();
  afterArtChange();
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
  const suffix = isStyleLevel() ? (activeStyle().structure === 'flexible' ? 'blank' : 'dieline')
    : LEVELS[activeLevel].kind === 'tray' ? 'tray' : 'product';
  downloadSvgPNG(el('svg'), `${pngBaseName()}_${suffix}.png`);
});
// 3D: exactly the on-screen camera (fold3d reads its own canvas; the ViewCube
// is a separate renderer, never composited in).
el('btnPng3d').addEventListener('click', () => {
  const url = fold.capturePNG(2);
  if(url) savePNG(url, `${pngBaseName()}_${activeLevel}_3d.png`);
});

/* ---------- stage background: Grid (default) or White ----------
 * A view preference like the camera, never project state. It lives on the
 * renderer as its clear colour (fold3d.setStageBackground) — the ONE
 * mechanism the on-screen toggle and the PDF capture share — and scene
 * rebuilds never touch the clear colour, so it survives every recompute
 * without registering with the notifier. Grid stays the default: it is a
 * scale reference in a design tool, not decoration. */
function setStageBg(mode){
  fold.setStageBackground(mode);
  const on = fold.getStageBackground();
  for(const [g, w] of [['bgGrid', 'bgWhite'], ['shBgGrid', 'shBgWhite']]){
    el(g).classList.toggle('on', on === 'grid');
    el(w).classList.toggle('on', on === 'white');
  }
}
['bgGrid', 'shBgGrid'].forEach(id => el(id).addEventListener('click', () => setStageBg('grid')));
['bgWhite', 'shBgWhite'].forEach(id => el(id).addEventListener('click', () => setStageBg('white')));

/* ---------- pallet summary PDF ----------
 * Three print-resolution views on a white ground + the key numbers, one
 * portrait letter page. The sheet READS the resolved row and the project —
 * the same sources every readout uses — and never computes a dimension of
 * its own: a second computation on a report sheet is exactly where the
 * pallet height and the cell length bugs hid.
 *
 * Captures use fold3d's captureOrbitPNG with the stage background set to
 * white through the SAME setStageBackground the toggle uses (then restored
 * to whatever the user had). Cameras are fixed per view, not the on-screen
 * camera — that is what separates this from the 3D PNG button. */
function exportPalletPdf(){
  const row = resolveActiveRow(build.project, build.getRounding(), selKey());
  const outerNoun = describeChain(build.project).outerNoun;
  if(!row || !row.geo || !row.geo[outerNoun] || !(row.casesPerPallet > 0)){
    showNotice('No pallet result to export — the current chain does not palletize.', true);
    return;
  }
  const bundle = hierarchyBundle();
  if(!bundle){ showNotice('No pallet result to export.', true); return; }
  if(!fold.isInit()) fold.init3d(el('cvWrap'));

  const u = inputs.getUnit(), f = v => fmtLen(v, u);
  const pal = build.project.pallet;
  const nLoads = (pal.stacking && pal.stacking.doubleStack) ? 2 : 1;
  const deckH = pal.baseH ?? 127;

  const prevBg = fold.getStageBackground();
  fold.setStageBackground('white');
  // set the orbit, sync the camera with a throwaway 8px capture, THEN build:
  // the cutaway's default open channel is chosen at build time from the
  // camera's near corner, and the camera only moves on a frame.
  // dist scales the frame: buildHierarchy sets camSpan to the subject's max
  // extent, so dist < 1.35 zooms in. The top view frames on the FOOTPRINT
  // (from overhead the load height contributes nothing, and a tall load left
  // the plan view small in the middle of its panel); the cutaway sits a
  // touch tighter than the iso because a single case fills its panel poorly
  // at pallet framing.
  const shot = (depth, solid, rx, ry, w, h, distOf, fovDeg) => {
    fold.captureOrbitPNG(rx, ry, 1.35, 8, 8);
    const res = hier.buildHierarchy(bundle, depth, {}, solid);
    const d = distOf ? distOf(res) : 1.35;
    return {data: fold.captureOrbitPNG(rx, ry, d, w, h, 0.92, fovDeg), w, h};
  };
  /* THE PLAN VIEW is a plan OF THE PALLET, so the pallet has to be in it.
   * Two things were stopping that, and both are here:
   *
   *  1. PERSPECTIVE. At the normal 38° lens a 1.4m load seen from overhead is
   *     magnified against the deck a metre below it, and covers a pallet only
   *     3% wider than itself completely — measured, the deck contributed ZERO
   *     pixels to this panel. PLAN_FOV narrows the lens (the capture scales
   *     the distance to keep the framing), which compresses that divergence
   *     toward the orthographic projection a plan is supposed to be.
   *  2. FRAMING. The old factor sized the frame to the deck edge-to-edge, so
   *     even once visible the deck's own border would sit exactly on the frame
   *     edge. PLAN_MARGIN leaves room, and the target now accounts for the
   *     PANEL's aspect: which axis binds depends on whether the deck is wider
   *     or deeper than the panel, and a deep-and-narrow pallet would have been
   *     cropped by the old max(L, W). */
  const PLAN_W = 1032, PLAN_H = 920;
  const PLAN_FOV = 2.2;                 // degrees — a long lens, not a new camera
  const PLAN_MARGIN = 1.16;             // room around the deck, so its edge is inside the frame
  const PLAN_FILL = 0.78;               // the factor that frames a footprint edge-to-edge
  const planTarget = Math.max(pal.L, pal.W*(PLAN_W/PLAN_H));
  const HOME = fold.HOME_ORBIT;
  let images;
  try{
    images = {
      iso: shot('pallet', true, HOME.rotX, HOME.rotY, 1344, 1200),  // ~290 dpi placed
      top: shot('pallet', true, Math.PI/2, 0, PLAN_W, PLAN_H,
                res => PLAN_FILL*PLAN_MARGIN*planTarget/(res.span || 1), PLAN_FOV),
      cut: shot(bundle.caseGeo ? 'case' : 'carton', false, HOME.rotX, HOME.rotY, 1032, 920,
                () => 0.85)
    };
  } finally {
    fold.setStageBackground(prevBg);
    // put the on-screen scene back for whatever view is actually up
    if(view === '3d') apply3dMode();
    else if(view === 'shelf') refreshShelf();
    else hier.show(false);
  }
  if(!images.iso.data || !images.top.data || !images.cut.data){
    showNotice('3D capture failed — open the 3D view once and retry.', true);
    return;
  }

  const dims = o => `${f(o.L)} × ${f(o.W)} × ${f(o.H)} ${u}`;

  const sections = [];
  // CARTON — only when the tier is in the chain (label/omit, never blanks)
  if(build.project.secondary.enabled !== false && row.geo.carton){
    const rows = [['Outside dimensions', dims(row.geo.carton.outer)]];
    if(outerNoun === 'case'){
      rows.push(['Per case', `${row.cartonsPerCase}`]);
      rows.push(['Per pallet', `${row.cartonsPerPallet}`]);
    }else{
      rows.push(['Per pallet', `${row.casesPerPallet}`]);   // carton IS the outer tier
    }
    sections.push({label: 'Carton', rows});
  }
  // CASE / outer shipper — row.casesPerPallet counts the OUTERMOST tier,
  // exactly what the pallet readout shows
  if(outerNoun === 'case' && row.geo.case){
    sections.push({label: 'Case', rows: [
      ['Outside dimensions', dims(row.geo.case.outer)],
      ['Per pallet', `${row.casesPerPallet}`]
    ]});
  }
  // PERFORATION — one block, text only, nothing here feeds a calculation.
  // Emitted only when a level actually carries one, so an unperforated
  // project's sheet is byte-identical to the one it produced before perf
  // existed. Rows come from core/perf.js already formatted, so the sheet
  // cannot round a number differently from the readout, and the openability
  // warning rides along: a spec sheet that reads clean for a pack that will
  // not open is worse than no spec sheet.
  const perfLevels = [['case', 'tertiary'], ['carton', 'secondary']]
    .filter(([lvl, key]) => row.geo[lvl] && row.geo[lvl].perf);
  if(perfLevels.length){
    const rows = [];
    for(const [lvl, key] of perfLevels){
      const pre = perfLevels.length > 1 ? `${lvl[0].toUpperCase()}${lvl.slice(1)} · ` : '';
      for(const [k, v] of perfSpecRows(row.geo[lvl], build.project[key].perf, q => `${fmtLen(q, u)} ${u}`))
        rows.push([pre + k, v]);
    }
    sections.push({label: 'Perforation', rows});
  }
  sections.push({label: 'Pallet', rows: [
    ['Load (on deck)', `${f(pal.L)} × ${f(pal.W)} × ${f(row.loadH*nLoads)} ${u}`],
    ['Overall (incl. deck)', `${f(pal.L)} × ${f(pal.W)} × ${f(nLoads*(deckH + row.loadH))} ${u}`]
  ]});

  const bytes = buildPalletPdf({
    dateStr: dateStamp(), unit: u, images,
    captions: {iso: 'Pallet · isometric', top: 'Layer pattern on the pallet · plan',
               cut: `${outerNoun} cutaway`},
    sections
  });
  const filename = `PALLET_${f(pal.L)}x${f(pal.W)}_${u}_summary.pdf`;
  // cancelable so a test can read the exported bytes instead of downloading
  if(document.dispatchEvent(new CustomEvent('palletpdf:generated',
      {cancelable: true, detail: {bytes, filename}})))
    saveBlob(bytes, filename);
}
el('btnPdf').addEventListener('click', exportPalletPdf);

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
    if(inputs.switchUnits()){ writeShelfFields(); build.onUnitsChanged(inputs.getUnit()); }
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
// dimensional sensitivity re-analyses on every project change (it no-ops
// unless the pallet level is active, so it costs nothing elsewhere)
notify.onRefresh('sensitivity', refreshSensitivity);
notify.onRefresh('cost', refreshCost);
// the retail shelf reflects the sellable pack's geometry, so it re-fills on
// every project change too (refreshShelf no-ops unless the Shelf view is up).
notify.onRefresh('shelf', refreshShelf);
notify.onRefresh('exportButtons', updateExportButtonsState);
notify.onRefresh('artworkPanel', updateArtPanel);
notify.onRefresh('autosave', () => save.scheduleAutosave(gatherSaveState));

// 3D candidate-cycle arrows: a second control onto build.js's selection state.
// The listener keeps "N of M"/enable in step with the table's live sort (fires
// on re-sort too, which never runs refreshAll); the buttons step + commit,
// exactly like clicking a row. Wired BEFORE initBuild so its first renderTable
// already updates the readout.
build.setCycleListener(updateCandidateCycle);
// dispatch by depth: pallet depth steps the pattern selection, case depth the
// build candidate — same buttons, whichever ranked list the depth shows
const stepCycle = d => activeLevel === 'pallet' ? build.stepPattern(d) : build.stepCandidate(d);
el('candPrev').addEventListener('click', () => stepCycle(-1));
el('candNext').addEventListener('click', () => stepCycle(1));

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
