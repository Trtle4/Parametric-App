/**
 * The ONE pallet render asset. A standard GMA 48x40 4-way stringer pallet as a
 * THREE group with its base at y=0 and its top-deck face at y=PALLET_HEIGHT.
 *
 * The 3D-Fold pallet-depth view (hierarchy3d.js) builds its pallet from here,
 * so the render never owns its own pallet mesh and can't drift into a second
 * different pallet.
 *
 * RENDER ONLY. The pallet fit math budgets exactly PALLET_HEIGHT for the deck
 * assembly and the deck footprint for the layout; changing the mesh here never
 * touches that. Uses the global THREE (classic script tag). All lengths in mm.
 */

// GMA-style timber, mm. These are the NOMINAL proportions of a 127mm pallet;
// the mesh is built to whatever deck height it is asked for (see boardStack).
// The old note here said "do NOT change that sum, it is the load-height budget
// the fit reads" — that comment WAS the coupling: the fit reads the project's
// pallet.baseH, and this constant merely happened to equal it.
const BOTTOM_T = 16, STRINGER_H = 95, DECK_T = 16;   // board thicknesses (sum 127)
const STRINGER_W = 38;                               // stringer width (1.5 in)
const DECK_W = 130;                                  // deck-board width
const DECK_PITCH = 190;                              // target top-deck spacing -> ~7 boards on 48"
const NOTCH_H = 42, LEG_L = 150;                     // 4-way stringer notch: legs at ends+centre, gaps between = fork openings

const wood = new THREE.MeshStandardMaterial({color: 0xA0815A, roughness: 0.95, metalness: 0});
// slipsheet: a thin, flat, kraft-coloured sheet — visually distinct from the
// GMA pallet's timber so a mixed pallet+slipsheet stack reads as two
// different bases at a glance, not two identical decks.
const kraft = new THREE.MeshStandardMaterial({color: 0xC7A874, roughness: 0.85, metalness: 0});
// Exported so other render modules (the trailer's simplified, INSTANCED base
// proxies at trailer scale — hierarchy3d.js buildTrailer) reuse the SAME
// pallet/slipsheet colours instead of inventing a second material — one
// visual convention for "this is a pallet" / "this is a slipsheet" no
// matter how the base is drawn (full timber mesh here, a plain box there).
export const PALLET_MATERIAL = wood;
export const SLIPSHEET_MATERIAL = kraft;

// Corner post: a distinct grey, visually separate from the pallet/slipsheet
// colours above and from the case board it stands beside. DoubleSide because
// buildCornerPostSet used to mirror ONE L-shaped mesh into the other 3
// corners via a negative scale on the whole post group. Measured: for a
// non-square profile (legL != legW, both independently user-editable —
// #cpLegL/#cpLegW), that is a TRUE reflection at 2 of the 4 corners, not a
// rotation — a mirror-image L, the same "physically impossible" symptom the
// det(M)>0 nesting invariant exists to catch. (The other 2 corners flip
// BOTH axes at once, which IS just a 180 deg rotation; only the single-axis
// flips were the real defect, which is why it went unnoticed on the common
// square-leg default and only shows on an asymmetric leg pair.) Fixed by
// building each arm at its correct SIGNED position directly — pure
// translation, det always +1 — instead of scaling the whole post. Produces
// byte-identical vertex positions to the old code for every corner (both
// are the same signed offset; only the mechanism changed), so DoubleSide
// (needed for the old flipped winding) is no longer required either.
const cornerPostMat = new THREE.MeshStandardMaterial({color: 0x6B6F73, roughness: 0.6, metalness: 0.15});
export const CORNER_POST_MATERIAL = cornerPostMat;

