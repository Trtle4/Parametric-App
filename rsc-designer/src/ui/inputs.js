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
let mounted = null;   // {style, params, options, effectiveDims, dimsReadOnly, onInput}

export const getUnit = () => unit;
export const getPalUnit = () => palUnit;

/* ---------- field construction, bound to a project level ---------- */

/** A numeric length (or fixedUnit) field, its value read from and written to
 *  the backing project object. Dimension fields may display a DERIVED value
 *  (the solved dims) and, when the level is solved, be read-only. */
function lengthField(d, params, m){
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const chip = d.fixedUnit || unit;
  const isDim = d.group === 'dims';
  const readOnly = isDim && m.dimsReadOnly;
  // solved dims show the derived value; everything else shows the stored param
  const showingDerived = isDim && m.effectiveDims && m.effectiveDims[d.key] != null;
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
 * @param {Object} m       {effectiveDims, dimsReadOnly, onInput({key,group})}
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

/** Re-mount the current level (after a unit switch): same binding, values
 *  re-read from the project and re-displayed in the now-current unit. */
export function remount(){ if(mounted) mountLevel(mounted.style, mounted.params, mounted.options, mounted); }

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
