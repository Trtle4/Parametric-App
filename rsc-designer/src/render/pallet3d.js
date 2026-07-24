/**
 * Pallet view: a standard GMA 48x40 4-way stringer pallet (render asset) +
 * instanced case rendering, with an optional double-stack (two unit loads).
 *
 * One consumer of core/containment.js: the deck is a fixed cavity, the case
 * outer envelope is the child, and cases may rotate about the vertical axis
 * only. Pallet-specific knowledge (timber, deck, GMA sizes) lives here and
 * nowhere else. RENDER ONLY — the fit math (palletStats/fitInto) is unchanged;
 * PALLET_HEIGHT stays 127 mm so the load-height budget the chain reads is
 * identical. All lengths in mm.
 */
import {fitInto} from '../core/containment.js';
import {getPivot, setCamSpan, kraft, roundedBoxGeo} from './fold3d.js';

// GMA-style timber, mm. The three sum to PALLET_HEIGHT (127) — do NOT change
// that sum, it is the load-height budget the pallet fit reads.
const BOTTOM_T = 16, STRINGER_H = 95, DECK_T = 16;   // board thicknesses (sum 127)
const STRINGER_W = 38;                               // stringer width (1.5 in)
const DECK_W = 130;                                  // deck-board width
const DECK_PITCH = 190;                              // target top-deck spacing -> ~7 boards on 48"
const NOTCH_H = 42, LEG_L = 150;                     // 4-way stringer notch: legs at ends+centre, gaps between = fork openings
const CASE_GAP = 2;                                  // visual seam between cases
const SHOWN_CAP = 4000;                              // instancing cap for absurd inputs

const wood = new THREE.MeshStandardMaterial({color: 0xA0815A, roughness: 0.95, metalness: 0});

/** Deck assembly height — exported so the project chain can budget for it. */
export const PALLET_HEIGHT = BOTTOM_T + STRINGER_H + DECK_T;

let palletGroup = null;

/** Pure pallet-fit stats (no rendering) — the cheap path the always-visible
 *  readout + BCT use on every recompute. Same fitInto call buildPallet makes,
 *  so the numbers match the 3D view exactly. */
export function palletStats(geo, pallet, pattern){
  const arr = fitInto(
    {outer: geo.outer, allowedOrientations: ['LWH', 'WLH'], styleId: geo.meta.style},
    {L: pallet.L, W: pallet.W, H: pallet.maxH - PALLET_HEIGHT},
    {wall: 0, between: 0},
    pattern
  );
  return {
    label: arr.label, perLayer: arr.perLayer, layers: arr.layers, total: arr.total,
    coveragePct: Math.round(arr.perLayer*geo.outer.L*geo.outer.W/(pallet.L*pallet.W)*100)
  };
}

/** One GMA 4-way stringer pallet as a group: bottom deck, three notched
 *  stringers running the 48-in length (legs at both ends + centre, the two
 *  gaps between them are the fork notches for entry from all four sides), and
 *  the ~7-board top deck across the 40-in width. */
function buildTimber(pl, pw){
  const g = new THREE.Group();
  // bottom deck: boards across the width (run along z), spaced along the length
  const nBot = 5;
  for(let i = 0; i < nBot; i++){
    const x = -pl/2 + DECK_W/2 + i*((pl - DECK_W)/(nBot - 1));
    const b = new THREE.Mesh(new THREE.BoxGeometry(DECK_W, BOTTOM_T, pw), wood);
    b.position.set(x, BOTTOM_T/2, 0); g.add(b);
  }
  // three notched stringers along the length (x), placed across the width (z)
  const railH = STRINGER_H - NOTCH_H;
  [-pw/2 + STRINGER_W/2, 0, pw/2 - STRINGER_W/2].forEach(z => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(pl, railH, STRINGER_W), wood);   // continuous upper rail
    rail.position.set(0, BOTTOM_T + NOTCH_H + railH/2, z); g.add(rail);
    [-pl/2 + LEG_L/2, 0, pl/2 - LEG_L/2].forEach(x => {                                // three feet; two gaps = 4-way notches
      const leg = new THREE.Mesh(new THREE.BoxGeometry(LEG_L, NOTCH_H, STRINGER_W), wood);
      leg.position.set(x, BOTTOM_T + NOTCH_H/2, z); g.add(leg);
    });
  });
  // top deck: ~7 boards across the width (run along z), spaced along the length
  const nTop = Math.max(3, (Math.round(pl/DECK_PITCH) | 1));
  for(let i = 0; i < nTop; i++){
    const x = -pl/2 + DECK_W/2 + i*((pl - DECK_W)/(nTop - 1));
    const d = new THREE.Mesh(new THREE.BoxGeometry(DECK_W, DECK_T, pw), wood);
    d.position.set(x, BOTTOM_T + STRINGER_H + DECK_T/2, 0); g.add(d);
  }
  return g;
}