/** One post's own L-profile: two boxes sharing the caliper x caliper corner
 *  square once (matching core/stack.js's cornerPostSectionAreaMM2), bottom
 *  at y=0 (same bottom-origin convention as buildGmaPallet/buildSlipsheet).
 *  Local origin is the post's own OUTER corner; `sx`/`sz` (each +-1) say
 *  which quadrant the two arms extend into — the caller passes the signed
 *  direction that points INWARD for a given corner, so this never needs to
 *  be mirrored after construction. */
function buildCornerPostL(legL, legW, caliper, height, sx, sz){
  const g = new THREE.Group();
  const h = Math.max(0.1, height);
  const armX = new THREE.Mesh(new THREE.BoxGeometry(Math.max(legL, 0.1), h, Math.max(caliper, 0.1)), cornerPostMat);
  armX.position.set(sx*legL/2, h/2, sz*caliper/2);
  g.add(armX);
  const armZ = new THREE.Mesh(new THREE.BoxGeometry(Math.max(caliper, 0.1), h, Math.max(legW, 0.1)), cornerPostMat);
  armZ.position.set(sx*caliper/2, h/2, sz*legW/2);
  g.add(armZ);
  return g;
}

/**
 * All 4 corner posts for one unit load, standing OUTBOARD of the case
 * corner on footprint `fp` (mm) — the load's bounding footprint grows by
 * 2 x caliper in each of L and W, one post caliper-thick at each end of a
 * face (core/stack.js cornerPostFootprintGrowthMM). Local origin is the
 * SAME point the load's own base/case footprint is centred on; y=0 is
 * where the post's own base sits (callers position this at the base's top
 * — see hierarchy3d.js's buildPallet/buildTrailer).
 * @param {{L:number,W:number}} fp  the CASE footprint the posts stand outboard of
 * @param {number} height  post height, mm (core/stack.js cornerPostHeightMM)
 * @param {number} legL  leg length along L, mm
 * @param {number} legW  leg length along W, mm
 * @param {number} caliper  mm
 */
export function buildCornerPostSet(fp, height, legL, legW, caliper){
  const g = new THREE.Group();
  g.name = 'cornerPosts';
  if(height <= 0 || caliper <= 0) return g;
  const hx = fp.L/2 + caliper, hz = fp.W/2 + caliper;   // outer-corner distance from centre
  const corners = [{x: hx, z: hz}, {x: -hx, z: hz}, {x: -hx, z: -hz}, {x: hx, z: -hz}];
  for(const c of corners){
    // the signed direction that points INWARD (opposite the corner's own
    // quadrant) toward the load's centre — passed straight into the arms'
    // own construction rather than applied as a post-hoc mirror.
    const sx = -Math.sign(c.x), sz = -Math.sign(c.z);
    const post = buildCornerPostL(legL, legW, caliper, height, sx, sz);
    post.position.set(c.x, 0, c.z);
    g.add(post);
  }
  return g;
}

/** The NOMINAL GMA deck height (127mm) — the sensible default for a caller
 *  with no project to read, and the value project.pallet.baseH defaults to.
 *  It is no longer a second source of truth: the chain's own baseH is what
 *  the fit budgets, what buildPallet stacks the load at, and now what this
 *  mesh is built to. */
export const PALLET_HEIGHT = BOTTOM_T + STRINGER_H + DECK_T;

/** Minimum continuous rail above the fork notch before the shape stops
 *  reading as a stringer pallet at all. */
const MIN_RAIL = 6;

/** The shortest deck this can draw as a real stringer pallet — fixed boards
 *  plus a minimum rail above the fork notch. Below it the mesh degrades to a
 *  proportional miniature (see boardStack), so the UI warns at this boundary
 *  rather than letting the render quietly misrepresent the fork opening. */
export const MIN_FAITHFUL_DECK_H = BOTTOM_T + NOTCH_H + MIN_RAIL + DECK_T;

