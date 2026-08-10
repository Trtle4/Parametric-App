/**
 * Shrink Bundle — a FLEXIBLE film skin drawn down over a bundle of units
 * (cartons, or a collation of cans) with no tray or case. This is NOT flow
 * wrap: shrink is a non-directional draw-down skin over the whole bundle from
 * every side — no fin, no end seals, no crimp, no machine direction. It closes
 * loosely to the bundle's bounding envelope, bridging gaps and tenting slightly
 * over the top; the film thickness adds negligibly to the outer dims (unlike
 * flow wrap's seal compensation), so outer == inner (the packed envelope).
 *
 * The film area is the bundle's enclosing surface plus a draw-down/overlap
 * allowance (a percentage overage), reported for material cost like the other
 * styles' readouts. Film substance (gauge µm, density g/cm³) drives the mass,
 * exactly as flow wrap's does — but with none of the seal machinery.
 *
 * All lengths mm except gauge (µm), density (g/cm³) and drawdown (%).
 */

/**
 * @param {Object} p  {L, W, H, drawdown(%), gauge(µm), density(g/cm³)}
 * @returns {import('../types.js').Geometry}
 */
export function shrinkBundle(p){
  const {L, W, H} = p;
  const drawdown = p.drawdown != null ? p.drawdown : 10;   // % film overage (overlap + tenting)

  // Enclosing skin surface — every face of the bounding bundle. Draw-down and
  // the wrap-around overlap are a percentage overage on top of it.
  const surface = 2*(L*W + L*H + W*H);
  const filmArea = surface*(1 + drawdown/100);             // mm²

  // 2D "blank": a shrink skin has NO die — this is the flat film sheet that
  // wraps the girth (2·(L+W)) and rises over the height plus a tuck over the
  // top and bottom edges. A representative rectangle, not a scored dieline
  // (crease is empty, like every flexible style).
  const tuck = Math.min(L, W)/2;                           // draw-down reach over the top/bottom edges
  const flatW = 2*(L + W);                                 // girth (wrap-around)
  const flatH = H + 2*tuck;
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
      film: {
        surfaceM2: surface/1e6,
        filmAreaM2: filmArea/1e6,
        drawdownPct: drawdown,
        massPer1000g: (filmArea/1e6)*(p.gauge || 0)*(p.density || 0)*1000   // m²·µm·g/cm³ = g
      },
      labels: [{x: flatW/2, y: flatH/2, text: 'SHRINK FILM'}],
      hDims: [{from: 0, to: flatW, v: flatW}],
      vDims: [{from: 0, to: flatH, v: flatH}],
      print: {x0: 0, x1: flatW, y0: tuck, y1: tuck + H}    // the side band (a printable zone)
    }
  };
}
