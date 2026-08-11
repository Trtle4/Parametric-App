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

/** The NOMINAL GMA deck height (127mm) — the sensible default for a caller
 *  with no project to read, and the value project.pallet.baseH defaults to.
 *  It is no longer a second source of truth: the chain's own baseH is what
 *  the fit budgets, what buildPallet stacks the load at, and now what this
 *  mesh is built to. */
export const PALLET_HEIGHT = BOTTOM_T + STRINGER_H + DECK_T;

/** Minimum continuous rail above the fork notch before the shape stops
 *  reading as a stringer pallet at all. */
const MIN_RAIL = 6;

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
