/**
 * Pallet view: timber model + instanced case rendering.
 * One consumer of core/containment.js: the deck is a fixed cavity, the case
 * outer envelope is the child, and cases may rotate about the vertical axis
 * only (a case has a designed top and bottom). Pallet-specific knowledge
 * (timber, deck, GMA sizes) lives here and nowhere else.
 * All lengths in mm.
 */
import {fitInto} from '../core/containment.js';
import {getPivot, setCamSpan, kraft, roundedBoxGeo} from './fold3d.js';

// GMA-style timber, mm
const DECK_T = 16, STRINGER_H = 95, BOTTOM_T = 16;   // board thicknesses
const STRINGER_W = 38, BOARD_W = 140;                // member widths
const DECK_PITCH = 190;                              // target deck-board spacing
const CASE_GAP = 2;                                  // visual seam between cases
const SHOWN_CAP = 4000;                              // instancing cap for absurd inputs

const wood = new THREE.MeshStandardMaterial({color:0xA0815A, roughness:0.95, metalness:0});

/** Deck assembly height — exported so the project chain can budget for it. */
export const PALLET_HEIGHT = BOTTOM_T + STRINGER_H + DECK_T;

let palletGroup = null;

/**
 * @param {import('../core/types.js').Geometry} geo   style output (outer dims consumed)
 * @param {{L:number, W:number, maxH:number}} pallet  deck size + height budget, mm
 * @param {'optimal'|'column'|'interlock'} pattern
 * @param {boolean} visible whether the pallet view is active
 * @returns {{label:string, perLayer:number, layers:number, total:number, coveragePct:number}}
 */
export function buildPallet(geo, pallet, pattern, visible){
  const pivot = getPivot();
  if(palletGroup){
    pivot.remove(palletGroup);
    palletGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); });
  }
  palletGroup = new THREE.Group();

  const ol = geo.outer.L, ow = geo.outer.W, oh = geo.outer.H;
  const ph = BOTTOM_T + STRINGER_H + DECK_T;           // pallet height
  const pl = pallet.L, pw = pallet.W;

  // timber: bottom boards + stringers along length + deck boards across width
  [-pl/2 + BOARD_W/2, 0, pl/2 - BOARD_W/2].forEach(x => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, BOTTOM_T, pw), wood);
    b.position.set(x, BOTTOM_T/2, 0); palletGroup.add(b);
  });
  [-pw/2 + STRINGER_W/2, 0, pw/2 - STRINGER_W/2].forEach(z => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(pl, STRINGER_H, STRINGER_W), wood);
    s.position.set(0, BOTTOM_T + STRINGER_H/2, z); palletGroup.add(s);
  });
  const deckN = Math.max(3, (Math.round(pl/DECK_PITCH) | 1));
  for(let i=0; i<deckN; i++){
    const x = -pl/2 + BOARD_W/2 + i*((pl - BOARD_W)/(deckN - 1));
    const d = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, DECK_T, pw), wood);
    d.position.set(x, BOTTOM_T + STRINGER_H + DECK_T/2, 0); palletGroup.add(d);
  }

  // containment does the layout: fixed cavity above the deck, cases rotate
  // about the vertical axis only, flush stacking (zero clearance)
  const arr = fitInto(
    {outer: geo.outer, allowedOrientations: ['LWH', 'WLH'], styleId: geo.meta.style},
    {L: pl, W: pw, H: pallet.maxH - ph},
    {wall: 0, between: 0},
    pattern
  );

  if(arr.total > 0){
    const shown = Math.min(arr.total, SHOWN_CAP);
    const g = roundedBoxGeo(ol - CASE_GAP, oh - CASE_GAP, ow - CASE_GAP,
                            Math.min(4, geo.meta.caliper*1.6), 2);
    const inst = new THREE.InstancedMesh(g, kraft, shown);
    const M = new THREE.Matrix4(), R = new THREE.Matrix4().makeRotationY(Math.PI/2);
    for(let i=0; i<shown; i++){
      const p = arr.placements[i];
      if(p.orientation === 'WLH') M.copy(R); else M.identity(); // 90° about vertical
      M.setPosition(p.x, ph + p.z, p.y);   // containment (x,y,z) -> world (x,z,y)
      inst.setMatrixAt(i, M);
    }
    palletGroup.add(inst);
  }

  const loadH = ph + arr.layers*oh;
  palletGroup.position.y = -loadH/2;                   // centre vertically for orbit
  palletGroup.visible = visible;
  pivot.add(palletGroup);
  setCamSpan(Math.max(pl, pw, loadH)*0.85);

  return {
    label: arr.label,
    perLayer: arr.perLayer,
    layers: arr.layers,
    total: arr.total,
    coveragePct: Math.round(arr.perLayer*ol*ow/(pl*pw)*100)
  };
}

export function showPallet(v){ if(palletGroup) palletGroup.visible = v; }
