/**
 * Application wiring: the ACTIVE-LEVEL selector, view switching, event
 * listeners, readouts. There is one source of truth — the project. The rails
 * edit a level of it (inputs.mountLevel); every view (2D/3D/DXF/artwork/
 * readouts) renders that same level's resolved geometry via levelGeometry().
 * No detached style instance, so 2D, 3D, and DXF cannot disagree. Fold
 * builders resolve via the registry-keyed map in render/folds/index.js.
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
import * as save from './save.js';
import {newProject, levelGeometry, resolveActiveRow, resolveChainShape, describeChain, linkFor, styleDefaults, styleOptionDefaults} from '../core/project.js';

let view = '2d';
let mode3d = 'hier';           // 'fold' | 'hier'
let hierSel = {};              // opened index per tier {case,carton,wrap}

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
           derivedFrom: p => p.primary.box ? 'the box' : 'the collation', fitsOf: row => row.wrapFits,
           enabledOf: p => !!p.primary.wrap},
  carton: {label: 'Carton', kind: 'style', tier: 'secondary', geoLevel: 'carton',
           styleIdOf: p => p.secondary.styleId, setStyleId: (p, id) => { p.secondary.styleId = id; },
           paramsOf: p => p.secondary.params, setParams: (p, o) => { p.secondary.params = o; },
           optionsOf: p => p.secondary.options, setOptions: (p, o) => { p.secondary.options = o; },
           lockedOf: p => linkFor(p, 'secondary').locked, setLocked: (p, v) => { linkFor(p, 'secondary').locked = v; },
           derivedFrom: p => p.primary.wrap ? 'the wrap' : (p.primary.box ? 'the box' : 'the collation'),
           fitsOf: row => row.secondaryFits,
           enabledOf: p => p.secondary.enabled !== false},
  case:   {label: 'Case',   kind: 'style', tier: 'tertiary', geoLevel: 'case',
           styleIdOf: p => p.tertiary.styleId, setStyleId: (p, id) => { p.tertiary.styleId = id; },
           paramsOf: p => p.tertiary.params, setParams: (p, o) => { p.tertiary.params = o; },
           optionsOf: p => p.tertiary.options, setOptions: (p, o) => { p.tertiary.options = o; },
           lockedOf: p => linkFor(p, 'tertiary').locked, setLocked: (p, v) => { linkFor(p, 'tertiary').locked = v; },
           // re-pointed per the enabled chain (describeChain), never hardcoded
           derivedFrom: p => `the ${describeChain(p).childNoun}`,
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
function refresh2d(){
  const u = inputs.getUnit();
  if(!isStyleLevel()){
    // product/pallet have no dieline — say so plainly rather than showing a
    // blank or a stale drawing from another level
    el('svg').innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="#9aa6b2" font-family="var(--mono)" font-size="14">No dieline for the ${LEVELS[activeLevel].label} level — select Wrap, Carton, or Case</text>`;
    el('blank').textContent = '—'; el('area').textContent = '--'; el('styleStats').innerHTML = '';
    return;
  }
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
  // every level's outer (formed) dimensions, stated plainly — for the wrap
  // this is the envelope PLUS seals, the number that actually sizes the
  // carton; reading it should never require doing the compensation
  // arithmetic by hand
  const outerStat = `<div class="stat"><span class="lab">Outer dimensions</span><span class="val">${fmtLen(g.outer.L, u)} × ${fmtLen(g.outer.W, u)} × ${fmtLen(g.outer.H, u)} ${u}</span></div>`;
  el('styleStats').innerHTML = outerStat + (style.readouts ? style.readouts(g) : []).map(r =>
    `<div class="stat"><span class="lab">${r.label}</span><span class="val">${
      r.len !== undefined ? `${fmtLen(r.len, u)} ${u}` : r.text}</span></div>`
  ).join('');
}

function refresh3d(){
  const g = activeGeometry();
  if(!g) return;                                  // product/pallet fold nothing — the nest renders them
  const lvl = LEVELS[activeLevel];
  fold.buildBox(foldBuilders[activeStyleId()], g, build.project.printText, lvl.optionsOf(build.project));
}

/** The pallet-stats readout: always the CASE on the pallet (the shipper),
 *  independent of the active level — the pallet result the chain produced. */
function refreshPal(){
  const p = build.project.pallet;
  const g = levelGeometry(build.project, 'case', build.getRounding(), selKey());
  if(!g){ ['palPat', 'palCnt', 'palTot', 'palCov'].forEach(id => el(id).textContent = '--'); return; }
  const stats = buildPallet(g, {L: p.L, W: p.W, maxH: p.maxH}, p.pattern, view === 'pal');
  el('palPat').textContent = stats.perLayer > 0 ? stats.label + (p.pattern === 'interlock' ? ' · interlocked' : '') : 'does not fit';
  el('palCnt').textContent = stats.perLayer > 0 ? `${stats.perLayer} × ${stats.layers}` : '--';
  el('palTot').textContent = stats.total > 0 ? `${stats.total} boxes` : '0';
  el('palCov').textContent = stats.perLayer > 0 ? `${stats.coveragePct}%` : '--';
}

