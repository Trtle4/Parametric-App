/**
 * The ONLY module that builds the left/right rail parameter fields. It no
 * longer owns a detached "style instance" (that was Path A — the second
 * source of truth that let the 2D/3D/DXF views drift from the project). The
 * rails now MOUNT a single project level: the fields read the level's params
 * and, on edit, write straight back into that same project object. There is
 * nothing to reconcile because there is only one object.
 *
 * mm-only below the DOM: length fields display in the active unit and are
 * stored to the project in mm; fixedUnit fields (film gauge µm, density
 * g/cm³) keep their own unit and never convert.
 */
import {toMM, fromMM, fmtInputValue} from '../core/units.js';
import {VERTICAL_CHOICES, verticalToOrientations} from '../core/project.js';

export const el = id => document.getElementById(id);

const PAL_RE = /(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)/i;

/** True while `input` has focus. Every in-place resync function below
 *  checks this before overwriting a field's `.value` — a resync runs on
 *  EVERY project change, including the one the user's own keystroke just
 *  caused, and reformatting the field they're actively typing into (e.g.
 *  rewriting "1." back to "1" mid-decimal) would eat the keystroke they
 *  haven't finished typing yet. Skipping the focused field costs nothing:
 *  its own input listener already wrote the live value into the project;
 *  only the DISPLAYED text would differ, and only until it loses focus. */
const isFocused = input => document.activeElement === input;

// display-unit state (what the fields currently show)
let unit = 'mm';
let palUnit = 'in';

// the currently-mounted level, retained so a unit switch can re-mount with
// the same binding (values live in the project, re-read in the new unit)
let mounted = null;   // {style, params, options, effectiveDims, locked, onInput}

export const getUnit = () => unit;
export const getPalUnit = () => palUnit;

/* ---------- field construction, bound to a project level ---------- */

/** A numeric length (or fixedUnit) field, its value read from and written to
 *  the backing project object. A dimension field is read-only by DEFAULT —
 *  solved from the level's contents — and only becomes editable once the
 *  level is deliberately unlocked (the lock control in app.js). There is no
 *  "type to lock" any more: a read-only field cannot be typed into, so the
 *  underlying value and the displayed value can never disagree. */
function lengthField(d, params, m){
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const chip = d.fixedUnit || unit;
  const isDim = d.group === 'dims';
  const readOnly = isDim && !m.locked;
  // solved dims show the derived value; everything else shows the stored param
  const showingDerived = isDim && !m.locked && m.effectiveDims && m.effectiveDims[d.key] != null;
  const mmVal = showingDerived ? m.effectiveDims[d.key]
    : (params[d.key] != null ? params[d.key] : d.default);
  // mirror the derived dim into params so that LOCKING the level (by typing
  // any one dim) freezes exactly what is on screen, not a stale default the
  // solve never wrote back
  if(showingDerived) params[d.key] = mmVal;
  wrap.innerHTML = `<label>${d.label} <span class="hint">${d.hint || ''}${readOnly ? ' · derived' : ''}</span></label>
    <div class="inp"><input id="p_${d.key}" type="number" min="${d.min}" step="${d.step}"${readOnly ? ' readonly' : ''}><span class="unit">${chip}</span></div>`;
  const input = wrap.querySelector('input');
  input.value = d.fixedUnit ? mmVal : fmtInputValue(fromMM(mmVal, unit), unit);
  if(readOnly){ input.style.opacity = '0.6'; input.style.cursor = 'not-allowed'; }
  else input.addEventListener('input', () => {
    params[d.key] = d.fixedUnit ? (+input.value || 0) : toMM(+input.value || 0, unit);
    m.onInput({key: d.key, group: d.group});
  });
  return wrap;
}

/** A slider + a synced editable number, both LIVE (fire on every `input`, so
 *  the 3D render responds as the user drags). The number is there for when
 *  someone has an actual spec; the slider is for the "watch the geometry
 *  respond" workflow. Both write the same param — one writer — and clamp to
 *  the field's [min,max] band. Angles are dimensionless degrees: no unit
 *  conversion (like fixedUnit fields), the stored value IS the degree value. */
function rangeField(d, params, m){
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const val = params[d.key] != null ? params[d.key] : d.default;
  params[d.key] = val;                                    // mirror the default into the project
  const chip = d.chip || '°';
  wrap.innerHTML = `<label>${d.label} <span class="hint">${d.hint || ''}</span></label>
    <div class="inp rangeinp">
      <input id="p_${d.key}" type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${val}">
      <input id="pn_${d.key}" class="rangenum" type="number" min="${d.min}" max="${d.max}" step="${d.step}" value="${val}"><span class="unit">${chip}</span>
    </div>`;
  const slider = wrap.querySelector('#p_' + d.key);
  const num = wrap.querySelector('#pn_' + d.key);
  const clamp = v => Math.min(d.max, Math.max(d.min, v));
  // `from` names the control the user touched, so the OTHER control resyncs
  // but the one being typed/dragged is never rewritten under the user's hand.
  const commit = (raw, from) => {
    const c = clamp(+raw || 0);
    params[d.key] = c;
    if(from !== 'slider') slider.value = c;
    if(from !== 'num') num.value = c;
    m.onInput({key: d.key, group: d.group});
  };
  slider.addEventListener('input', () => commit(slider.value, 'slider'));   // live during drag
  num.addEventListener('input', () => commit(num.value, 'num'));
  return wrap;
}

