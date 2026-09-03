/**
 * Layer plan — a top-down SCHEMATIC of one pallet layer's case footprints
 * against the deck, drawn from core/layerplan.js's `layerPlanGeometry()`
 * (the one shared computation every consumer reads — see that file's own
 * doc comment). This is a DIFFERENT drawing from the 3D render's own top/
 * overhead camera view: that is a photographic capture of the real scene;
 * this is a flat vector diagram, cheap to build, embeddable as-is in the
 * Pallet PDF's vector content stream (see export/palletpdf.js's own
 * `layerPlanPdfOps`, which walks the SAME geometry object this module
 * draws) and safe to build many-of at once for a thumbnail grid.
 *
 * Plain Y-DOWN world mm, like every other 2D module here — dieline2d.js's
 * generic flip machinery is for a blank's own drawing frame, not this one.
 *
 * Cases are drawn CENTRED at (x,y) — `layerPlanGeometry`'s own convention,
 * itself inherited from palletpatterns.js's "deck-centred positions".
 */
export const LAYERPLAN_DECK_COLOR = 'var(--line)';
export const LAYERPLAN_CASE_COLOR = 'var(--accent)';

/**
 * Pick a tile size that TRACKS the deck's own aspect ratio, clamped to a
 * PRACTICAL range so one extreme deck cannot blow a thumbnail grid's row
 * height out for every tile beside it (a 10:1 deck renders at the clamp's
 * own aspect, still letterboxed some, rather than a 10x-tall tile). A deck
 * whose aspect already falls inside the clamp gets a tile of EXACTLY that
 * aspect, so `layerPlanSVG`'s own contain-fit (below) has nothing left to
 * letterbox — the two are meant to be used together, this picks the canvas,
 * that fits the drawing into it.
 */
export function layerPlanTileSize(pallet, opts = {}){
  const {baseWidth = 168, minAspect = 0.6, maxAspect = 1.8} = opts;
  const aspect = Math.min(maxAspect, Math.max(minAspect, pallet.L/pallet.W));
  return {width: baseWidth, height: Math.round(baseWidth/aspect)};
}

/**
 * @param {{cases: Array<{x:number,y:number,w:number,h:number}>, envelope:{L:number,W:number}}} geometry
 *        core/layerplan.js's layerPlanGeometry() result
 * @param {{L:number,W:number}} pallet  the deck's own L/W (mm) — the frame
 *        cases are drawn against, independent of the candidate's own
 *        envelope (a candidate can under-fill the deck; the drawing should
 *        show that, not crop to the cases alone)
 * @param {{width?:number, height?:number, margin?:number, showDims?:boolean}} [opts]
 * @returns {string} a standalone `<svg>...</svg>` string
 *
 * CONTAIN, not cover: `scale` is the MIN of the two axis ratios, so the
 * whole deck — and everything drawn against it, both here — fits inside
 * the canvas with room to spare on whichever axis has slack, rather than
 * filling one axis and cropping the other. `Math.max` here would be a
 * fit-to-width/cover transform and would crop; do not change this to `max`.
 * ONE `scale`/`sx`/`sy` for BOTH the deck outline and every case rect below
 * — they cannot disagree on where a point in deck-mm lands, because there
 * is only one transform to disagree with.
 */
export function layerPlanSVG(geometry, pallet, opts = {}){
  const {width = 220, height = 170, margin = 14, showDims = false} = opts;
  const deckL = pallet.L, deckW = pallet.W;
  const availW = width - 2*margin, availH = height - 2*margin;
  const scale = Math.min(availW/deckL, availH/deckW);
  const ox = width/2, oy = height/2;                 // deck centre -> svg centre
  const sx = mmX => ox + mmX*scale;
  const sy = mmY => oy + mmY*scale;

  const deckX0 = sx(-deckL/2), deckY0 = sy(-deckW/2);
  const deckRect = `<rect x="${deckX0}" y="${deckY0}" width="${deckL*scale}" height="${deckW*scale}" ` +
    `fill="none" stroke="${LAYERPLAN_DECK_COLOR}" stroke-width="1.25" stroke-dasharray="3,2"/>`;

  const caseRects = geometry.cases.map((c, i) => {
    const x0 = sx(c.x - c.w/2), y0 = sy(c.y - c.h/2);
    return `<rect data-case="${i}" x="${x0}" y="${y0}" width="${c.w*scale}" height="${c.h*scale}" ` +
      `fill="rgba(15,110,119,0.18)" stroke="${LAYERPLAN_CASE_COLOR}" stroke-width="1"/>`;
  }).join('');

  const dims = showDims
    ? `<text x="${width/2}" y="${height - 3}" fill="var(--ink-3)" font-family="var(--mono)" ` +
      `font-size="8" text-anchor="middle">${Math.round(deckL)} × ${Math.round(deckW)} mm deck</text>`
    : '';

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `xmlns="http://www.w3.org/2000/svg" data-layerplan="1" data-cases="${geometry.cases.length}">` +
    deckRect + caseRects + dims + `</svg>`;
}
