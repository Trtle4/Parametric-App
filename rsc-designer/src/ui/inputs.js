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
    opt.appendChild(selectField(d, options, 'option'));
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
  mat.innerHTML =
    cntF('cPer', 'Pieces per stack', 'count', c.perStack) +
    cntF('cNx', 'Stacks across', 'nx', c.nx) +
    cntF('cNy', 'Stacks deep', 'ny', c.ny) +
    numF('cSg', 'Stack gap', 'between stacks', c.stackGap) +
    numF('cPg', 'Piece gap', 'within stack', c.pieceGap);

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
 *  (loaded from a file, a slot, an autosave) shows what's actually there. */
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
  const vert = orientationsToVertical(level.allowedOrientations);
  host.innerHTML =
    `<div class="field"><label>Vertical axis</label>
      <div class="inp"><select id="${idp}Axis">${VERTICAL_CHOICES.map(c => {
        const dis = disabledAxes.includes(c.axis);
        return `<option value="${c.axis}"${c.axis === vert.axis ? ' selected' : ''}${dis ? ` disabled title="${disabledReason}"` : ''}>${c.label} &middot; ${c.codes}</option>`;
      }).join('')}</select></div></div>
    <div class="field bchk"><label><input type="checkbox" id="${idp}Rot"${vert.mayRotate ? ' checked' : ''}> May rotate about vertical (90&deg; in plan)</label>
      <div class="rotinert" id="${idp}RotHint" style="display:none">No effect with a manual grid — the grid already fixes the layout.</div></div>`;
  const apply = () => {
    level.allowedOrientations = verticalToOrientations(el(idp + 'Axis').value, el(idp + 'Rot').checked);
    onInput();
  };
  el(idp + 'Axis').addEventListener('change', apply);
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
  const axisSel = el(idp + 'Axis');
  if(!axisSel) return;
  const vert = orientationsToVertical(level.allowedOrientations);
  if(!isFocused(axisSel) && axisSel.value !== vert.axis) axisSel.value = vert.axis;
  const rotChk = el(idp + 'Rot');
  if(!isFocused(rotChk)) rotChk.checked = vert.mayRotate;
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
export function mountCountArrangement(host, idp, link, defNx, defNy, defNz, childNoun, onInput){
  function render(){
    const explicit = link.arrangement !== 'auto';
    const nx = explicit ? link.arrangement.nx : defNx;
    const ny = explicit ? link.arrangement.ny : defNy;
    const nz = explicit ? link.arrangement.nz : defNz;
    // AUTO (solver chose) vs MANUAL (user grid) badge — so "the solver is
    // arranging within my grid" is never confused with "the app overrode me".
    const badge = `<span class="arrbadge${explicit ? ' manual' : ''}"><span class="dot"></span>${explicit ? 'MANUAL' : 'AUTO'}</span>`;
    host.innerHTML =
      `<div class="field"><label>${childNoun}s <span class="hint">count</span></label>
        <div class="inp"><input id="${idp}C" type="number" min="1" step="1" value="${link.count}"></div></div>
      <div class="field"><label>Arrangement ${badge}</label>
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
      link.count = n;
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