/**
 * @param {import('../core/types.js').Geometry} geo   style output (outer dims consumed)
 * @param {{L:number, W:number, maxH:number}} pallet  deck size + height budget, mm
 * @param {'optimal'|'column'|'interlock'} pattern
 * @param {boolean} visible whether the pallet view is active
 * @param {boolean} doubleStack render a second unit load on top (two pallets high)
 * @returns {{label:string, perLayer:number, layers:number, total:number, coveragePct:number}}
 */
export function buildPallet(geo, pallet, pattern, visible, doubleStack){
  const pivot = getPivot();
  if(palletGroup){
    pivot.remove(palletGroup);
    palletGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); });
  }
  palletGroup = new THREE.Group();

  const ol = geo.outer.L, ow = geo.outer.W, oh = geo.outer.H;
  const ph = PALLET_HEIGHT;
  const pl = pallet.L, pw = pallet.W;

  // containment does the layout: fixed cavity above the deck, cases rotate
  // about the vertical axis only, flush stacking (zero clearance)
  const arr = fitInto(
    {outer: geo.outer, allowedOrientations: ['LWH', 'WLH'], styleId: geo.meta.style},
    {L: pl, W: pw, H: pallet.maxH - ph},
    {wall: 0, between: 0},
    pattern
  );

  const oneLoadH = ph + arr.layers*oh;                 // pallet + its case stack
  const nLoads = doubleStack ? 2 : 1;
  const shown = Math.min(arr.total, SHOWN_CAP);
  const caseGeo = arr.total > 0
    ? roundedBoxGeo(ol - CASE_GAP, oh - CASE_GAP, ow - CASE_GAP, Math.min(4, geo.meta.caliper*1.6), 2)
    : null;

  for(let u = 0; u < nLoads; u++){
    const yBase = u*oneLoadH;                           // second unit load sits on top of the first
    const timber = buildTimber(pl, pw);
    timber.position.y = yBase;
    palletGroup.add(timber);

    if(caseGeo){
      const inst = new THREE.InstancedMesh(caseGeo, kraft, shown);
      const M = new THREE.Matrix4(), R = new THREE.Matrix4().makeRotationY(Math.PI/2);
      for(let i = 0; i < shown; i++){
        const p = arr.placements[i];
        if(p.orientation === 'WLH') M.copy(R); else M.identity();   // 90° about vertical
        M.setPosition(p.x, yBase + ph + p.z, p.y);                  // containment (x,y,z) -> world (x,z,y)
        inst.setMatrixAt(i, M);
      }
      palletGroup.add(inst);
    }
  }

  const totalH = nLoads*oneLoadH;
  palletGroup.position.y = -totalH/2;                  // centre vertically for orbit
  palletGroup.visible = visible;
  pivot.add(palletGroup);
  setCamSpan(Math.max(pl, pw, totalH)*0.85);

  return {
    label: arr.label,
    perLayer: arr.perLayer,
    layers: arr.layers,
    total: arr.total,
    coveragePct: Math.round(arr.perLayer*ol*ow/(pl*pw)*100)
  };
}

export function showPallet(v){ if(palletGroup) palletGroup.visible = v; }