/** A select field, backed by `obj` (the level's params for a param select,
 *  its options for an option select). */
function selectField(d, obj, group){
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.innerHTML = `<label>${d.label} <span class="hint">${d.hint || ''}</span></label>
    <div class="inp"><select id="p_${d.key}">${
      d.choices.map(c => `<option value="${c.value}">${c.label}</option>`).join('')
    }</select></div>`;
  const input = wrap.querySelector('select');
  input.value = obj[d.key] != null ? obj[d.key] : d.default;
  input.addEventListener('change', () => {
    obj[d.key] = input.value;
    mounted.onInput({key: d.key, group});
  });
  return wrap;
}

/** A checkbox option field, backed by `obj` (the level's options). Used for
 *  boolean style options like the tray's "Shrink-wrap this tray" finish. */
function boolField(d, obj){
  const wrap = document.createElement('div');
  wrap.className = 'field bchk';
  const on = obj[d.key] != null ? !!obj[d.key] : !!d.default;
  wrap.innerHTML = `<label><input type="checkbox" id="p_${d.key}"${on ? ' checked' : ''}> ${d.label}${
    d.hint ? ` <span class="hint">${d.hint}</span>` : ''}</label>`;
  const input = wrap.querySelector('input');
  input.addEventListener('change', () => {
    obj[d.key] = input.checked;
    mounted.onInput({key: d.key, group: 'option'});
  });
  return wrap;
}

/**
 * Mount a project level into the rails.
 * @param {Object} style   the level's style descriptor (params/options)
 * @param {Object} params  the level's params object IN THE PROJECT (mutated in place)
 * @param {Object} options the level's style-view options object IN THE PROJECT
 * @param {Object} m       {effectiveDims, locked, onInput({key,group})}
 */
export function mountLevel(style, params, options, m){
  mounted = {style, params, options, ...m};
  const dims = el('dimFields'), mat = el('matFields'), opt = el('optFields');
  dims.innerHTML = ''; mat.innerHTML = ''; opt.innerHTML = '';
  for(const d of style.params){
    const target = d.group === 'dims' ? dims : mat;
    const field = d.type === 'select' ? selectField(d, params, d.group)
      : d.type === 'range' ? rangeField(d, params, mounted)
      : lengthField(d, params, mounted);
    target.appendChild(field);
  }
  for(const d of style.options || [])
    opt.appendChild(d.type === 'bool' ? boolField(d, options) : selectField(d, options, 'option'));
}

/** Resync the mounted level's derived-dimension boxes in place, without
 *  rebuilding them — a sibling rail control (vertical axis, clearance,
 *  count/arrangement) can change what THIS level solves to, but its own
 *  edit only re-renders the 2D/3D/pallet views (onProjectEdited), never
 *  remounts the rail. Rebuilding the dims fields from scratch on every
 *  edit would also blow away focus/cursor position if the user is mid-edit
 *  of a LOCKED dims field elsewhere on the same rail. No-op once locked:
 *  a locked level's boxes are the user's own fixed values, not derived. */
export function refreshDims(effectiveDims){
  if(!mounted || mounted.locked) return;
  mounted.effectiveDims = effectiveDims;
  for(const d of mounted.style.params){
    if(d.group !== 'dims' || d.type === 'select') continue;
    const input = el('p_' + d.key);
    if(!input || isFocused(input)) continue;
    const mmVal = effectiveDims && effectiveDims[d.key] != null ? effectiveDims[d.key]
      : (mounted.params[d.key] != null ? mounted.params[d.key] : d.default);
    if(effectiveDims && effectiveDims[d.key] != null) mounted.params[d.key] = mmVal;
    input.value = d.fixedUnit ? mmVal : fmtInputValue(fromMM(mmVal, unit), unit);
  }
}

/**
 * Mount the PRODUCT level as a clean 2 x 2, with EVERY control always
 * visible — these are properties of the product, upstream of wrap/carton/
 * case, and conditionally hiding them is exactly what hid On Edge. Product
 * is ALWAYS the base of the chain: it is never disabled or bypassed, and its
 * only shape choice is Cylinder vs Box — there is no content-type / "plain
 * box" selector (that was removed; a single Box piece 1x1x1 IS the simple box
 * envelope it used to provide).
 *   - Orientation (segmented): Pile Pack | On Edge
 *   - Piece shape (segmented): Cylinder | Box
 * plus the grouping counts (pieces per stack, stacks across/deep) and gaps.
 * Both toggles are independent; all four combinations are valid. Every field
 * writes straight into project.primary.collation (mm for lengths).
 *
 * Orientation maps to the collation's existing stackAxis + pieceOrientation
 * machinery (the on-edge-sleeve work — no new geometry): Pile Pack = flat,
 * stack up Z; On Edge = on-edge, run along X. Shape maps to the piece kind
 * (cylinder/box) — the internal seg values stay 'round'/'rect'.
 * @param {Object} prim  project.primary (mutated in place)
 * @param {Object} m     {onInput()}
 */
