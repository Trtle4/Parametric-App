/**
 * Seal-End Carton — a glued, partially-overlapping closure, secondary
 * tier (cereal/cracker box style). Panel run [glue | back(L) | side(W) |
 * front(L) | side(W)], same tube convention as a6120/fefco201.
 *
 * Rebuilt from a confirmed sketch. The earlier build was wrong: it put a
 * single alternating flap at each end (front seals top, back seals bottom)
 * — that is an RSC slotted pattern, not a seal-end closure, and it isn't
 * how this carton actually closes. The real structure: FOUR flaps at EACH
 * end (not two total) — two minor DUST flaps (from the side/W panels), one
 * major flap (from the BACK panel), and one SEAL flap (from the FRONT
 * panel) that glues down over both the major flap and the dust flaps. The
 * SAME panel seals BOTH ends (front always on top of the stack, back
 * always underneath) — this carton does not alternate front/back between
 * top and bottom the way a6120's reverse tuck does.
 *
 * overlap is a real, exposed parameter (not derived): sealFlapDepth =
 * W/2 + overlap/2... i.e. the seal flap reaches `overlap` past where the
 * major flap already reached (the centreline), for reliable glue contact.
 *
 * All lengths mm. Implements the Geometry contract in core/types.js.
 */

const DUST_SWEEP = 20 * Math.PI/180;   // dust flap side-edge sweep — same convention as a6120
const FLAP_CHAMFER_MAX = 5;            // seal flap's outer corners only — major/dust flaps are fully hidden under it

/**
 * @param {Object} p  {L, W, H, caliper, glueTab, dustDepth, overlap, cornerStyle}
 * @returns {import('../types.js').Geometry}
 */
export function sealend(p){
  const {L, W, H, caliper: t} = p;
  const g = p.glueTab, D = p.dustDepth, overlap = p.overlap;
  const majorFlapDepth = W/2;                    // reaches the centreline, same convention as an RSC's outer flaps
  const F = majorFlapDepth + overlap/2;          // seal flap depth — confirmed convention, see file doc comment

  const x1 = g, x2 = g + L, x3 = g + L + W, x4 = g + 2*L + W, x5 = g + 2*L + 2*W;
  const ext = Math.max(F, D);
  const yb = ext, yt = ext + H;
  const di = Math.min(D*Math.tan(DUST_SWEEP), W/2 - 0.5);
  const chF = Math.max(0, Math.min(FLAP_CHAMFER_MAX, F*0.4));
  const cg = Math.max(0, Math.min(g*0.5, FLAP_CHAMFER_MAX));

  // one end (top OR bottom): major flap (back, x1-x2) | dust (side1, x2-x3)
  // | seal flap (front, x3-x4) | dust (side2, x4-x5) — mirrored for the
  // other end, not alternated, since the SAME panel seals both ends.
  const end = (y0, dir) => {   // dir=+1 for top (fold outward = +y), -1 for bottom (fold outward = -y)
    const major = y0 + dir*majorFlapDepth, dust = y0 + dir*D, seal = y0 + dir*F, sealCh = y0 + dir*(F - chF);
    return [
      [x1, y0], [x1, major], [x2, major], [x2, y0],                  // major flap: plain rectangle, back panel
      [x2 + di, dust], [x3 - di, dust], [x3, y0],                    // dust flap 1 (side1)
      [x3, sealCh], [x3 + chF, seal], [x4 - chF, seal], [x4, sealCh], [x4, y0],  // seal flap: chamfered, front panel
      [x4 + di, dust], [x5 - di, dust], [x5, y0]                     // dust flap 2 (side2)
    ];
  };

  const cut = [
    [x1, yb], [0, yb + cg], [0, yt - cg], [x1, yt],   // glue tab, chamfered ends
    ...end(yt, +1).slice(1),                          // drop [x1,yt]: already the glue tab's last point
    ...end(yb, -1).reverse().slice(0, -1)             // drop [x1,yb]: already this array's first point (below)
  ]; // closes back to [x1, yb]

  const crease = [
    [x1, yb, x1, yt], [x2, yb, x2, yt], [x3, yb, x3, yt], [x4, yb, x4, yt],  // vertical panel folds
    [x1, yt, x5, yt],                                        // top roots: major | dust-1 | seal | dust-2, all hinged
    [x1, yb, x5, yb]                                         // bottom roots: same, mirrored
  ];

  // --- material compensation (outside dimensions of the erected carton) ---
  // Derived for THIS closure, not copied from the RSC or the tuck end:
  //  * L and W: the same universal 4-wall body every rigid style has —
  //    the two side panels bound L, front/back bound W        -> +2t each.
  //  * H, EACH END: three panels stack flat there, not two. The dust flaps
  //    fold in first (1 layer), the major flap folds over them reaching to
  //    the centreline (1 more layer), and the seal flap folds over BOTH and
  //    glues (1 more layer) — because the major/seal flaps span the FULL
  //    L width (same width as the back/front panels they're hinged to),
  //    they overlap the dust flaps wherever the two meet, near each end's
  //    corners. That's 3 layers, not a6120's 2 (a6120's tuck TAB is
  //    deliberately narrower than its tuck panel, so it never re-stacks
  //    onto the dust flaps a second time; this carton's flaps are plain
  //    full-width rectangles, so they do).           -> 3 layers = 3t/end.
  //  Total: outer.H = H + 6t. This is NOT copied from fefco201's own +4t —
  //  it happens to be a different number for a different, derived reason
  //  (an extra stacked layer per end from the seal-over-major-over-dust
  //  overlap this closure actually has).
  return {
    structure: 'rigid',
    cut, crease,
    bbox: {minX: 0, minY: 0, maxX: x5, maxY: yt + ext},
    inner: {L, W, H},
    outer: {L: L + 2*t, W: W + 2*t, H: H + 6*t},
    meta: {
      style: 'sealend',
      caliper: t,
      sealFlapDepth: F, majorFlapDepth, dustDepth: D, overlap,
      boardLayersTop: 3, boardLayersBottom: 3,
      // generic dieline annotations (style-agnostic renderer contract)
      labels: [
        {x: (x1 + x2)/2, y: (yb + yt)/2, text: 'L'}, {x: (x2 + x3)/2, y: (yb + yt)/2, text: 'W'},
        {x: (x3 + x4)/2, y: (yb + yt)/2, text: 'L'}, {x: (x4 + x5)/2, y: (yb + yt)/2, text: 'W'}
      ],
      hDims: [
        ...(g > 0 ? [{from: 0, to: x1, v: g}] : []),
        {from: x1, to: x2, v: L}, {from: x2, to: x3, v: W},
        {from: x3, to: x4, v: L}, {from: x4, to: x5, v: W}
      ],
      vDims: [
        {from: yb - F, to: yb, v: F}, {from: yb, to: yt, v: H}, {from: yt, to: yt + F, v: F}
      ],
      print: {x0: x3, x1: x4, y0: yb, y1: yt}   // front panel body
    }
  };
}
