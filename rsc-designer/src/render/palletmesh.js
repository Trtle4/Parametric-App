/**
 * The ONE pallet render asset. A standard GMA 48x40 4-way stringer pallet as a
 * THREE group with its base at y=0 and its top-deck face at y=PALLET_HEIGHT.
 *
 * Both pallet views build the SAME pallet from here — the Palletize view
 * (pallet3d.js) and the 3D-Fold pallet-depth view (hierarchy3d.js). Neither
 * owns its own pallet mesh, so they can never drift into two different pallets.
 *
 * RENDER ONLY. The pallet fit math budgets exactly PALLET_HEIGHT for the deck
 * assembly and the deck footprint for the layout; changing the mesh here never
 * touches that. Uses the global THREE (classic script tag). All lengths in mm.
 */

// GMA-style timber, mm. The three board-stack thicknesses sum to PALLET_HEIGHT
// (127) — do NOT change that sum, it is the load-height budget the fit reads.
const BOTTOM_T = 16, STRINGER_H = 95, DECK_T = 16;   // board thicknesses (sum 127)
const STRINGER_W = 38;                               // stringer width (1.5 in)
const DECK_W = 130;                                  // deck-board width
const DECK_PITCH = 190;                              // target top-deck spacing -> ~7 boards on 48"
const NOTCH_H = 42, LEG_L = 150;                     // 4-way stringer notch: legs at ends+centre, gaps between = fork openings

const wood = new THREE.MeshStandardMaterial({color: 0xA0815A, roughness: 0.95, metalness: 0});

/** Deck assembly height — exported so the project chain can budget for it. */
export const PALLET_HEIGHT = BOTTOM_T + STRINGER_H + DECK_T;

/**
 * @param {number} pl  pallet length (x, the 48-in stringer direction), mm
 * @param {number} pw  pallet width  (z, the 40-in deck-board direction), mm
 * @returns {THREE.Group} base at y=0, top-deck face at y=PALLET_HEIGHT
 */
export function buildGmaPallet(pl, pw){
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
  [-endX, 0, endX].forEach(cx => acrossBoard(BOTTOM_T, cx, BOTTOM_T/2));

  // THREE notched stringers running the length (x), spaced across the width (z).
  // Each is a continuous upper rail plus three feet (ends + centre); the two
  // gaps between the feet are the fork notches that make it 4-way.
  const railH = STRINGER_H - NOTCH_H;
  [-pw/2 + STRINGER_W/2, 0, pw/2 - STRINGER_W/2].forEach(z => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(pl, railH, STRINGER_W), wood);
    rail.position.set(0, BOTTOM_T + NOTCH_H + railH/2, z); g.add(rail);
    [-pl/2 + LEG_L/2, 0, pl/2 - LEG_L/2].forEach(x => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(LEG_L, NOTCH_H, STRINGER_W), wood);
      leg.position.set(x, BOTTOM_T + NOTCH_H/2, z); g.add(leg);
    });
  });

  // TOP DECK: ~7 boards across the width, spaced evenly along the length.
  const nTop = Math.max(3, (Math.round(pl/DECK_PITCH) | 1));
  for(let i = 0; i < nTop; i++){
    const cx = -pl/2 + DECK_W/2 + i*((pl - DECK_W)/(nTop - 1));
    acrossBoard(DECK_T, cx, BOTTOM_T + STRINGER_H + DECK_T/2);
  }
  return g;
}
