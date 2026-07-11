/**
 * The ONLY module that touches the DOM for parameters. Reads inputs once,
 * converts to mm, and produces plain objects for everything below ui/.
 */
import {toMM, fmtInputValue} from '../core/units.js';

export const el = id => document.getElementById(id);

const PAL_RE = /(\d+(?:\.\d+)?)\s*[x×*,]\s*(\d+(?:\.\d+)?)/i;

// display-unit state (what the fields currently show)
let unit = 'mm';
let palUnit = 'in';

export const getUnit = () => unit;
export const getPalUnit = () => palUnit;

/**
 * Snapshot of everything the app needs, lengths all in mm.
 * @returns {{
 *   params: import('../core/types.js').Params,
 *   unit: 'mm'|'in', palUnit: 'mm'|'in',
 *   printText: string, outerFlaps: 'L'|'W',
 *   pattern: 'optimal'|'column'|'interlock',
 *   pallet: {L:number, W:number, maxH:number}
 * }}
 */
export function readState(){
  const n = id => +el(id).value || 0;
  const params = {
    L: toMM(n('L'), unit), W: toMM(n('W'), unit), H: toMM(n('H'), unit),
    caliper: toMM(n('cal'), unit), glue: toMM(n('glue'), unit), slot: toMM(n('slot'), unit)
  };
  const m = (el('pal').value || '').match(PAL_RE);
  const a = m ? +m[1] : (palUnit === 'mm' ? 1219.2 : 48); // fall back to 48x40 in
  const b = m ? +m[2] : (palUnit === 'mm' ? 1016 : 40);
  return {
    params, unit, palUnit,
    printText: (el('txt').value || '').trim(),
    outerFlaps: el('outer').value,
    pattern: el('palPattern').value,
    pallet: {L: toMM(a, palUnit), W: toMM(b, palUnit), maxH: toMM(n('palMaxH'), palUnit)}
  };
}

/** Convert the box input fields to the unit currently selected in #units. */
export function switchUnits(){
  const next = el('units').value;
  if(next === unit) return false;
  const k = (unit === 'mm' && next === 'in') ? 1/25.4 : (unit === 'in' && next === 'mm') ? 25.4 : 1;
  ['L', 'W', 'H', 'cal', 'glue', 'slot'].forEach(id => {
    const v = +el(id).value || 0;
    el(id).value = fmtInputValue(v*k, next);
  });
  unit = next;
  ['uL', 'uW', 'uH', 'uCal', 'uGlue', 'uSlot'].forEach(id => el(id).textContent = unit);
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