/** Pieces in ONE cell, straight from the collation grid — the per-cell
 *  factor of the derived total. Kept next to its only two callers so the
 *  derived display and the tray stage can never disagree on what "per cell"
 *  means. */
const collationCount = c => Math.max(1, c.perStack*c.nx*c.ny);

export function mountProduct(prim, m){
  const dims = el('dimFields'), mat = el('matFields');
  el('optFields').innerHTML = '';
  const c = prim.collation;
  const isRound = c.piece.kind === 'cylinder';
  // On Edge is stored as pieceOrientation 'on-edge' (stack axis X); anything
  // else is a flat Pile Pack. Legacy collations without the field fall back to
  // the stack axis (matching resolvePieceOrientation) so a saved on-edge sleeve
  // still reads as On Edge. This mode read works for boxes too (which store the
  // field even though the envelope math treats every box as flat).
  const mode = (c.pieceOrientation === 'on-edge' || (c.pieceOrientation == null && c.stackAxis !== 'Z')) ? 'onedge' : 'pile';

  const L = v => fmtInputValue(fromMM(v, unit), unit);
  const mm = id => toMM(+el(id).value || 0, unit);
  const cnt = id => Math.max(1, Math.round(+el(id).value || 1));
  const seg = (id, opts, cur) => `<div class="seg" id="${id}" role="group">${
    opts.map(o => `<button type="button" data-v="${o.v}"${o.v === cur ? ' class="on"' : ''}>${o.label}</button>`).join('')}</div>`;
  const numF = (id, label, hint, v) =>
    `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="${id}" type="number" min="0" step="1" value="${L(v)}"><span class="unit">${unit}</span></div></div>`;
  const cntF = (id, label, hint, v) =>
    `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="${id}" type="number" min="1" step="1" value="${v}"></div></div>`;

  const modeNote = mode === 'onedge'
    ? 'On edge: pieces laid on their side (a sleeve / log), the run along machine direction (envelope L).'
    : 'Pile pack: pieces stacked flat.';

  // LEFT rail: the 2 x 2 (mode + shape) + piece dimensions
  dims.innerHTML =
    `<div class="field"><label>Orientation <span class="hint">how pieces sit</span></label>
      ${seg('cMode', [{v: 'pile', label: 'Pile Pack'}, {v: 'onedge', label: 'On Edge'}], mode)}
      <div class="hint" style="margin-top:5px;line-height:1.35">${modeNote}</div></div>` +
    `<div class="field"><label>Piece shape</label>
      ${seg('cShape', [{v: 'round', label: 'Cylinder'}, {v: 'rect', label: 'Box'}], isRound ? 'round' : 'rect')}</div>` +
    (isRound
      ? numF('cD', 'Diameter', 'Ø', c.piece.diameter) + numF('cT', 'Thickness', 'axial', c.piece.thickness)
      : numF('cL', 'Length', 'L', c.piece.L) + numF('cW', 'Width', 'W', c.piece.W) + numF('cH', 'Height', 'H', c.piece.H));

  // RIGHT rail: grouping counts + gaps (always visible)
  // When a tray is in the chain the collation describes ONE CELL's contents,
  // so the cell count belongs here too — as a SECOND CONTROL onto
  // project.tray.nCells, never a copy. Total quantity below it is a DERIVED
  // read-only display (cells x per-cell): making it editable would need a
  // rule for which factor absorbs the change, which is exactly where a
  // two-writers bug creeps back in.
  const tray = m.project && m.project.tray;
  const trayOn = !!(tray && tray.enabled);
  mat.innerHTML =
    (trayOn
      ? cntF('cCells', 'Cells', 'tray cells — same field as the Tray panel', tray.nCells) +
        `<div class="field"><label>Total quantity <span class="hint">derived — cells × per cell</span></label>
          <div class="inp"><input id="cTotal" type="number" value="${tray.nCells*collationCount(c)}" disabled></div></div>`
      : '') +
    cntF('cPer', 'Pieces per stack', 'count', c.perStack) +
    cntF('cNx', 'Stacks across', 'nx', c.nx) +
    cntF('cNy', 'Stacks deep', 'ny', c.ny) +
    numF('cSg', 'Stack gap', 'between stacks', c.stackGap) +
    numF('cPg', 'Piece gap', 'within stack', c.pieceGap);
  if(trayOn) el('cCells').addEventListener('input', () => {
    // writes THE one stored value; the Tray panel reads the same field
    tray.nCells = Math.max(1, Math.round(+el('cCells').value || 1));
    el('cTotal').value = tray.nCells*collationCount(c);   // derived display follows
    m.onInput();
  });

  el('cMode').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    if(btn.dataset.v === 'onedge'){
      // sleeve / log: run along X, a single run by default (across/deep = 1)
      c.pieceOrientation = 'on-edge'; c.stackAxis = 'X'; c.nx = 1; c.ny = 1;
    }else{
      c.pieceOrientation = 'flat'; c.stackAxis = 'Z';
    }
    mountProduct(prim, m); m.onInput();
  }));
  el('cShape').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    c.piece = btn.dataset.v === 'round'
      ? {kind: 'cylinder', diameter: 50, thickness: 6} : {kind: 'box', L: 90, W: 50, H: 20};
    mountProduct(prim, m);   // shape swap re-renders the dim fields
    m.onInput();
  }));
  if(isRound){
    el('cD').addEventListener('input', () => { c.piece.diameter = mm('cD'); m.onInput(); });
    el('cT').addEventListener('input', () => { c.piece.thickness = mm('cT'); m.onInput(); });
  }else{
    el('cL').addEventListener('input', () => { c.piece.L = mm('cL'); m.onInput(); });
    el('cW').addEventListener('input', () => { c.piece.W = mm('cW'); m.onInput(); });
    el('cH').addEventListener('input', () => { c.piece.H = mm('cH'); m.onInput(); });
  }
  el('cPer').addEventListener('input', () => { c.perStack = cnt('cPer'); m.onInput(); });
  el('cNx').addEventListener('input', () => { c.nx = cnt('cNx'); m.onInput(); });
  el('cNy').addEventListener('input', () => { c.ny = cnt('cNy'); m.onInput(); });
  el('cSg').addEventListener('input', () => { c.stackGap = mm('cSg'); m.onInput(); });
  el('cPg').addEventListener('input', () => { c.pieceGap = mm('cPg'); m.onInput(); });
}

