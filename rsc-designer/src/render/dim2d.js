/**
 * THE dimension callout for the multiview drawings — one line, two end ticks,
 * one centred label.
 *
 * Lifted verbatim out of product2d.js when the tray got its own multiview, so
 * the two sibling drawings share ONE annotation renderer rather than a second
 * copy that agrees until someone re-tunes a tick. (dieline2d.js keeps its own
 * private dimH/dimV: those are closures over ITS world-to-svg flip and draw
 * one shared row/column for a whole blank, not one per view tile. Two
 * genuinely different jobs; this is the one the tile drawings share.)
 *
 * Plain Y-DOWN world coordinates — no flip. The caller supplies the drawing's
 * resolved scale (`dimFS` font size, `dw` stroke width, `tick` end-tick half
 * length) so a callout matches the drawing it lands in.
 *
 * `key` is optional and purely for tests: it tags the label with
 * `data-dim="<key>"` so a pin can read the value the drawing actually
 * RENDERED, by name, instead of pattern-matching the SVG text. Omitted, the
 * markup is byte-identical to what product2d.js emitted before the move.
 */

export const DIM_C = 'var(--ink-2)';

/**
 * @param {'h'|'v'} orient
 * @param {number} x1,y1,x2,y2  world mm; 'h' uses y1 for the line, 'v' uses x1
 * @param {string} val          the formatted label (already unit-converted)
 * @param {number} dimFS  label font size    @param {number} dw  stroke width
 * @param {number} tick   end-tick half length
 * @param {string} [key]  optional data-dim tag on the label
 * @returns {string} SVG markup ('' when the span is too short to letter)
 */
export function dimLine(orient, x1, y1, x2, y2, val, dimFS, dw, tick, key){
  const kd = key ? ` data-dim="${key}"` : '';
  if(orient === 'h'){
    if(x2 - x1 < dimFS*0.9) return '';
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y1}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<line x1="${x1}" y1="${y1 - tick}" x2="${x1}" y2="${y1 + tick}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<line x1="${x2}" y1="${y1 - tick}" x2="${x2}" y2="${y1 + tick}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<text${kd} x="${(x1 + x2)/2}" y="${y1 - dimFS*0.45}" fill="${DIM_C}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle">${val}</text>`;
  }
  if(y2 - y1 < dimFS*0.9) return '';
  const cy = (y1 + y2)/2, tx = x1 - dimFS*0.45;
  return `<line x1="${x1}" y1="${y1}" x2="${x1}" y2="${y2}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<line x1="${x1 - tick}" y1="${y1}" x2="${x1 + tick}" y2="${y1}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<line x1="${x1 - tick}" y1="${y2}" x2="${x1 + tick}" y2="${y2}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<text${kd} x="${tx}" y="${cy}" fill="${DIM_C}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle" transform="rotate(-90 ${tx} ${cy})">${val}</text>`;
}
