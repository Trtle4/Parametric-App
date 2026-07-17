/**
 * FEFCO 0300 — simple die-cut tray, tertiary level. Single piece: a
 * rectangular base, four walls hinged up from the base edges, open top,
 * no lid, no tuck.
 *
 * Corner treatment: a plain rectangular glue tab, full separating cut, no
 * taper, no slot. The two LENGTH walls (hinged to the base's W-edges, each
 * spanning L) each carry a tab at BOTH of their own ends; the two WIDTH
 * walls (hinged to the base's L-edges, spanning W) are plain rectangles —
 * the receiving walls, no tabs of their own. Each tab is a rectangle of
 * width H (matching its parent wall's height, so it covers the adjacent
 * wall's full depth) and depth `cornerFlapDepth`, hinged to its parent wall
 * along a vertical line collinear with the adjacent width wall's own base
 * hinge, and cut free from that width wall along a straight edge reaching
 * the shared base corner — no diagonal, no notch.
 *
 * Fold order, and why the tab ends up flush against the RIGHT thing:
 *  1. The length wall folds up 90 deg about its own base hinge (horizontal).
 *     The tab, still attached, goes along for the ride — its own H-wide
 *     dimension becomes the vertical (height) dimension, matching the wall.
 *  2. The tab folds a SECOND, independent 90 deg about its own hinge to the
 *     wall (vertical, collinear with the width wall's own base hinge). This
 *     sweeps the tab's depth-reach from "further along the length wall" to
 *     "into the width wall's own W-span" — landing it in the exact plane
 *     the width wall occupies, at the same height range, positioned near
 *     whichever end (top or bottom) it came from.
 *  That second fold is what a single flared/tapered flap (no separate
 *  hinge) CANNOT do — it only re-orients if it has its own crease, distinct
 *  from the wall's crease. This is why the tab needs an independent hinge
 *  and why the receiving width wall needs no tab of its own.
 *  Consequence for the cap: the tab's reach (cornerFlapDepth) lands along
 *  the WIDTH wall's own W-span, not H — so it is capped at W/2 (so the two
 *  tabs landing on the same width wall, from its top and bottom ends,
 *  never meet), not min(H, W/2).
 *
 * All lengths mm. Implements the Geometry contract in core/types.js.
 */

/**
 * @param {Object} p  {L, W, H, caliper, cornerFlapDepth}
 * @returns {import('../types.js').Geometry}
 */
