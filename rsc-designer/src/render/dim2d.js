/**
 * THE annotation helpers for the multiview drawings — one dimension callout
 * (line, two end ticks, centred label) and one leader callout (a line from a
 * feature out to a label).
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
 * `opts.label` NAMES the dimension ('BASE 124.6', 'CELL W 50'). An unnamed
 * callout beside another of similar size is genuinely ambiguous — a 50 under
 * an elevation reads as an overall until something says CELL W — so every
 * dimension that is not self-evidently the envelope carries one.
 *
 * `opts.key` is for tests: it tags the label `data-dim="<key>"` so a pin can
 * read the value the drawing RENDERED, by name, instead of pattern-matching
 * the SVG. With neither option the markup is byte-identical to what
 * product2d.js emitted before the move.
 */

export const DIM_C = 'var(--ink-2)';

/**
 * @param {'h'|'v'} orient
 * @param {number} x1,y1,x2,y2  world mm; 'h' uses y1 for the line, 'v' uses x1
 * @param {string} val          the formatted value (already unit-converted)
 * @param {number} dimFS  label font size    @param {number} dw  stroke width
 * @param {number} tick   end-tick half length
 * @param {{key?: string, label?: string}} [opts]
 * @returns {string} SVG markup ('' when the span is too short to letter)
 */
export function dimLine(orient, x1, y1, x2, y2, val, dimFS, dw, tick, opts = {}){
  const kd = opts.key ? ` data-dim="${opts.key}"` : '';
  // the NAME rides in front of the number, in the same type at the same size:
  // a dimension callout, not a note about one
  const txt = opts.label ? `${opts.label} ${val}` : val;
  if(orient === 'h'){
    if(x2 - x1 < dimFS*0.9) return '';
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y1}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<line x1="${x1}" y1="${y1 - tick}" x2="${x1}" y2="${y1 + tick}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<line x1="${x2}" y1="${y1 - tick}" x2="${x2}" y2="${y1 + tick}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<text${kd} x="${(x1 + x2)/2}" y="${y1 - dimFS*0.45}" fill="${DIM_C}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle">${txt}</text>`;
  }
  if(y2 - y1 < dimFS*0.9) return '';
  const cy = (y1 + y2)/2, tx = x1 - dimFS*0.45;
  return `<line x1="${x1}" y1="${y1}" x2="${x1}" y2="${y2}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<line x1="${x1 - tick}" y1="${y1}" x2="${x1 + tick}" y2="${y1}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<line x1="${x1 - tick}" y1="${y2}" x2="${x1 + tick}" y2="${y2}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<text${kd} x="${tx}" y="${cy}" fill="${DIM_C}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle" transform="rotate(-90 ${tx} ${cy})">${txt}</text>`;
}

/**
 * A LEADER callout: an elbowed line from a point on the part out to a label.
 *
 * For the features a dimension line cannot letter — a 2.5mm flange or a 3mm
 * divider on a 139mm sheet, where the ticks would be further apart than the
 * span they bound (dimLine suppresses those outright, which is why they need
 * this instead). Also the only sane way to state a non-linear quantity like
 * a draft ANGLE, which has no two ends to tick.
 *
 * @param {number} px,py   the point on the part being called out
 * @param {number} lx,ly   where the label sits
 * @param {string} text    the whole label, already formatted
 * @param {number} dimFS,dw
 * @param {{key?: string, anchor?: 'start'|'end'|'middle'}} [opts]
 */
export function leader(px, py, lx, ly, text, dimFS, dw, opts = {}){
  const kd = opts.key ? ` data-dim="${opts.key}"` : '';
  const anchor = opts.anchor || (lx < px ? 'end' : 'start');
  const pad = dimFS*0.35*(anchor === 'end' ? -1 : 1);
  return `<polyline points="${px},${py} ${lx},${ly} ${lx + pad*1.6},${ly}" fill="none" ` +
      `stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<circle cx="${px}" cy="${py}" r="${dw*1.6}" fill="${DIM_C}"/>` +
    `<text${kd} x="${lx + pad*2.2}" y="${ly + dimFS*0.34}" fill="${DIM_C}" ` +
      `font-family="var(--mono)" font-size="${dimFS*0.92}" text-anchor="${anchor}">${text}</text>`;
}
