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

export const el = id => document.getElementById(id);

const PAL_RE = /(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)/i;

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
    target.appendChild(d.type === 'select' ? selectField(d, params, d.group) : lengthField(d, params, mounted));
  }
  for(const d of style.options || [])
    opt.appendChild(selectField(d, options, 'option'));
}

/**
 * Mount the PRODUCT level: the collation editor. Piece dims go in the left
 * rail, stacking in the right rail; every field writes straight into the
 * project's `collation` object (mm for lengths). This is the product's
 * parameters — a plain product envelope, edited here, nowhere else once
 * Build becomes table-only.
 * @param {Object} collation  project.primary.collation (mutated in place)
 * @param {Object} m          {onInput()}
 */
export function mountProduct(collation, m){
  const dims = el('dimFields'), mat = el('matFields');
  el('optFields').innerHTML = '';
  const isCyl = collation.piece.kind === 'cylinder';
  const L = mm => fmtInputValue(fromMM(mm, unit), unit);
  const numF = (id, label, hint, mm) =>
    `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="${id}" type="number" min="0" step="1" value="${L(mm)}"><span class="unit">${unit}</span></div></div>`;
  const cntF = (id, label, hint, v) =>
    `<div class="field"><label>${label} <span class="hint">${hint}</span></label>
      <div class="inp"><input id="${id}" type="number" min="1" step="1" value="${v}"></div></div>`;

  dims.innerHTML =
    `<div class="field"><label>Piece <span class="hint">shape</span></label>
      <div class="inp"><select id="cKind"><option value="box"${isCyl ? '' : ' selected'}>Box</option><option value="cylinder"${isCyl ? ' selected' : ''}>Cylinder</option></select></div></div>` +
    (isCyl
      ? numF('cD', 'Diameter', 'Ø', collation.piece.diameter) + numF('cT', 'Thickness', 'axial', collation.piece.thickness)
      : numF('cL', 'Length', 'L', collation.piece.L) + numF('cW', 'Width', 'W', collation.piece.W) + numF('cH', 'Height', 'H', collation.piece.H));

  mat.innerHTML =
    cntF('cPer', 'Per stack', 'count', collation.perStack) +
    `<div class="field"><label>Stack axis <span class="hint">dir</span></label>
      <div class="inp"><select id="cAxis">${['X', 'Y', 'Z'].map(a => `<option${a === collation.stackAxis ? ' selected' : ''}>${a}</option>`).join('')}</select></div></div>` +
    cntF('cNx', 'Stacks across', 'nx', collation.nx) +
    cntF('cNy', 'Stacks deep', 'ny', collation.ny) +
    numF('cSg', 'Stack gap', 'between stacks', collation.stackGap) +
    numF('cPg', 'Piece gap', 'within stack', collation.pieceGap);

  const mm = id => toMM(+el(id).value || 0, unit);
  const cnt = id => Math.max(1, Math.round(+el(id).value || 1));
  el('cKind').addEventListener('change', () => {
    collation.piece = el('cKind').value === 'cylinder'
      ? {kind: 'cylinder', diameter: 50, thickness: 6} : {kind: 'box', L: 90, W: 50, H: 20};
    mountProduct(collation, m);   // box<->cylinder swap re-renders the dim fields
    m.onInput();
  });
  if(isCyl){
    el('cD').addEventListener('input', () => { collation.piece.diameter = mm('cD'); m.onInput(); });
    el('cT').addEventListener('input', () => { collation.piece.thickness = mm('cT'); m.onInput(); });
  }else{
    el('cL').addEventListener('input', () => { collation.piece.L = mm('cL'); m.onInput(); });
    el('cW').addEventListener('input', () => { collation.piece.W = mm('cW'); m.onInput(); });
    el('cH').addEventListener('input', () => { collation.piece.H = mm('cH'); m.onInput(); });
  }
  el('cPer').addEventListener('input', () => { collation.perStack = cnt('cPer'); m.onInput(); });
  el('cAxis').addEventListener('change', () => { collation.stackAxis = el('cAxis').value; m.onInput(); });
  el('cNx').addEventListener('input', () => { collation.nx = cnt('cNx'); m.onInput(); });
  el('cNy').addEventListener('input', () => { collation.ny = cnt('cNy'); m.onInput(); });
  el('cSg').addEventListener('input', () => { collation.stackGap = mm('cSg'); m.onInput(); });
  el('cPg').addEventListener('input', () => { collation.pieceGap = mm('cPg'); m.onInput(); });
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