/* ---------- placement: orientation + clearance + count/arrangement ------
 * Formerly Build-only fields (Step 5 removed Build's editing entirely).
 * Each mounts into ITS OWN host element and writes straight into the
 * project object passed in — the same one-writer contract as every other
 * rail field. `idp` namespaces element ids so two instances (e.g. the
 * case's own "into the case" and "onto the pallet" controls) can coexist. */

/** Inverse of verticalToOrientations: recover {axis, mayRotate} from an
 *  allowedOrientations list, so a control mounted from ANY project state
 *  (loaded from a file, a slot, an autosave) shows what's actually there.
 *  Single-axis view — kept for callers/tests that reason about one axis;
 *  the vertical control itself uses orientationsToAxes (multi). */
export function orientationsToVertical(list){
  const pairs = {H: ['LWH', 'WLH'], L: ['WHL', 'HWL'], W: ['LHW', 'HLW']};
  for(const axis of ['H', 'L', 'W']){
    const [a, b] = pairs[axis];
    if(list.length === 1 && list[0] === a) return {axis, mayRotate: false};
    if(list.length >= 2 && list.includes(a) && list.includes(b)) return {axis, mayRotate: true};
  }
  for(const axis of ['H', 'L', 'W'])
    if(list.includes(pairs[axis][0])) return {axis, mayRotate: list.length > 1};
  return {axis: 'H', mayRotate: true};
}

/** Multi-axis inverse: which vertical axes an allowedOrientations list stands
 *  the child up on, and whether in-plan rotation is allowed. The vertical axis
 *  is now a COMPARISON variable (the user checks any of L/W/H to evaluate),
 *  so the list may span several axes at once — one candidate set per axis flows
 *  straight through parentCandidates into the Build table. mayRotate is on when
 *  any axis carries its transposed pair (the writer keeps every checked axis in
 *  the same rotate state, so the flag is consistent across them). */
export function orientationsToAxes(list){
  const pairs = {H: ['LWH', 'WLH'], L: ['WHL', 'HWL'], W: ['LHW', 'HLW']};
  const axes = []; let mayRotate = false;
  for(const axis of ['H', 'L', 'W']){
    const [a, b] = pairs[axis];
    if((list || []).includes(a) || (list || []).includes(b)){
      axes.push(axis);
      if(list.includes(a) && list.includes(b)) mayRotate = true;
    }
  }
  return axes.length ? {axes, mayRotate} : {axes: ['H'], mayRotate: true};
}

/** Vertical axis (hard constraint) + in-plan rotation (the solver's only
 *  freedom), bound to `level.allowedOrientations`.
 * @param {HTMLElement} host
 * @param {string} idp        id prefix, unique per mounted instance
 * @param {Object} level       the project level owning allowedOrientations (mutated in place)
 * @param {{disabledAxes?: string[], disabledReason?: string}} opts
 * @param {Function} onInput
 */
