/**
 * FEFCO 201 — Regular Slotted Container.
 * Panel run: [glue | L | W | L | W]; flap depth F = W/2 so the outer
 * (length-panel) flaps meet at the centreline.
 *
 * All lengths in mm. Implements the Geometry contract in core/types.js.
 */

/** Slot notches stop this far short of a panel half — keeps the knife
 *  inside the panel on very small boxes. */
const SLOT_EDGE_INSET = 0.5;   // mm

/** Glue-flap chamfer cap. */
const CHAMFER_MAX = 15;        // mm

/** Boards thinner than this still behave like board, not paper — floor
 *  used for all material compensation. */
const MIN_CALIPER = 0.6;       // mm

/**
 * @param {import('../types.js').Params} p
 * @returns {import('../types.js').Geometry}
 */
export function fefco201(p){
  const {L, W, H, glue, slot} = p;
  const F = W / 2;
  const x1 = glue, x2 = glue + L, x3 = glue + L + W, x4 = glue + 2*L + W, x5 = glue + 2*L + 2*W;
  const yb0 = 0, yb1 = F, yt1 = F + H, yt2 = 2*F + H;
  const hs = Math.max(0, Math.min(slot/2, Math.min(L, W)/2 - SLOT_EDGE_INSET));
  const ch = Math.max(0, Math.min(glue*0.5, F*0.4, CHAMFER_MAX)); // glue-flap chamfer

  const cut = [
    [x1,yb1],[0,yb1+ch],[0,yt1-ch],[x1,yt1],         // glue flap (chamfered) + up joint
    [x1,yt2],                                        // left edge, panel-1 top flap
    // top edge, left->right, notch down at x2,x3,x4
    [x2-hs,yt2],[x2-hs,yt1],[x2+hs,yt1],[x2+hs,yt2],
    [x3-hs,yt2],[x3-hs,yt1],[x3+hs,yt1],[x3+hs,yt2],
    [x4-hs,yt2],[x4-hs,yt1],[x4+hs,yt1],[x4+hs,yt2],
    [x5,yt2],
    [x5,yb0],                                        // right edge (full height)
    // bottom edge, right->left, notch up at x4,x3,x2
    [x4+hs,yb0],[x4+hs,yb1],[x4-hs,yb1],[x4-hs,yb0],
    [x3+hs,yb0],[x3+hs,yb1],[x3-hs,yb1],[x3-hs,yb0],
    [x2+hs,yb0],[x2+hs,yb1],[x2-hs,yb1],[x2-hs,yb0],
    [x1,yb0]                                         // bottom-left, panel-1 bottom flap
  ]; // closes back to [x1,yb1]

  const crease = [
    [x1,yb1,x1,yt1],[x2,yb1,x2,yt1],[x3,yb1,x3,yt1],[x4,yb1,x4,yt1], // vertical panel folds
    [x1,yb1,x5,yb1],[x1,yt1,x5,yt1]                                   // horizontal flap folds
  ];

  // --- material compensation (outside dimensions of the erected case) -----
  // A closed RSC is bigger than its cavity by the board it is made of:
  //  * L and W each gain one board thickness per wall: the two length walls
  //    bound W, the two width walls bound L                     -> +2t each
  //  * H gains the flap stack-up: at the top an inner (minor) flap layer
  //    plus an outer (major) flap layer lie flat across the opening (2t),
  //    and the same again at the bottom                          -> +4t
  const t = Math.max(p.caliper, MIN_CALIPER);

  return {
    cut, crease,
    bbox: {minX: 0, minY: 0, maxX: x5, maxY: yt2},
    inner: {L, W, H},
    outer: {L: L + 2*t, W: W + 2*t, H: H + 4*t},
    meta: {
      style: 'fefco201',
      flapDepth: F,
      panels: {x1, x2, x3, x4, x5, yb1, yt1, yt2}
    }
  };
}