function refreshAll(){
  refresh2d();
  if(view === '3d' && mode3d === 'fold' && isStyleLevel()) refresh3d();
  if(view === 'pal') refreshPal();
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
    params: {sealType: 'fin', finHeight: 8, finSealBand: 5, finTreatment: 'folded', finFace: 'back',
             lapOverlap: 12, endSealWidth: 10, endSealBleed: 3,
             girthBasis: 'rectangular', roundDiameter: 0, gauge: 30, density: 0.92,
             L: 90, W: 50, H: 120},
    wrapAxis: 'auto', options: styleOptionDefaults('flowwrap'), locked: false
  };
}

/** What the new pairing will be once `level` is disabled — shown in the
 *  warning so a toggle-off is never silent about what re-points to what. */
function pairingAfterDisabling(level){
  const proj = build.project;
  const contentNoun = proj.primary.box ? 'box' : 'collation';
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
  onProjectEdited();
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

/** A short label for the content at the bottom of the chain — a collation
 *  summary or the plain-box dims — never hardcoded to "collation". */
function contentLabel(proj){
  const prim = proj.primary;
  if(prim.box) return `Box ${fmtLen(prim.box.L, 'mm')}×${fmtLen(prim.box.W, 'mm')}×${fmtLen(prim.box.H, 'mm')} mm`;
  const col = prim.collation;
  const kind = col.piece.kind === 'cylinder' ? 'Cylinders' : 'Pieces';
  return `${kind} (${col.nx}×${col.ny}, ${col.perStack}/stack)`;
}

/** The always-visible chain string: derived from the enabled chain, never
 *  hardcoded — e.g. "Pucks (2x3, stacked) -> Flow wrap -> Case -> Pallet
 *  [carton disabled]". Every disabled tier gets its own bracketed note. */
function renderChainString(){
  const proj = build.project;
  const parts = [contentLabel(proj)];
  if(proj.primary.wrap) parts.push(styleById(proj.primary.wrap.styleId).name);
  if(isTierEnabled('carton')) parts.push(styleById(proj.secondary.styleId).name);
  if(isTierEnabled('case')) parts.push(styleById(proj.tertiary.styleId).name);
  parts.push('Pallet');
  const disabled = ['wrap', 'carton', 'case'].filter(l => !isTierEnabled(l));
  const note = disabled.length ? `<span class="disabledNote">     [${disabled.map(l => `${l} disabled`).join(', ')}]</span>` : '';
  el('chainString').innerHTML = parts.join(' &rarr; ') + note;
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
    onProjectEdited();
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
    const primaryNoun = cap(proj.primary.wrap ? 'wrap' : (proj.primary.box ? 'box' : 'collation'));
    host.innerHTML =
      `<h2 style="margin-top:6px">Inside the carton</h2>
       <div id="plInVert" style="display:contents"></div>
       <div id="plInClear" style="display:contents"></div>
       <div id="plInCount" style="display:contents"></div>`;
    inputs.mountVertControl(el('plInVert'), 'pIn', proj.primary, {}, onProjectEdited);
    inputs.mountClearanceControl(el('plInClear'), 'pIn', proj.primary.clearance, onProjectEdited);
    inputs.mountCountArrangement(el('plInCount'), 'pIn', linkFor(proj, 'secondary'), [1, 2, 4, 6, 8], 2, 1, 1, primaryNoun, onProjectEdited);
    return;
  }

  if(activeLevel === 'case'){
    const secondaryIn = proj.secondary.enabled !== false;
    const childLevel = secondaryIn ? proj.secondary : proj.primary;
    const childNoun = cap(secondaryIn ? 'carton' : (proj.primary.wrap ? 'wrap' : (proj.primary.box ? 'box' : 'collation')));
    host.innerHTML =
      `<h2 style="margin-top:6px">Inside the case <span class="hint">from the ${childNoun.toLowerCase()}</span></h2>
       <div id="plInVert" style="display:contents"></div>
       <div id="plInClear" style="display:contents"></div>
       <div id="plInCount" style="display:contents"></div>
       <h2 style="margin-top:10px">Case onto the pallet</h2>
       <div id="plOutVert" style="display:contents"></div>
       <div id="plOutClear" style="display:contents"></div>`;
    inputs.mountVertControl(el('plInVert'), 'pIn', childLevel, {}, onProjectEdited);
    inputs.mountClearanceControl(el('plInClear'), 'pIn', childLevel.clearance, onProjectEdited);
    inputs.mountCountArrangement(el('plInCount'), 'pIn', linkFor(proj, 'tertiary'), [12, 24, 36], 4, 3, 1, childNoun, onProjectEdited);
    inputs.mountVertControl(el('plOutVert'), 'pOut', proj.tertiary,
      {disabledAxes: ['L', 'W'], disabledReason: 'A shipper does not go on the pallet on its side — say so explicitly if you genuinely need this'},
      onProjectEdited);
    inputs.mountClearanceControl(el('plOutClear'), 'pOut', proj.tertiary.clearance, onProjectEdited);
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
      onInput: () => onProjectEdited()
    });
  }else if(lvl.kind === 'product'){
    inputs.mountProduct(proj.primary, {onInput: () => onProjectEdited()});
  }else{
    // pallet: the fields are static DOM; ensure their unit chips are current
    writePalletFields();
  }
}

