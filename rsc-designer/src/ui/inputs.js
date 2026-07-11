/**
 * The ONLY module that touches the DOM for parameters. Builds the input
 * fields from the active style's registry descriptors, reads them once,
 * converts to mm, and produces plain objects for everything below ui/.
 */
import {toMM, fromMM, fmtInputValue} from '../core/units.js';
import {styles} from '../core/styles/index.js';

export const el = id => document.getElementById(id);

const PAL_RE = /(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)/i;

// display-unit state (what the fields currently show)
let unit = 'mm';
let palUnit = 'in';
let style = styles[0];
let fields = [];   // {descriptor, input, unitSpan}  numeric length params
let selects = [];  // {descriptor, input}            select params + options

export const getUnit = () => unit;
export const currentStyle = () => style;

/* ---------- dynamic field construction ---------- */
function lengthField(d){
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.innerHTML = `<label>${d.label} <span class="hint">${d.hint || ''}</span></label>
    <div class="inp"><input id="p_${d.key}" type="number" min="${d.min}" step="${d.step}"><span class="unit">${unit}</span></div>`;
  const input = wrap.querySelector('input'), unitSpan = wrap.querySelector('.unit');
  input.value = fmtInputValue(fromMM(d.default, unit), unit);
  fields.push({d, input, unitSpan});
  return wrap;
}
function selectField(d, origin){
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.innerHTML = `<label>${d.label} <span class="hint">${d.hint || ''}</span></label>
    <div class="inp"><select id="p_${d.key}">${
      d.choices.map(c => `<option value="${c.value}">${c.label}</option>`).join('')
    }</select></div>`;
  const input = wrap.querySelector('select');
  input.value = d.default;
  selects.push({d, input, origin});
  return wrap;
}

/** (Re)build all style-driven fields. onInput/onChange wire app refreshes. */
export function setStyle(s, onInput, onChange){
  style = s;
  fields = []; selects = [];
  const dims = el('dimFields'), mat = el('matFields'), opt = el('optFields');
  dims.innerHTML = ''; mat.innerHTML = ''; opt.innerHTML = '';
  for(const d of s.params){
    const target = d.group === 'dims' ? dims : mat;
    target.appendChild(d.type === 'select' ? selectField(d, 'param') : lengthField(d));
  }
  for(const d of s.options || []){
    opt.appendChild(selectField(d, 'option'));
  }
  fields.forEach(f => f.input.addEventListener('input', onInput));
  selects.forEach(f => f.input.addEventListener('change', onChange));
}

/* ---------- state snapshot (mm) ---------- */
export function readState(){
  const params = {};
  for(const f of fields) params[f.d.key] = toMM(+f.input.value || 0, unit);
  const options = {};
  for(const s2 of selects)
    (s2.origin === 'param' ? params : options)[s2.d.key] = s2.input.value;

  const m = (el('pal').value || '').match(PAL_RE);
  const a = m ? +m[1] : (palUnit === 'mm' ? 1219.2 : 48); // fall back to 48x40 in
  const b = m ? +m[2] : (palUnit === 'mm' ? 1016 : 40);
  return {
    style, params, options, unit, palUnit,
    printText: (el('txt').value || '').trim(),
    pattern: el('palPattern').value,
    pallet: {L: toMM(a, palUnit), W: toMM(b, palUnit), maxH: toMM(+el('palMaxH').value || 0, palUnit)}
  };
}

/* ---------- unit switching ---------- */
/** Convert the style input fields to the unit currently selected in #units. */
export function switchUnits(){
  const next = el('units').value;
  if(next === unit) return false;
  const k = (unit === 'mm' && next === 'in') ? 1/25.4 : (unit === 'in' && next === 'mm') ? 25.4 : 1;
  for(const f of fields){
    const v = +f.input.value || 0;
    f.input.value = fmtInputValue(v*k, next);
    f.unitSpan.textContent = next;
  }
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
