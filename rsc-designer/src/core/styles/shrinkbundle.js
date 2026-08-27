/**
 * Shrink Bundle — a FLEXIBLE film skin drawn down over a bundle of units
 * (cartons, or a collation of cans) with no tray or case. This is NOT flow
 * wrap: shrink is a non-directional draw-down skin over the whole bundle from
 * every side — no fin, no end seals, no crimp, no machine direction. It closes
 * loosely to the bundle's bounding envelope, bridging gaps and tenting slightly
 * over the top; the film thickness adds negligibly to the outer dims (unlike
 * flow wrap's seal compensation), so outer == inner (the packed envelope).
 *
 * FILM AXIS is a model fact, not a render setting — a single fact with one
 * writer (this function), consumed by the 2D flat/cut, the 3D skin, and the
 * film weight/cost. `filmAxis: 'vertical'` is the ORIGINAL, only-ever-shipped
 * shape: a tube around the four SIDES (girth 2·(L+W)) with film tucked over
 * the top and bottom. A real bull's-eye bundle is the opposite: a HORIZONTAL
 * tube along L or W, with the two open ends drawing down to a gathered hole
 * instead of tucking over an edge. Switching the axis changes which faces the
 * girth wraps and which two faces are open, so it changes the girth, the flat
 * film size, the film area, the film mass and the cost — see FILM_AXES below.
 * `vertical` is the migration default: it must reproduce this style's
 * original numbers exactly, so no existing save or golden moves until a user
 * actually changes the axis.
 *
 * TUCK vs OPEN ENDS: the original geometry adds a `tuck` reach
 * (min(L,W)/2) to the flat pattern's run dimension, modelling film folded
 * OVER the top/bottom edge before the % draw-down allowance ever applies —
 * a real, separate quantity from `drawdown` (which is the doc'd "overlap +
 * tenting" allowance on the ENCLOSING SURFACE, not the flat cut). An
 * open-ended horizontal sleeve does not fold over an edge at all — the film
 * draws IN to a gathered point, which is a different physical event with no
 * equivalent "reach past the edge" term in this model. Per the task: this
 * does not transfer, so it is not reused for 'L'/'W' — tuck stays zero
 * there rather than repurposing it. The same asymmetry applies to the two
 * end faces' contribution to film area: 'vertical' charges a real, closed
 * cap (the film that gets tucked over) on top of the girth-wrap surface;
 * an open end has no equivalent separate closure panel — the girth wrap
 * itself is what gathers into the bull's-eye — so 'L'/'W' charge zero
 * additional cap area rather than inventing an unspecified reduction of one.
 *
 * All lengths mm except gauge (µm), density (g/cm³) and drawdown (%).
 */

/** Every axis the film sleeve can run along. A single discriminant (not a
 *  per-axis boolean) so an "unrepresentable" combination never needs a
 *  validation rule to rule out. axisGeometry is the ONE place allowed to
 *  branch on it; an enum member not in this list throws immediately rather
 *  than silently resolving to another axis's numbers. */
export const FILM_AXES = ['L', 'W', 'vertical'];

/**
 * The per-axis facts every other computation in this file (and the 3D
 * renderer) derives from: which dimension the sleeve runs along (`run`),
 * the wrap-around distance (`girth`), and how much CLOSED cap area each end
 * contributes (`capArea` — real for the tucked vertical ends, zero for an
 * open, gathered horizontal end — see the module doc for why that is not
 * an oversight).
 * @returns {{run:number, girth:number, capArea:number, tuck:number}}
 */
function axisGeometry(L, W, H, filmAxis){
  switch(filmAxis){
    case 'vertical': return {run: H, girth: 2*(L + W), capArea: L*W, tuck: Math.min(L, W)/2};
    case 'L':        return {run: L, girth: 2*(W + H), capArea: 0,   tuck: 0};
    case 'W':        return {run: W, girth: 2*(L + H), capArea: 0,   tuck: 0};
    default: throw new Error(`shrinkBundle: unhandled filmAxis "${filmAxis}"`);
  }
}

/**
 * @param {Object} p  {L, W, H, drawdown(%), gauge(µm), density(g/cm³), filmAxis}
 * @returns {import('../types.js').Geometry}
 */
export function shrinkBundle(p){
  const {L, W, H} = p;
  const drawdown = p.drawdown != null ? p.drawdown : 10;   // % film overage (overlap + tenting)
  const filmAxis = p.filmAxis || 'vertical';                // absent = the migration default, bit-identical to the original geometry

  const {run, girth, capArea, tuck} = axisGeometry(L, W, H, filmAxis);

  // Enclosing skin surface — the continuous girth wrap along `run`, plus the
  // two end caps (real, closed material for 'vertical'; zero for an open,
  // gathered end — see the module doc). Draw-down and the wrap-around
  // overlap are a percentage overage on top of it, same as before.
  const surface = girth*run + 2*capArea;
  const filmArea = surface*(1 + drawdown/100);             // mm²

  // 2D "blank": a shrink skin has NO die — this is the flat film sheet that
  // wraps the girth and rises along the run axis, plus a tuck reach ONLY
  // when that axis actually folds over an edge (vertical). A representative
  // rectangle, not a scored dieline (crease is empty, like every flexible
  // style).
  const flatW = girth;
  const flatH = run + 2*tuck;
  const cut = [[0, 0], [flatW, 0], [flatW, flatH], [0, flatH]];

  return {
    structure: 'flexible',
    cut,
    crease: [],                                            // film is never scored
    bbox: {minX: 0, minY: 0, maxX: flatW, maxY: flatH},
    inner: {L, W, H},
    outer: {L, W, H},                                      // thin film — negligible growth
    meta: {
      style: 'shrinkbundle',
      caliper: 0,
      // a shrink bundle has no board — but it IS an enclosing skin (all sides),
      // so it is NOT open-top: boardLayersTop stays 0 only in the sense of "no
      // rigid lid"; the render keys on meta.style === 'shrinkbundle', not this.
      shrink: true,
      filmAxis,                                             // the ONE fact the 3D bull's-eye placement reads — never hardcoded there
      film: {
        surfaceM2: surface/1e6,
        filmAreaM2: filmArea/1e6,
        drawdownPct: drawdown,
        girth,                                              // exposed for readouts/pins — the axis-dependent wrap-around distance
        massPer1000g: (filmArea/1e6)*(p.gauge || 0)*(p.density || 0)*1000   // m²·µm·g/cm³ = g
      },
      labels: [{x: flatW/2, y: flatH/2, text: 'SHRINK FILM'}],
      hDims: [{from: 0, to: flatW, v: flatW}],
      vDims: [{from: 0, to: flatH, v: flatH}],
      print: {x0: 0, x1: flatW, y0: tuck, y1: tuck + run}   // the side band (a printable zone) — `run`, not the literal H, so this stays correct for a horizontal axis too
    }
  };
}