export function mountVertControl(host, idp, level, opts, onInput){
  const {disabledAxes = [], disabledReason = ''} = opts || {};
  // MULTI-SELECT: check any of L/W/H to EVALUATE that vertical axis. Each checked
  // axis contributes its orientation(s) to allowedOrientations, so the Build
  // table gains a candidate row set per axis — the vertical axis becomes a
  // comparison variable, not a single fixed choice. Defaults to whatever the
  // level already carries (a fresh level = one axis), so nothing changes until
  // the user opts additional axes in.
  const state = orientationsToAxes(level.allowedOrientations);
  host.innerHTML =
    `<div class="field"><label>Vertical axis <span class="hint">compare · pick any</span></label>
      <div class="vaxes" id="${idp}Axes">${VERTICAL_CHOICES.map(c => {
        const dis = disabledAxes.includes(c.axis), on = state.axes.includes(c.axis);
        return `<label class="vax${dis ? ' vaxdis' : ''}" title="${dis ? disabledReason : c.label + ' · ' + c.codes}"><input type="checkbox" value="${c.axis}" id="${idp}Ax${c.axis}"${on ? ' checked' : ''}${dis ? ' disabled' : ''}>${c.axis}-up</label>`;
      }).join('')}</div></div>
    <div class="field bchk"><label><input type="checkbox" id="${idp}Rot"${state.mayRotate ? ' checked' : ''}> May rotate about vertical (90&deg; in plan)</label>
      <div class="rotinert" id="${idp}RotHint" style="display:none">No effect with a manual grid — the grid already fixes the layout.</div></div>`;
  const boxes = () => VERTICAL_CHOICES.map(c => el(idp + 'Ax' + c.axis)).filter(Boolean);
  const apply = () => {
    let axes = boxes().filter(b => b.checked && !b.disabled).map(b => b.value);
    if(!axes.length){                       // a level must stand SOME way up — never leave zero
      const first = boxes().find(b => !b.disabled);
      if(first){ first.checked = true; axes = [first.value]; }
    }
    const rot = el(idp + 'Rot').checked, set = [];
    axes.forEach(a => verticalToOrientations(a, rot).forEach(o => { if(!set.includes(o)) set.push(o); }));
    level.allowedOrientations = set;
    onInput();
  };
  boxes().forEach(b => b.addEventListener('change', apply));
  el(idp + 'Rot').addEventListener('change', apply);
}

/** Resync an already-mounted vertical-axis control's displayed value from
 *  `level.allowedOrientations` in place — no-op if this idp isn't currently
 *  mounted (the rail is showing a different level or a different section).
 *  Nothing but this control's own `apply` writes allowedOrientations today,
 *  so this exists for structural completeness — a display that reads
 *  project state is a registered consumer regardless of whether a second
 *  writer exists YET, so one appearing later can never go unnoticed here. */
export function refreshVertControl(idp, level){
  const probe = el(idp + 'AxH') || el(idp + 'AxL') || el(idp + 'AxW');
  if(!probe) return;
  const state = orientationsToAxes(level.allowedOrientations);
  for(const axis of ['H', 'L', 'W']){
    const b = el(idp + 'Ax' + axis);
    if(b && !isFocused(b)) b.checked = state.axes.includes(axis);
  }
  const rotChk = el(idp + 'Rot');
  if(rotChk && !isFocused(rotChk)) rotChk.checked = state.mayRotate;
}

/** Wall/between/headspace, bound to `clearance` (mutated in place). Skips
 *  headspace when the clearance shape doesn't carry it (tertiary's is
 *  wall/between only — cases don't get a headspace allowance). */
export function mountClearanceControl(host, idp, clearance, onInput){
  const L = mm => fmtInputValue(fromMM(mm, unit), unit);
  const hasHead = 'top' in clearance;
  host.innerHTML =
    `<div class="field"><label>Clearance wall <span class="hint">each side</span></label>
      <div class="inp"><input id="${idp}Wall" type="number" step="0.1" value="${L(clearance.wall)}"><span class="unit">${unit}</span></div></div>
    <div class="field"><label>Clearance between</label>
      <div class="inp"><input id="${idp}Between" type="number" step="0.1" value="${L(clearance.between)}"><span class="unit">${unit}</span></div></div>` +
    (hasHead ? `<div class="field"><label>Headspace <span class="hint">top, design input</span></label>
      <div class="inp"><input id="${idp}Head" type="number" step="0.5" value="${L(clearance.top)}"><span class="unit">${unit}</span></div></div>` : '');
  const mm = id => toMM(+el(id).value || 0, unit);
  el(idp + 'Wall').addEventListener('input', () => { clearance.wall = mm(idp + 'Wall'); onInput(); });
  el(idp + 'Between').addEventListener('input', () => { clearance.between = mm(idp + 'Between'); onInput(); });
  if(hasHead) el(idp + 'Head').addEventListener('input', () => { clearance.top = mm(idp + 'Head'); onInput(); });
}

/** Resync an already-mounted clearance control's displayed values from
 *  `clearance` in place — no-op if this idp isn't currently mounted. */
export function refreshClearanceControl(idp, clearance){
  const wallEl = el(idp + 'Wall');
  if(!wallEl) return;
  const L = mm => fmtInputValue(fromMM(mm, unit), unit);
  if(!isFocused(wallEl)) wallEl.value = L(clearance.wall);
  const betweenEl = el(idp + 'Between');
  if(!isFocused(betweenEl)) betweenEl.value = L(clearance.between);
  const headEl = el(idp + 'Head');
  if(headEl && !isFocused(headEl)) headEl.value = L(clearance.top);
}