/**
 * The board stack for a requested deck height.
 *
 * A pallet gets taller in its STRINGER, not in its boards: deckboards are
 * milled to a standard thickness and the fork notch is sized by the fork, so
 * both hold and the continuous rail above the notch absorbs the difference.
 * That is why this does not simply scale the mesh — uniform scaling thickens
 * the timber with the pallet (a 200mm deck would draw 25mm deckboards and a
 * 66mm fork opening), which is not what a taller pallet looks like.
 *
 * Below the height that fixed boards plus a minimum rail can occupy, there is
 * no faithful shape left — a deck shorter than the timber it is made of — so
 * it degrades to a proportional miniature rather than clamping into something
 * that would misrepresent the fork opening.
 */
function boardStack(deckH){
  const h = Math.max(1, deckH);
  if(h >= BOTTOM_T + NOTCH_H + MIN_RAIL + DECK_T)
    return {bottom: BOTTOM_T, notch: NOTCH_H, rail: h - BOTTOM_T - NOTCH_H - DECK_T, deck: DECK_T};
  const k = h/PALLET_HEIGHT;
  return {bottom: BOTTOM_T*k, notch: NOTCH_H*k, rail: (STRINGER_H - NOTCH_H)*k, deck: DECK_T*k};
}

/**
 * @param {number} pl  pallet length (x, the 48-in stringer direction), mm
 * @param {number} pw  pallet width  (z, the 40-in deck-board direction), mm
 * @param {number} [deckH=PALLET_HEIGHT]  the deck assembly height to build to —
 *        the chain's own pallet.baseH. The load is stacked from this height, so
 *        building the timber to anything else floats the load above the deck it
 *        is supposed to rest on (13mm at baseH 140).
 * @returns {THREE.Group} base at y=0, top-deck face at y=deckH
 */
export function buildGmaPallet(pl, pw, deckH = PALLET_HEIGHT){
  const S = boardStack(deckH);
  const g = new THREE.Group();
  // a full-width board: DECK_W wide in x (along the length), `h` thick, running
  // the entire 40-in width in z — i.e. ACROSS (perpendicular to) the stringers
  const acrossBoard = (h, cx, cy) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(DECK_W, h, pw), wood);
    b.position.set(cx, cy, 0); g.add(b);
  };

  // BOTTOM DECK: the canonical GMA lead-board layout — two end (lead) boards
  // flush at each end plus one centre board, all running the full width ACROSS
  // the stringers. These are the boards seen from below; without them the
  // underside doesn't read as a real 4-way stringer pallet.
  const endX = pl/2 - DECK_W/2;
  [-endX, 0, endX].forEach(cx => acrossBoard(S.bottom, cx, S.bottom/2));

  // THREE notched stringers running the length (x), spaced across the width (z).
  // Each is a continuous upper rail plus three feet (ends + centre); the two
  // gaps between the feet are the fork notches that make it 4-way.
  const railH = S.rail;
  [-pw/2 + STRINGER_W/2, 0, pw/2 - STRINGER_W/2].forEach(z => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(pl, railH, STRINGER_W), wood);
    rail.position.set(0, S.bottom + S.notch + railH/2, z); g.add(rail);
    [-pl/2 + LEG_L/2, 0, pl/2 - LEG_L/2].forEach(x => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(LEG_L, S.notch, STRINGER_W), wood);
      leg.position.set(x, S.bottom + S.notch/2, z); g.add(leg);
    });
  });

  // TOP DECK: ~7 boards across the width, spaced evenly along the length.
  const nTop = Math.max(3, (Math.round(pl/DECK_PITCH) | 1));
  for(let i = 0; i < nTop; i++){
    const cx = -pl/2 + DECK_W/2 + i*((pl - DECK_W)/(nTop - 1));
    acrossBoard(S.deck, cx, S.bottom + S.notch + S.rail + S.deck/2);
  }
  return g;
}