export function trayGeometry(p){
  const {L, W, H} = p;
  const t = p.caliper;

  // tab depth: capped at W/2 -- see file doc comment for why H is not
  // part of this cap (the tab's H-wide face always exactly matches the
  // wall it glues behind; only its W-direction reach needs limiting).
  const td = Math.max(0, Math.min(p.cornerFlapDepth, W/2));

  // shift so the shape's own bbox starts at (0,0) — dieline2d.js's generic
  // hDims/vDims placement hardcodes world y=0 / x=bbox.maxX as "the blank's
  // own edge" (true for every existing style); this tray's own base sits at
  // (H,H), not (0,0), specifically so that assumption keeps holding.
  const O = H;
  const bx0 = O, bx1 = O + L, by0 = O, by1 = O + W;   // base panel
  const lx = 0, rx = bx1 + H;                          // width walls' own outer edges
  const botY = 0, topY = by1 + H;                      // length walls' own outer edges

  // The tab (bx1..bx1+td at this corner) and the width wall's own hinge
  // (bx1..rx) share the SAME x, one above by0 (tab, hinged to the length
  // wall) and one below/through it (width wall, hinged to base) — both are
  // creases, not cuts, so the perimeter never needs to visit the base
  // corner itself: it steps straight from the tab's own outer edge to the
  // width wall's own (truncated) outer edge, the same way a step/ledge
  // reads on any two panels of different depth sharing one hinge line.
  const cut = [
    [bx0 - td, botY],                                   // BL tab outer-bottom corner
    [bx1 + td, botY],                                   // BR tab outer-bottom corner (single edge: both tabs +
                                                         // the bottom wall's own free edge, collinear at botY)
    [bx1 + td, by0],                                    // up BR tab's own outer edge
    [rx, by0],                                          // step: right width wall's own (truncated) bottom edge
    [rx, by1],                                          // up the right width wall's own outer edge
    [bx1 + td, by1],                                    // step: right width wall's own (truncated) top edge
    [bx1 + td, topY],                                   // up the TR tab's own outer edge
    [bx0 - td, topY],                                   // across the top (single edge: both tabs + the top
                                                         // wall's own free edge, collinear at topY)
    [bx0 - td, by1],                                    // down the TL tab's own outer edge
    [lx, by1],                                          // step: left width wall's own (truncated) top edge
    [lx, by0],                                          // down the left width wall's own outer edge
    [bx0 - td, by0]                                     // step: left width wall's own (truncated) bottom edge
  ]; // closes back to [bx0-td, botY] via the BL tab's own outer edge

  const crease = [
    [bx0, by0, bx0, by1], [bx1, by0, bx1, by1],           // base <-> width walls (left/right)
    [bx0, by0, bx1, by0], [bx0, by1, bx1, by1],           // base <-> length walls (bottom/top)
    [bx0, botY, bx0, by0], [bx1, botY, bx1, by0],         // length wall <-> its two corner tabs (bottom)
    [bx0, by1, bx0, topY], [bx1, by1, bx1, topY]          // length wall <-> its two corner tabs (top)
  ];

  // --- material compensation (outside dimensions of the erected tray) -----
  // Derived for an OPEN structure, not inherited from any closed box:
  //  * L and W: the same universal 4-wall body every rigid style has — one
  //    board thickness per wall on each axis (the WIDTH walls bound L, the
  //    LENGTH walls bound W)                                       -> +2t each.
  //    The corner tab's glued-in doubling is a LOCAL reinforcement at each
  //    corner (a small rectangle of extra board against the width wall's
  //    inside face) — it does not add a systematic second layer along the
  //    wall's full length, so it does not change this outer bounding number.
  //  * H: the base is a single flat sheet the walls rise from — it is the
  //    cavity's floor, one board layer thick, and there is nothing above
  //    the open top.  1 layer bottom + 0 layers top -> +t. Not the RSC's
  //    +4t: that number comes from a two-flap stack at each of two CLOSED
  //    ends; this tray has one closed end (the base) and one that simply
  //    isn't there.
  const outerH = H + t;

  const labels = [
    {x: (bx0 + bx1)/2, y: (by0 + by1)/2, text: 'BASE'},
    {x: (bx0 + bx1)/2, y: by0/2, text: 'WALL'},
    {x: (bx0 + bx1)/2, y: (topY + by1)/2, text: 'WALL'},
    {x: lx + H/2, y: (by0 + by1)/2, text: 'WALL'},
    {x: rx - H/2, y: (by0 + by1)/2, text: 'WALL'},
    ...(td > 0 ? [
      {x: (bx0 + (bx0 - td))/2, y: by0/2, text: 'TAB'},
      {x: (bx1 + (bx1 + td))/2, y: by0/2, text: 'TAB'},
      {x: (bx0 + (bx0 - td))/2, y: (topY + by1)/2, text: 'TAB'},
      {x: (bx1 + (bx1 + td))/2, y: (topY + by1)/2, text: 'TAB'}
    ] : [])
  ];

  return {
    structure: 'rigid',
    cut, crease,
    bbox: {minX: 0, minY: 0, maxX: rx, maxY: topY},
    inner: {L, W, H},
    outer: {L: L + 2*t, W: W + 2*t, H: outerH},
    meta: {
      style: 'tray',
      caliper: t,
      cornerFlapDepth: td,
      boardLayersBottom: 1,
      boardLayersTop: 0,
      // generic dieline annotations (style-agnostic renderer contract)
      labels,
      hDims: [
        {from: 0, to: H, v: H}, {from: H, to: H + L, v: L}, {from: H + L, to: rx, v: H}
      ],
      vDims: [
        {from: 0, to: H, v: H}, {from: H, to: H + W, v: W}, {from: H + W, to: topY, v: H}
      ],
      print: {x0: bx0, x1: bx1, y0: 0, y1: H}   // bottom wall — the tray's visible outer face
    }
  };
}
