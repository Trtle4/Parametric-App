/** mm <-> inch conversion and display formatting. The core is mm-only;
 *  these helpers are the ONLY place unit conversion happens. */

export const MM_PER_IN = 25.4;

/** Convert a value in the given display unit to mm. */
export const toMM = (v, unit) => unit === 'in' ? v * MM_PER_IN : v;

/** Convert a mm value to the given display unit. */
export const fromMM = (v, unit) => unit === 'in' ? v / MM_PER_IN : v;

/** Format a mm length for display: whole mm, or inches to 2 dp (trailing
 *  zeros dropped) — matches the original draw2d() fmt(). */
export function fmtLen(vmm, unit){
  const dp = unit === 'mm' ? 0 : 2;
  return (+fromMM(vmm, unit).toFixed(dp)).toString();
}

/** Format a value for an <input> after a unit switch — matches the original
 *  switchUnits() rounding: inches to 3 dp trimmed, mm to 2 dp. */
export function fmtInputValue(v, unit){
  return unit === 'in'
    ? v.toFixed(3).replace(/\.?0+$/, '')
    : (Math.round(v * 100) / 100).toString();
}