/**
 * A slipsheet — a single thin flat board, no timber. base at y=0, top face
 * at y=caliperMm. Named 'slipsheet' so the pallet-depth render can identify
 * it apart from a GMA pallet at the same stack position.
 * @param {number} l  slipsheet length (its own footprint, may exceed the
 *        pallet's own L by the handling lip — core/stack.js slipsheetFootprintMM)
 * @param {number} w  slipsheet width
 * @param {number} caliperMm  sheet thickness, mm
 * @returns {THREE.Group} base at y=0, top face at y=caliperMm
 */
// Cap: kraft-toned like the slipsheet (both are paperboard) but lighter, so
// a capped load reads as board-over-cases rather than as another slipsheet
// that has somehow climbed on top of the stack.
const capMat = new THREE.MeshStandardMaterial({color: 0xD8BE94, roughness: 0.9, metalness: 0});
export const CAP_MATERIAL = capMat;

/**
 * A folded cap: the centre panel plus four skirts turned 90°.
 *
 * SIMPLE BY DESIGN, per the brief. Five boxes, no creased sheet and no
 * corner-relief notches in the mesh — the relief is a fraction of a
 * millimetre of board at a corner, invisible at load scale, and the 2D blank
 * is where a converter reads it. What the 3D has to get right is that the
 * cap is one continuous surface over the WHOLE face with skirts down its
 * sides, which is what distinguishes it from the four discrete corner posts
 * it sits over.
 *
 * `centre` is the CAP'S CENTRE PANEL — the load footprint including the
 * posts (core/stack.js loadFootprintStagesMM(...).posts), passed in
 * resolved. This builder never nests a footprint of its own; that arithmetic
 * has exactly one home and it is not here.
 *
 * ORIENTATION: `dir` is +1 for a TOP cap (skirts hang DOWN from a panel at
 * the top, local y=0 at the panel's underside) and -1 for a BOTTOM cap
 * (skirts rise UP from a panel at the bottom, local y=0 at the panel's top
 * surface). Both put y=0 at the face that touches the cases, so a caller
 * positions either one at the case boundary without a per-direction offset
 * of its own.
 *
 * @param {{L:number,W:number}} centre  the cap's centre panel, mm
 * @param {number} skirtMm  skirt depth, mm
 * @param {number} caliperMm  board caliper, mm
 * @param {1|-1} dir  +1 top cap (skirts down), -1 bottom cap (skirts up)
 */
export function buildCap(centre, skirtMm, caliperMm, dir = 1){
  const g = new THREE.Group();
  g.name = dir > 0 ? 'capTop' : 'capBottom';
  const t = Math.max(0.1, caliperMm);
  const x = Math.max(0, skirtMm);
  const L = centre.L, W = centre.W;
  // the panel sits just clear of the cases: its inner face at y=0, its body
  // in the +dir direction (a top cap's board is ABOVE the cases it covers)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(L + 2*t, t, W + 2*t), capMat);
  panel.position.set(0, dir*t/2, 0);
  g.add(panel);
  if(x > 0){
    // four skirts, hanging back ALONGSIDE the load (opposite the panel), each
    // one caliper thick and standing outboard of the centre panel — which is
    // exactly the 2 x caliper of plan growth capFootprintGrowthMM reports
    const skirtY = -dir*x/2;
    const along = [[L + 2*t, t, 1], [t, W + 2*t, 0]];
    for(const [sx, sz, isL] of along){
      for(const sgn of [1, -1]){
        const m = new THREE.Mesh(new THREE.BoxGeometry(isL ? sx : t, x, isL ? t : sz), capMat);
        m.position.set(isL ? 0 : sgn*(L/2 + t/2), skirtY, isL ? sgn*(W/2 + t/2) : 0);
        g.add(m);
      }
    }
  }
  return g;
}

export function buildSlipsheet(l, w, caliperMm){
  const g = new THREE.Group();
  g.name = 'slipsheet';
  const h = Math.max(0.1, caliperMm);
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), kraft);
  sheet.position.set(0, h/2, 0);
  g.add(sheet);
  return g;
}
