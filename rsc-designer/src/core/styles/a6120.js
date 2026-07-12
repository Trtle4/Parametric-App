/**
 * ECMA A6120 — Reverse Tuck End folding carton.
 *
 * Panel run: [glue tab | back | side | front | side], widths [g | L | W | L | W].
 * Closures:
 *  - dust flaps on both side panels, top and bottom (4 total)
 *  - tuck panel + tuck tab on the FRONT panel at the top and on the BACK
 *    panel at the bottom — the reversal that makes this a reverse tuck and
 *    lets blanks nest head-to-tail in a die layout.
 *
 * Engineering spec (per packaging engineer, 2026-07-11):
 *  - tuck (lid) panel depth default: W − t
 *  - dust flap depth default: 0.625 × W, side edges swept 20° root→tip
 *  - tuck tab default depth 16 mm, corners chamfered 45° with 5 mm legs
 *  - no nicks or slits
 *
 * All lengths mm. Implements the Geometry contract in core/types.js.
 */

const DUST_SWEEP = 20 * Math.PI/180; // dust flap side-edge sweep (spec: 20°)
const TAB_CHAMFER = 5;               // 45° chamfer legs on tuck tab corners (spec: 5 mm fixed)
const GLUE_CHAMFER_MAX = 5;          // glue tab end chamfer cap — interpretation, flagged for sample check

/**
 * @param {Object} p  {L, W, H, caliper, glueTab, dustDepth, tuckDepth, tuckTab}
 * @returns {import('../types.js').Geometry}
 */
export function a6120(p){
  const {L, W, H, caliper: t} = p;
  const g = p.glueTab, D = p.dustDepth, T = p.tuckDepth, TT = p.tuckTab;

  const x1 = g, x2 = g + L, x3 = g + L + W, x4 = g + 2*L + W, x5 = g + 2*L + 2*W;
  const ext = Math.max(T + TT, D);   // deepest end extension sets the blank origin
  const yb = ext, yt = ext + H;      // body creases (bottom / top)
  const di = Math.min(D*Math.tan(DUST_SWEEP), W/2 - 0.5); // dust sweep run, kept inside the panel
  const ch = Math.min(TAB_CHAMFER, TT);                   // tab chamfer legs
  const cg = Math.max(0, Math.min(g*0.5, GLUE_CHAMFER_MAX));

  const cut = [
    [x1,yb],[0,yb+cg],[0,yt-cg],[x1,yt],                     // glue tab, chamfered ends
    [x2,yt],                                                 // back panel top edge (plain cut — closure is at its bottom)
    [x2+di,yt+D],[x3-di,yt+D],[x3,yt],                       // side-1 top dust flap (20° swept trapezoid)
    [x3,yt+T+TT-ch],[x3+ch,yt+T+TT],                         // front tuck: panel side edge + tab chamfer
    [x4-ch,yt+T+TT],[x4,yt+T+TT-ch],[x4,yt],                 // tab top edge, far chamfer, back down
    [x4+di,yt+D],[x5-di,yt+D],[x5,yt],                       // side-2 top dust flap
    [x5,yb],                                                 // right edge
    [x5-di,yb-D],[x4+di,yb-D],[x4,yb],                       // side-2 bottom dust flap
    [x3,yb],                                                 // front panel bottom edge (plain cut)
    [x3-di,yb-D],[x2+di,yb-D],[x2,yb],                       // side-1 bottom dust flap
    [x2,yb-T-TT+ch],[x2-ch,yb-T-TT],                         // back tuck (reverse end): side edge + tab chamfer
    [x1+ch,yb-T-TT],[x1,yb-T-TT+ch]                          // tab bottom edge, far chamfer
  ]; // closes back to [x1,yb]

  const crease = [
    [x1,yb,x1,yt],[x2,yb,x2,yt],[x3,yb,x3,yt],[x4,yb,x4,yt], // vertical panel folds
    [x2,yt,x5,yt],                                           // top roots: dust-1 | tuck | dust-2 (back top is a cut edge)
    [x3,yt+T,x4,yt+T],                                       // top tuck tab fold
    [x1,yb,x3,yb],                                           // bottom roots: back tuck + dust-1 (front bottom is a cut edge)
    [x4,yb,x5,yb],                                           // bottom root: dust-2
    [x1,yb-T,x2,yb-T]                                        // bottom tuck tab fold
  ];

  // --- material compensation (outside dimensions of the erected carton) ---
  // Derived for THIS closure, not inherited from the RSC:
  //  * L and W: one board thickness per wall, same four-wall body as any
  //    sleeve — the two side panels bound L, front/back bound W  -> +2t each
  //  * H, TOP: the dust flaps fold flat across the opening (1 board layer)
  //    and the tuck panel folds over ON TOP of them (1 more layer)
  //    -> 2 board layers = 2t across the top.
  //    The tuck TAB turns down INSIDE the cavity along the far wall: it is
  //    vertical board that consumes ~t of internal width over the tab
  //    depth and adds NOTHING to external height.
  //  * H, BOTTOM: mirror image (reverse tuck) -> 2t.
  //  Total: outer.H = H + 4t. Numerically the same +4t as the FEFCO 201,
  //  but the stack is different: RSC = inner minor flap + outer major flap
  //  at each end; RTE = dust flap layer + tuck panel at each end.
  return {
    structure: 'rigid',
    cut, crease,
    bbox: {minX: 0, minY: 0, maxX: x5, maxY: yt + Math.max(T + TT, D)},
    inner: {L, W, H},
    outer: {L: L + 2*t, W: W + 2*t, H: H + 4*t},
    meta: {
      style: 'a6120',
      caliper: p.caliper,
      tuckDepth: T, tuckTab: TT, dustDepth: D,
      // generic dieline annotations (style-agnostic renderer contract)
      labels: [
        {x: (x1+x2)/2, y: (yb+yt)/2, text: 'L'}, {x: (x2+x3)/2, y: (yb+yt)/2, text: 'W'},
        {x: (x3+x4)/2, y: (yb+yt)/2, text: 'L'}, {x: (x4+x5)/2, y: (yb+yt)/2, text: 'W'}
      ],
      hDims: [
        ...(g > 0 ? [{from: 0, to: x1, v: g}] : []),
        {from: x1, to: x2, v: L}, {from: x2, to: x3, v: W},
        {from: x3, to: x4, v: L}, {from: x4, to: x5, v: W}
      ],
      vDims: [
        {from: yb-T-TT, to: yb-T, v: TT}, {from: yb-T, to: yb, v: T},
        {from: yb, to: yt, v: H},
        {from: yt, to: yt+T, v: T}, {from: yt+T, to: yt+T+TT, v: TT}
      ],
      print: {x0: x3, x1: x4, y0: yb, y1: yt}   // front panel body
    }
  };
}