/** Read a count field as a clamped positive integer: non-numeric, empty,
 *  decimal-rounded (Math.round handles that), or < 1 all fall back to
 *  `fallback` (the current valid value) — never 0, never NaN. A bare number
 *  input has no "custom" escape hatch to fall back on, so this validation
 *  IS the field's only guard against garbage reaching the project. */
function clampCount(raw, fallback){
  const n = Math.round(+raw);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Child count + arrangement for `link` (mutated in place) — "how many of
 *  my child fit inside me". One plain number input for the count (no
 *  preset dropdown, no separate "custom" field — that two-control split let
 *  an explicit arrangement silently ignore whatever the count field showed);
 *  an explicit arrangement shows its OWN grid, never a placeholder default,
 *  so re-rendering from a loaded project is faithful to what was loaded. */
export function mountCountArrangement(host, idp, link, defNx, defNy, defNz, childNoun, onInput, rangeMode = false){
  function render(){
    const explicit = link.arrangement !== 'auto';
    const nx = explicit ? link.arrangement.nx : defNx;
    const ny = explicit ? link.arrangement.ny : defNy;
    const nz = explicit ? link.arrangement.nz : defNz;
    // AUTO (solver chose) vs MANUAL (user grid) badge — so "the solver is
    // arranging within my grid" is never confused with "the app overrode me".
    const badge = `<span class="arrbadge${explicit ? ' manual' : ''}"><span class="dot"></span>${explicit ? 'MANUAL' : 'AUTO'}</span>`;
    // RANGE (min–max) only makes sense in auto mode — an explicit grid pins the
    // count to its own product. `countMax` absent or ≤ count means single-count
    // (min==max), identical to the pre-range behaviour. Not capped: any max.
    const rangeUI = rangeMode && !explicit;
    const cmax = link.countMax > link.count ? link.countMax : link.count;
    const countField = rangeUI
      ? `<div class="field"><label>${childNoun}s <span class="hint">per case · range, ranked by ${childNoun.toLowerCase()}s/pallet</span></label>
          <div class="inp inprange"><input id="${idp}C" type="number" min="1" step="1" value="${link.count}"><span class="rangedash">to</span><input id="${idp}Cmax" type="number" min="1" step="1" value="${cmax}"></div></div>`
      : `<div class="field"><label>${childNoun}s <span class="hint">count</span></label>
          <div class="inp"><input id="${idp}C" type="number" min="1" step="1" value="${link.count}"></div></div>`;
    host.innerHTML =
      countField +
      `<div class="field"><label>Arrangement ${badge}</label>
        <div class="inp"><select id="${idp}Arr"><option value="auto"${explicit ? '' : ' selected'}>auto</option><option value="explicit"${explicit ? ' selected' : ''}>nx &times; ny &times; nz</option></select></div></div>` +
      (explicit ? `<div class="field"><label>Grid</label>
        <div class="inp"><input id="${idp}Nx" type="number" min="1" value="${nx}" style="width:30%;padding-right:10px"> &times;
        <input id="${idp}Ny" type="number" min="1" value="${ny}" style="width:30%;padding-right:10px"> &times;
        <input id="${idp}Nz" type="number" min="1" value="${nz}" style="width:30%;padding-right:10px"></div></div>` : '') +
      `<div id="${idp}Warn"></div>`;

    // typing a count while an explicit grid is active would REPLACE that grid
    // (a count and a fixed nx*ny*nz are mutually exclusive asks). That switch
    // used to happen silently — the real cause of "the app fights my
    // arrangement" (UAT #3). Warn instead: hold the grid until the user
    // chooses. In auto mode a typed count just writes straight through.
    function showCountAdvisory(n){
      const a = link.arrangement;
      const warn = el(idp + 'Warn');
      warn.innerHTML =
        `<div class="countwarn">A custom count switches this level to <b>auto</b> — your ${a.nx}×${a.ny}×${a.nz} grid will be replaced.
          <div class="cw-acts">
            <button type="button" id="${idp}Keep">keep grid</button>
            <button type="button" id="${idp}Use" class="cw-primary">use count (${n})</button>
          </div></div>`;
      el(idp + 'Keep').addEventListener('click', () => {
        el(idp + 'C').value = a.nx*a.ny*a.nz;   // restore the field to the grid's product
        warn.innerHTML = '';
      });
      el(idp + 'Use').addEventListener('click', () => {
        link.arrangement = 'auto';
        link.count = n;
        render();          // rebuild in auto shape (grid fields gone, badge → AUTO)
        onInput();
      });
    }

    el(idp + 'C').addEventListener('input', () => {
      const n = clampCount(el(idp + 'C').value, link.count);
      if(link.arrangement !== 'auto'){ showCountAdvisory(n); return; }   // no silent grid loss
      link.count = n;                                    // count is the range MIN
      if(rangeUI && link.countMax != null && link.countMax < n) link.countMax = n;   // keep max ≥ min
      onInput();
    });
    if(rangeUI) el(idp + 'Cmax').addEventListener('input', () => {
      // max is stored only when it exceeds the min — max == min collapses to a
      // single count (countMax cleared so the state reads as plain single-count).
      const m = clampCount(el(idp + 'Cmax').value, cmax);
      link.countMax = m > link.count ? m : undefined;
      onInput();
    });
    el(idp + 'Arr').addEventListener('change', () => {
      const exp = el(idp + 'Arr').value === 'explicit';
      link.arrangement = exp ? {nx: defNx, ny: defNy, nz: defNz} : 'auto';
      if(exp) link.count = defNx*defNy*defNz;
      render(); onInput();
    });
    if(explicit) ['Nx', 'Ny', 'Nz'].forEach(k => el(idp + k).addEventListener('input', () => {
      link.arrangement = {
        nx: clampCount(el(idp + 'Nx').value, link.arrangement.nx),
        ny: clampCount(el(idp + 'Ny').value, link.arrangement.ny),
        nz: clampCount(el(idp + 'Nz').value, link.arrangement.nz)
      };
      link.count = link.arrangement.nx*link.arrangement.ny*link.arrangement.nz;
      onInput();
    }));
  }
  render();
}

