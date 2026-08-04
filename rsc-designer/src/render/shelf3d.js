/**
 * Retail shelf visualization — RENDER ONLY. The packing itself is core
 * containment: app.js's refreshShelf runs fitInto with the shelf opening
 * (width × depth × height) as the cavity and the sellable pack's outer as the
 * child, exactly like every other parent; this module only draws the result.
 *
 * A base surface the product sits on, a back wall, and the shelf above drawn
 * as a translucent ceiling plane (empty — it only sets the height ceiling).
 * Packs are stocked at the placements fitInto returned (subset to the user's
 * facings/stack/deep, filled from the back forward). The pack's front face —
 * toward the shopper at -Z — gets a distinct "label" material so the chosen
 * front panel reads at a glance and artwork can drop onto that face later.
 *
 * Coordinate mapping mirrors the pallet render: world x = across (placement x),
 * world y = up (placement z), world z = depth (placement y). All lengths mm.
 */
import {getPivot, setCamSpan, kraft} from './fold3d.js';

let shelfGroup = null;
const SHOWN_CAP = 4000;            // instancing cap for absurd inputs
const PACK_GAP = 1.5;              // visual seam between packs
const SURFACE_T = 10;              // shelf / ceiling / wall board thickness, mm

const shelfMat = new THREE.MeshStandardMaterial({color: 0xCED4DA, roughness: 0.95, metalness: 0, side: THREE.DoubleSide});
const wallMat  = new THREE.MeshStandardMaterial({color: 0xDCE1E6, roughness: 0.95, metalness: 0, side: THREE.DoubleSide});
const ceilMat  = new THREE.MeshStandardMaterial({color: 0xC7CED5, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.26, side: THREE.DoubleSide});
// the shopper-facing panel — a light "label" tint so the front is unmistakable
const frontMat = new THREE.MeshStandardMaterial({color: 0xEFE7D2, roughness: 0.85, metalness: 0});
// BoxGeometry material groups are ordered +x,-x,+y,-y,+z,-z. The shopper faces
// -Z, so the front panel is group index 5.
const packMats = [kraft, kraft, kraft, kraft, kraft, frontMat];

/**
 * @param {{l:number,w:number,h:number}} od  oriented pack dims (l across, w deep, h up)
 * @param {{width:number,depth:number,height:number}} shelf
 * @param {{x:number,y:number,z:number}[]} placements  fitInto placements (subset), cavity-centred
 * @param {boolean} visible
 * @param {*} [art]  reserved for per-pack artwork (deferred — see note in body)
 */
export function buildShelf(od, shelf, placements, visible, art){
  const pivot = getPivot();
  if(shelfGroup){ pivot.remove(shelfGroup); shelfGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); }); }
  shelfGroup = new THREE.Group();
  const W = shelf.width, D = shelf.depth, H = shelf.height, t = SURFACE_T;

  const base = new THREE.Mesh(new THREE.BoxGeometry(W, t, D), shelfMat);
  base.position.set(0, -t/2, 0);                        // top surface at y = 0
  shelfGroup.add(base);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(W, H + t, t), wallMat);
  wall.position.set(0, (H + t)/2 - t, D/2 + t/2);       // back wall at the far depth (+Z)
  shelfGroup.add(wall);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(W, t, D), ceilMat);
  ceil.position.set(0, H + t/2, 0);                     // the shelf above (empty ceiling)
  shelfGroup.add(ceil);

  const shown = Math.min(placements.length, SHOWN_CAP);
  if(shown > 0){
    // NOTE: per-pack ARTWORK on the shelf is deferred. The hierarchy/pallet
    // instance texturing (packArtGeometry + shared texture) is the mechanism;
    // wiring it here needs the shelf's shopper-face convention reconciled with
    // the artMap FRONT (+Z) — verified interactively, not in the headless
    // harness. Until then the shelf keeps the front-panel tint so the facing
    // face still reads. `art` is accepted so the call site is already in place.
    void art;
    const pgeo = new THREE.BoxGeometry(Math.max(od.l - PACK_GAP, 1), Math.max(od.h - PACK_GAP, 1), Math.max(od.w - PACK_GAP, 1));
    const inst = new THREE.InstancedMesh(pgeo, packMats, shown);
    const M = new THREE.Matrix4();
    for(let i = 0; i < shown; i++){
      const p = placements[i];
      M.identity();
      M.setPosition(p.x, p.z, p.y);                     // (across, up, depth)
      inst.setMatrixAt(i, M);
    }
    shelfGroup.add(inst);
  }

  shelfGroup.position.y = -H/2;                         // centre vertically for orbit
  shelfGroup.visible = visible;
  pivot.add(shelfGroup);
  setCamSpan(Math.max(W, D, H)*0.95);
}

export function showShelf(v){ if(shelfGroup) shelfGroup.visible = v; }
