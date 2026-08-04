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
import {packArtGeometry, packArtMaterials} from './artwork3d.js';

let shelfGroup = null;
let shelfArtMat = null;                 // per-build art material+texture, disposed on rebuild
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
 * @param {{am:object, canvas:HTMLCanvasElement}|null} [art]  the sellable pack's
 *        artwork: every facing pack shows it, printed FRONT to the shopper. The
 *        caller packs in the print-front orientation ('LWH') so the pack's
 *        canonical footprint (L across, W deep, H up) matches od.
 */
export function buildShelf(od, shelf, placements, visible, art){
  const pivot = getPivot();
  if(shelfGroup){ pivot.remove(shelfGroup); shelfGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); }); }
  if(shelfArtMat){ if(shelfArtMat.map) shelfArtMat.map.dispose(); shelfArtMat.dispose(); shelfArtMat = null; }
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
    let pgeo, pmat, rot = false;
    if(art && art.am && art.canvas){
      // printed pack: the shared closed art body. packArtGeometry's FRONT is
      // +Z; the shelf's front (frontMat) is local -Z, so rotate each pack 180°
      // about the vertical to match — then the group's own 180° (below) carries
      // both to the shopper side. One shared texture across every facing pack.
      pgeo = packArtGeometry(art.am);
      const mats = packArtMaterials(art.canvas, kraft);
      shelfArtMat = mats[0];
      pmat = mats; rot = true;
    }else{
      pgeo = new THREE.BoxGeometry(Math.max(od.l - PACK_GAP, 1), Math.max(od.h - PACK_GAP, 1), Math.max(od.w - PACK_GAP, 1));
      pmat = packMats;
    }
    const inst = new THREE.InstancedMesh(pgeo, pmat, shown);
    const M = new THREE.Matrix4(), R = new THREE.Matrix4().makeRotationY(Math.PI);
    for(let i = 0; i < shown; i++){
      const p = placements[i];
      if(rot) M.copy(R); else M.identity();
      M.setPosition(p.x, p.z, p.y);                     // (across, up, depth)
      inst.setMatrixAt(i, M);
    }
    shelfGroup.add(inst);
  }

  shelfGroup.position.y = -H/2;                         // centre vertically for orbit
  // The shelf was built with the pack fronts at local -Z and the back wall at
  // +Z, but the ViewCube's FRONT looks down the opposite axis — so a straight
  // FRONT view showed the pack backs. Rotate the whole assembly 180° about the
  // vertical so its front IS the world front the ViewCube names.
  shelfGroup.rotation.y = Math.PI;
  shelfGroup.visible = visible;
  pivot.add(shelfGroup);
  setCamSpan(Math.max(W, D, H)*0.95);
}

export function showShelf(v){ if(shelfGroup) shelfGroup.visible = v; }