/** Resync an already-mounted count/arrangement control's displayed values
 *  from `link` in place — no-op if this idp isn't currently mounted. Never
 *  flips between the auto/explicit DOM shapes itself (only this control's
 *  own `render()` does that, and only in response to its OWN Arrangement
 *  select — nothing else writes link.arrangement's auto-vs-object shape),
 *  so it only ever needs to update values already present in the DOM. */
export function refreshCountArrangement(idp, link){
  const cInput = el(idp + 'C');
  if(!cInput) return;
  if(!isFocused(cInput)) cInput.value = link.count;
  const cmaxEl = el(idp + 'Cmax');
  if(cmaxEl && !isFocused(cmaxEl)) cmaxEl.value = (link.countMax > link.count ? link.countMax : link.count);
  if(link.arrangement !== 'auto'){
    const nxEl = el(idp + 'Nx');
    if(nxEl){
      if(!isFocused(nxEl)) nxEl.value = link.arrangement.nx;
      const nyEl = el(idp + 'Ny'), nzEl = el(idp + 'Nz');
      if(!isFocused(nyEl)) nyEl.value = link.arrangement.ny;
      if(!isFocused(nzEl)) nzEl.value = link.arrangement.nz;
    }
  }
}

/* ---------- pallet fields (write straight to project.pallet in app.js) --- */

/** Read the pallet rail fields as mm: {L, W, maxH}. The caller writes these
 *  into project.pallet — the single home for pallet dims. */
export function readPallet(){
  const match = (el('pal').value || '').match(PAL_RE);
  const a = match ? +match[1] : (palUnit === 'mm' ? 1219.2 : 48);
  const b = match ? +match[2] : (palUnit === 'mm' ? 1016 : 40);
  return {L: toMM(a, palUnit), W: toMM(b, palUnit), maxH: toMM(+el('palMaxH').value || 0, palUnit)};
}

/* ---------- unit switching ---------- */
/** Flip the box-field unit. Returns true if it changed; the caller re-mounts
 *  the rails (remount) and refreshes the views. */
export function switchUnits(){
  const next = el('units').value;
  if(next === unit) return false;
  unit = next;
  return true;
}

/** Convert the pallet fields to the unit currently selected in #palUnits.
 *  (Pallet fields historically round mm to whole numbers, unlike box fields.) */
export function switchPalUnits(){
  const next = el('palUnits').value;
  if(next === palUnit) return false;
  const k = next === 'mm' ? 25.4 : 1/25.4;
  const fmtP = v => next === 'mm' ? Math.round(v).toString() : (+v.toFixed(3)).toString();
  const m = (el('pal').value || '').match(PAL_RE);
  if(m) el('pal').value = `${fmtP(+m[1]*k)} x ${fmtP(+m[2]*k)}`;
  el('palMaxH').value = fmtP((+el('palMaxH').value || 0)*k);
  palUnit = next;
  ['uPal', 'uPalMaxH'].forEach(id => el(id).textContent = palUnit);
  return true;
}

/* ---------- the thermoformed tray level ---------------------------------
 * A NON-style level: no styleId, no blank, no DXF (the product2d.js
 * precedent). Every field writes straight into project.tray — the same
 * one-writer contract as the rest of the rails.
 *
 * AUTO-WITH-OVERRIDE. A cell dimension left blank is DERIVED from the
 * product (the core tray stage does the deriving); typing a number
 * overrides it, and "auto" clears back. The stored form is the override
 * itself: absent from `tray.params` means auto, so there is no second
 * "isAuto" flag to fall out of sync with the value — the presence of the
 * key IS the state.
 */
