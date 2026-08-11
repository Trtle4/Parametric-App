/**
 * FEFCO 0300 — die-cut tray, tertiary level. Rebuilt from a real reference
 * dieline DXF (Cut + Crease layers), so the corner construction is CONFIRMED,
 * not inferred. Single piece: a rectangular BASE, four WALLs folding up, and
 * four corner TABs that fold in.
 *
 * Reference geometry (normalised so the base's inner corner is the origin):
 *  - Base is L × W. Four creases bound it: two horizontal (base top/bottom
 *    edges, length L) and two vertical (base left/right edges, length W).
 *  - Each of the four walls is a rectangle extending outward from a base edge
 *    by the wall depth H.
 *  - The TOP and BOTTOM walls (folding on the horizontal creases) carry a
 *    corner tab at each end — a rectangular extension continuing past the base
 *    corner. Between each tab and the adjacent LEFT/RIGHT wall there is a
 *    FULL-DEPTH cut gap (the reference shows ~13 units), running from the
 *    wall's free edge down to the base crease line, so tab and wall fold
 *    independently.
 *  - The LEFT and RIGHT walls (folding on the vertical creases) are plain
 *    rectangles, no tabs — the receiving walls.
 *
 * Fold, and where the tabs end up:
 *  1. The four walls fold up 90° about the four base creases.
 *  2. Each corner tab folds IN about the horizontal crease line it shares with
 *     its wall (the crease runs full-width in the reference precisely so the
 *     tab has a fold), sweeping in against the INSIDE of the adjacent left/
 *     right wall, where it is glued/held. This is why the tab needs the full
 *     cut gap (to clear the side wall as it folds) and why the side walls have
 *     no tabs of their own.
 *
 * Parametric choices (derived from the reference, none hardcoded):
 *  - Wall depth H is uniform (the reference's 62–67 spread is hand-drawing
 *    slop, treated as one H).
 *  - Corner tab width = H − cornerGap/2: the tab reaches to half a gap short
 *    of the crease (H minus a fold clearance), matching the DXF.
 *  - cornerGap is a PARAMETER — the corner slot width, i.e. the fold clearance
 *    between tab and side wall. It affects only the internal notches, never
 *    the blank's outer extent (L+2H)×(W+2H). Default ≈ 2·caliper.
 *
 * All lengths mm. Implements the Geometry contract in core/types.js.
 */

/**
 * @param {Object} p  {L, W, H, caliper, cornerGap}
 * @returns {import('../types.js').Geometry}
 */