const LEVEL_BRAND = {
  product: {code: 'PRODUCT', sub: 'Collation'},
  pallet:  {code: 'PALLET',  sub: 'Load on the pallet'}
};
function setActiveLevel(level){
  activeLevel = level;
  const lvl = LEVELS[level];
  if(lvl.kind === 'style'){
    const style = activeStyle();
    el('brandCode').textContent = style.brand.code;
    el('brandName').textContent = style.brand.sub;
    // flexible styles have no die -> no DXF; their deliverables are the film
    // spec + artwork template. A disabled tier has no geometry at all.
    const flex = style.structure === 'flexible';
    const disabledTier = !lvl.enabledOf(build.project);
    el('btnDXF').disabled = flex || disabledTier;
    el('btnDXF').title = disabledTier ? 'This tier is disabled — nothing to export'
      : flex ? 'No die for a flexible style — export the artwork template instead' : '';
    el('btnArt').style.display = flex ? '' : 'none';
    el('btnSpec').style.display = flex ? '' : 'none';
  }else{
    el('brandCode').textContent = LEVEL_BRAND[level].code;
    el('brandName').textContent = LEVEL_BRAND[level].sub;
    el('btnDXF').disabled = true;
    el('btnDXF').title = 'No dieline at this level — select Wrap, Carton, or Case';
    el('btnArt').style.display = 'none';
    el('btnSpec').style.display = 'none';
  }
  if(el('style').value !== level) el('style').value = level;
  // the active level IS the hierarchy depth — keep the 3D depth buttons in sync
  LEVEL_ORDER.forEach(d => el('d_' + d).classList.toggle('on', mode3d === 'hier' && d === level));
  mountActiveLevel();
  renderChainString();
  refresh2d();
  if(view === 'pal') refreshPal();
  if(view === '3d') apply3dMode();
}

/** A rail edit already mutated the project in place; re-run the views (each
 *  re-solves the chain via levelGeometry) and schedule an autosave. Does NOT
 *  read the Build DOM — the rails are the writer here, Build's fields are
 *  re-synced from the project when that tab is next shown. */
function onProjectEdited(){
  refreshAll();
  // a locked level's misfit banner must react to every keystroke, not just
  // to the initial mount — contents are "checked against them" continuously,
  // never only at unlock time
  mountLockControl();
  renderChainString();
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

function hudText(bundle, opened, depth){
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
  LEVEL_ORDER.forEach(d => el('d_' + d).classList.toggle('on', mode3d === 'hier' && activeLevel === d));
  if(view !== '3d') return;
  fold.stopFold(); fold.showBox(false); showPallet(false); showNest(false); showProduct(false);
  const bundle = hierarchyBundle();
  LEVEL_ORDER.forEach(d => el('d_' + d).disabled = !depthAvailable(bundle, d));
  if(!bundle){ hier.show(false); el('hierHud').style.display = 'none'; el('orbithint').textContent = 'configure a chain in Build first'; return; }
  // the active level IS the depth; if it isn't reachable for this config,
  // render the case (without disturbing the selector's own state)
  const depth = depthAvailable(bundle, activeLevel) ? activeLevel : 'case';
  if(resetCam) fold.setOrbit(0.5, 0.65, 1.35);   // oblique 3/4 view: see the cutaway channel + open top
  const res = hier.buildHierarchy(bundle, depth, hierSel);
  hier.show(true);
  el('orbithint').textContent = 'drag to orbit · scroll to zoom · click a unit to open it';
  el('hierHud').style.display = 'block';
  el('hierHud').textContent = hudText(bundle, res.opened, depth);
  renderLegend(bundle, depth);
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

// product/pallet have no fold — they only exist in the nest cascade, so a
// fold request on those levels falls through to the hierarchy
function apply3dMode(){ if(mode3d === 'fold' && isStyleLevel()) applyFoldMode(); else applyHierarchy(true); }

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
  mountActiveLevel();                       // rail fields re-displayed in the new unit (values live in the project)
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
    // loadProject's internal recompute() only remounts the rail when
    // view !== 'build' — and view was still 'build' (set by the restore
    // this discards) at the moment that recompute ran, so the refresh was
    // skipped. Force it explicitly: the rail must reflect this project,
    // never the discarded one, regardless of that timing gap.
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
