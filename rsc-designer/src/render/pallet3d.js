/**
 * Pallet view: timber model + instanced case rendering.
 * Layer layout comes from core/pack.js; case outside dimensions come from
 * the style's Geometry.outer — this module never adds caliper itself.
 * All lengths in mm.
 */
import {packLayer, stack} from '../core/pack.js';
import {getPivot, setCamSpan, kraft, roundedBoxGeo} from './fold3d.js';

// GMA-style timber, mm
const DECK_T = 16, STRINGER_H = 95, BOTTOM_T = 16;   // board thicknesses
const STRINGER_W = 38, BOARD_W = 140;                // member widths
const DECK_PITCH = 190;                              // target deck-board spacing
const CASE_GAP = 2;                                  // visual seam between cases
const SHOWN_CAP = 4000;                              // instancing cap for absurd inputs

const wood = new THREE.MeshStandardMaterial({color:0xA0815A, roughness:0.95, metalness:0});

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
  const t = (geo.outer.L - geo.inner.L)/2;             // board thickness (corner radius only)
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

  // layout + stacking (generic solver; parent = deck, child = case footprint)
  const layer = packLayer({childL: ol, childW: ow, parentL: pl, parentW: pw, pattern});
  const {layers, total, loadHeight} = stack({perLayer: layer.perLayer, childH: oh, parentMaxH: pallet.maxH, baseH: ph});

  if(total > 0){
    const shown = Math.min(total, SHOWN_CAP);
    const g = roundedBoxGeo(ol - CASE_GAP, oh - CASE_GAP, ow - CASE_GAP, Math.min(4, t*1.6), 2);
    const inst = new THREE.InstancedMesh(g, kraft, shown);
    const M = new THREE.Matrix4(), R = new THREE.Matrix4().makeRotationY(Math.PI/2);
    let i = 0;
    outer: for(let ly=0; ly<layers; ly++){
      const flip = pattern === 'interlock' && (ly & 1);   // mirror odd layers (180° turn)
      for(const b of layer.positions){
        if(i >= shown) break outer;
        if(b.rot) M.copy(R); else M.identity();           // rotated cases turn 90° about y
        M.setPosition(flip ? -b.x : b.x, ph + oh/2 + ly*oh, flip ? -b.y : b.y);
        inst.setMatrixAt(i++, M);
      }
    }
    palletGroup.add(inst);
  }

  palletGroup.position.y = -loadHeight/2;               // centre vertically for orbit
  palletGroup.visible = visible;
  pivot.add(palletGroup);
  setCamSpan(Math.max(pl, pw, loadHeight)*0.85);

  return {
    label: layer.label,
    perLayer: layer.perLayer,
    layers, total,
    coveragePct: Math.round(layer.perLayer*ol*ow/(pl*pw)*100)
  };
}

export function showPallet(v){ if(palletGroup) palletGroup.visible = v; }