export function trayGeometry(p){
  const {L, W, H} = p;
  const t = p.caliper;

  // corner slot width (fold clearance). Absent -> 2·caliper. Clamp so the two
  // slots on a side never overlap (< L) and a tab still has width (< 2H).
  const gRaw = p.cornerGap != null ? p.cornerGap : 2*t;
  const g = Math.max(0, Math.min(gRaw, 0.8*L, 1.6*H));
  const hg = g/2;

  // shift so the shape's own bbox starts at (0,0) — dieline2d.js's generic
  // hDims/vDims placement treats world y=0 / x=bbox.maxX as the blank's own
  // edge; offsetting the base to (H,H) keeps that true.
  const O = H;
  const bx0 = O, bx1 = O + L, by0 = O, by1 = O + W;   // base panel corners
  const xR1 = bx1 + H, yT1 = by1 + H;                  // blank right / top edges (bbox max)

  // CUT: the outer rectangle [0,xR1]×[0,yT1] with a full-depth slot notched at
  // each corner, centred on the vertical crease line (x=bx0 / x=bx1), running
  // from the free edge (y=0 / y=yT1) to the horizontal crease (y=by0 / y=by1).
  // 20-vertex single closed loop, CCW from the bottom-left blank corner.
  const cut = [
    [0, 0],
    [bx0 - hg, 0], [bx0 - hg, by0], [bx0 + hg, by0], [bx0 + hg, 0],   // bottom-left slot
    [bx1 - hg, 0], [bx1 - hg, by0], [bx1 + hg, by0], [bx1 + hg, 0],   // bottom-right slot
    [xR1, 0],
    [xR1, yT1],
    [bx1 + hg, yT1], [bx1 + hg, by1], [bx1 - hg, by1], [bx1 - hg, yT1],   // top-right slot
    [bx0 + hg, yT1], [bx0 + hg, by1], [bx0 - hg, by1], [bx0 - hg, yT1],   // top-left slot
    [0, yT1]
  ]; // closes back to [0,0] down the left blank edge

  // CREASE: the four base-bounding folds (bottom/top length L, left/right
  // length W) PLUS the four tab folds (the horizontal crease's extensions over
  // the corner tabs, length H each). Together the base + tab horizontal folds
  // reproduce the reference's full-width horizontal crease lines, while the
  // base folds alone carry the 2·(L+W) girth the tray closes on.
  const crease = [
    [bx0, by0, bx0, by1], [bx1, by0, bx1, by1],           // base <-> left/right walls (length W)
    [bx0, by0, bx1, by0], [bx0, by1, bx1, by1],           // base <-> bottom/top walls (length L)
    [0, by0, bx0, by0], [bx1, by0, xR1, by0],             // bottom wall <-> its two corner tabs (length H)
    [0, by1, bx0, by1], [bx1, by1, xR1, by1]              // top wall <-> its two corner tabs (length H)
  ];

  // --- material compensation (outside dimensions of the erected tray) -----
  // Open structure, derived not inherited:
  //  * L and W: one board thickness per wall on each axis (left/right walls
  //    bound L, bottom/top walls bound W) -> +2t each. The glued-in corner tab
  //    is a LOCAL doubling against the side wall, not a systematic second layer
  //    along the wall's length, so it does not change this outer bound.
  //  * H: the base is a single flat sheet the walls rise from — the cavity
  //    floor, one board layer, nothing above the open top. +t. (Not the RSC's
  //    +4t: that is a two-flap stack at two CLOSED ends; this tray has one
  //    closed end, the base, and one that simply isn't there.)
  const outerH = H + t;

  const labels = [
    {x: (bx0 + bx1)/2, y: (by0 + by1)/2, text: 'BASE'},
    {x: (bx0 + bx1)/2, y: by0/2, text: 'WALL'},
    {x: (bx0 + bx1)/2, y: (yT1 + by1)/2, text: 'WALL'},
    {x: bx0/2, y: (by0 + by1)/2, text: 'WALL'},
    {x: (xR1 + bx1)/2, y: (by0 + by1)/2, text: 'WALL'},
    ...(g < 2*H ? [   // tab labels only when a tab actually exists
      {x: (0 + (bx0 - hg))/2, y: by0/2, text: 'TAB'},
      {x: ((bx1 + hg) + xR1)/2, y: by0/2, text: 'TAB'},
      {x: (0 + (bx0 - hg))/2, y: (yT1 + by1)/2, text: 'TAB'},
      {x: ((bx1 + hg) + xR1)/2, y: (yT1 + by1)/2, text: 'TAB'}
    ] : [])
  ];

  return {
    structure: 'rigid',
    cut, crease,
    bbox: {minX: 0, minY: 0, maxX: xR1, maxY: yT1},
    inner: {L, W, H},
    outer: {L: L + 2*t, W: W + 2*t, H: outerH},
    meta: {
      style: 'tray',
      // SHELF FRONT: an open tray is seen through its open TOP.
      frontFace: 'H',
      caliper: t,
      cornerGap: g,
      boardLayersBottom: 1,
      boardLayersTop: 0,
      labels,
      hDims: [
        {from: 0, to: H, v: H}, {from: H, to: H + L, v: L}, {from: H + L, to: xR1, v: H}
      ],
      vDims: [
        {from: 0, to: H, v: H}, {from: H, to: H + W, v: W}, {from: H + W, to: yT1, v: H}
      ],
      print: {x0: bx0 + hg, x1: bx1 - hg, y0: 0, y1: H},   // bottom wall main panel — the visible outer face
      // ARTWORK MAP — the tray is an OPEN cross-blank (a base with four walls
      // folding up), not a tube, so it does not get the extrude-tube 3D
      // cladding the wrap/cartons use (each wall's height runs a DIFFERENT way
      // in the blank; a single tube UV would rotate two of them). `flat: true`
      // opts the tray into the shared TEMPLATE + 2D overlay + upload/remove and
      // out of the 3D tube — the honest boundary until a per-wall tray UV
      // builder exists. The whole blank is the canvas, so a template-sized
      // upload still maps 1:1 on the 2D dieline.
      artMap: {
        canvas: {w: xR1, h: yT1},
        product: {x0: bx0, x1: bx1},
        up: 'v',
        flat: true
      }
    }
  };
}