export function mountTray(project, m){
  const host = el('trayFields');
  const tr = project.tray;
  if(!tr || !tr.enabled){ host.innerHTML = ''; return; }
  const ov = tr.params || (tr.params = {});
  const L = v => fmtInputValue(fromMM(v, unit), unit);

  // a length field that is EITHER an explicit override or auto (placeholder
  // shows what the derivation produced, so "auto" is never a blank mystery)
  const autoF = (key, label, hint, autoVal) => {
    const has = typeof ov[key] === 'number' && isFinite(ov[key]);
    return `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="tr_${key}" type="number" min="0" step="0.5"
        value="${has ? L(ov[key]) : ''}" placeholder="${autoVal != null ? L(autoVal) : 'auto'}">
        <span class="unit">${unit}</span></div>
      <div class="hint" style="margin-top:4px">${has
        ? `<button type="button" class="btn btnlink" id="tr_${key}_auto">reset to auto</button>`
        : 'auto — from the product'}</div></div>`;
  };
  const numF = (key, label, hint, v, step = 0.5) =>
    `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="tr_${key}" type="number" min="0" step="${step}" value="${L(v)}"><span class="unit">${unit}</span></div></div>`;
  const plainF = (key, label, hint, v, step, min = 0) =>
    `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="tr_${key}" type="number" min="${min}" step="${step}" value="${v}"></div></div>`;

  const D = (k, dflt) => (typeof ov[k] === 'number' ? ov[k] : dflt);
  const auto = m.autoDims || {};

  host.innerHTML =
    `<h2 style="margin-top:6px">Tray</h2>` +
    // THE shared cell count — this control and the collation panel's are two
    // controls onto project.tray.nCells, never two stored values.
    plainF('nCells', 'Cells', 'across the tray', tr.nCells, 1, 1) +
    `<div class="field"><label>Products per cell <span class="hint">derived — set on the Product level</span></label>
      <div class="inp"><input id="tr_perCell" type="number" value="${m.perCell != null ? m.perCell : ''}" disabled></div></div>` +
    autoF('cellLen', 'Cell length', 'along the channel', auto.cellLen) +
    autoF('cellWid', 'Cell width', 'across', auto.cellWid) +
    autoF('cellH', 'Cell depth', 'trough', auto.cellH) +
    `<div class="field"><label>Cell pitch <span class="hint">centre to centre — derived</span></label>
      <div class="inp"><input id="tr_pitch" type="number" value="${auto.pitch != null ? L(auto.pitch) : ''}" disabled><span class="unit">${unit}</span></div></div>` +
    `<h2 style="margin-top:6px">Tray shell</h2>` +
    numF('wall', 'Outer wall', 'thickness', D('wall', 3)) +
    numF('divider', 'Divider', 'between cells', D('divider', D('wall', 3))) +
    numF('floor', 'Floor', 'thickness', D('floor', 2.5)) +
    plainF('draftDeg', 'Draft', 'degrees', D('draftDeg', 5), 0.5) +
    numF('stripL', 'Flange — length sides', 'strip', D('stripL', 5)) +
    numF('stripW', 'Flange — width sides', 'strip', D('stripW', 5)) +
    numF('lipH', 'Lip height', 'rim', D('lipH', 3)) +
    numF('flangeT', 'Flange thickness', '', D('flangeT', 2.5)) +
    `<div class="field"><label>Long axis <span class="hint">channel direction</span></label>
      <div class="seg" id="tr_longAxis" role="group">${
        ['X', 'Y'].map(a => `<button type="button" data-v="${a}"${(D('longAxis', 'X') === a) ? ' class="on"' : ''}>${a}</button>`).join('')}</div></div>`;

  const mmv = id => toMM(+el(id).value || 0, unit);
  const bindAuto = key => {
    const inp = el('tr_' + key);
    inp.addEventListener('input', () => {
      if(inp.value === '') delete ov[key]; else ov[key] = mmv('tr_' + key);
      m.onInput();
    });
    const rst = el(`tr_${key}_auto`);
    if(rst) rst.addEventListener('click', () => { delete ov[key]; m.onInput(); m.remount && m.remount(); });
  };
  ['cellLen', 'cellWid', 'cellH'].forEach(bindAuto);
  for(const k of ['wall', 'divider', 'floor', 'stripL', 'stripW', 'lipH', 'flangeT'])
    el('tr_' + k).addEventListener('input', () => { ov[k] = mmv('tr_' + k); m.onInput(); });
  el('tr_draftDeg').addEventListener('input', () => { ov.draftDeg = Math.max(0, +el('tr_draftDeg').value || 0); m.onInput(); });
  // the shared cell count: writes THE stored value, then asks for a remount so
  // the collation panel's mirror of it re-renders from the same source
  el('tr_nCells').addEventListener('input', () => {
    tr.nCells = Math.max(1, Math.round(+el('tr_nCells').value || 1)); m.onInput();
  });
  el('tr_longAxis').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    ov.longAxis = b.dataset.v; m.onInput(); m.remount && m.remount();
  }));
}
