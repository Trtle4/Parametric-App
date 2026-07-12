/**
 * Case + cartons view: the solved case rendered semi-transparent with the
 * cartons instanced inside at their containment placements. Positions come
 * straight from the Arrangement — if they look wrong, containment.js is
 * wrong, and this view exists to make that visible.
 */
import {getPivot, setCamSpan, kraft, kraft2, roundedBoxGeo} from './fold3d.js';
import {orientDims} from '../core/containment.js';

const CARTON_GAP = 1;   // visual seam between cartons, mm

let nestGroup = null;

const shellMat = kraft.clone();
shellMat.transparent = true; shellMat.opacity = 0.25; shellMat.depthWrite = false;
const edgeMat = new THREE.LineBasicMaterial({color: 0x8a6a3f});

/**
 * @param {Object} caseGeo    Geometry of the case (outer/inner consumed)
 * @param {Object} cartonGeo  Geometry of the carton (outer consumed)
 * @param {import('../core/containment.js').Placement[]} placements
 * @param {boolean} visible
 */
export function buildNest(caseGeo, cartonGeo, placements, visible){
  const pivot = getPivot();
  if(nestGroup){
    pivot.remove(nestGroup);
    nestGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); });
  }
  nestGroup = new THREE.Group();

  const co = caseGeo.outer, ci = caseGeo.inner;

  // translucent case + edge box so the envelope stays legible
  const shell = new THREE.Mesh(roundedBoxGeo(co.L, co.H, co.W, Math.min(4, (co.L - ci.L)*0.8), 2), shellMat);
  nestGroup.add(shell);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(co.L, co.H, co.W)), edgeMat);
  nestGroup.add(edges);

  // cartons: cuboids need no rotation — orientation is applied by using the
  // oriented dims directly. One InstancedMesh per orientation present.
  const byO = new Map();
  for(const p of placements) byO.set(p.orientation, (byO.get(p.orientation) || []).concat(p));
  const floorY = -ci.H/2;   // cavity floor (cavity centred in the shell)
  for(const [o, list] of byO){
    const {l, w, h} = orientDims(cartonGeo.outer, o);
    const g = roundedBoxGeo(Math.max(l - CARTON_GAP, 1), Math.max(h - CARTON_GAP, 1), Math.max(w - CARTON_GAP, 1), 2, 2);
    const inst = new THREE.InstancedMesh(g, kraft2, list.length);
    const M = new THREE.Matrix4();
    list.forEach((p, i) => {
      M.identity();
      M.setPosition(p.x, floorY + p.z, p.y);   // containment (x,y,z) -> world (x,z,y)
      inst.setMatrixAt(i, M);
    });
    nestGroup.add(inst);
  }

  nestGroup.visible = visible;
  pivot.add(nestGroup);
  setCamSpan(Math.max(co.L, co.W, co.H));
}

export function showNest(v){ if(nestGroup) nestGroup.visible = v; }

/* ---------- Carton + product: real pieces at real placements ----------- */

let productGroup = null;
const productMat = new THREE.MeshStandardMaterial({color: 0xE0C089, roughness: 0.75, metalness: 0});

// envelope axis letter for a piece's stack/cylinder axis
const ENV_AXIS = {X: 'L', Y: 'W', Z: 'H'};
const IDX = {L: 0, W: 1, H: 2};

/**
 * Render the collation's pieces (cylinders as cylinders) inside a
 * translucent carton, mapped through the chosen envelope orientation.
 * Placements come straight from collate() — if this render and the numbers
 * disagree, the collation model is wrong, and that should be visible.
 * @param {Object} p  from core/project.js productNest()
 * @param {boolean} visible
 */
export function buildProductNest(p, visible){
  const pivot = getPivot();
  if(productGroup){
    pivot.remove(productGroup);
    productGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); });
  }
  productGroup = new THREE.Group();

  const co = p.cartonGeo.outer, ci = p.cartonGeo.inner;
  const env = p.result.envelope;
  const o = p.orientation;
  const piece = p.collation.piece;

  // translucent carton + edges
  const shell = new THREE.Mesh(roundedBoxGeo(co.L, co.H, co.W, Math.min(2, (co.L - ci.L)*0.8), 2), shellMat);
  productGroup.add(shell);
  productGroup.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(co.L, co.H, co.W)), edgeMat));

  // envelope -> carton mapping: carton x/depth/vertical take envelope axes
  // o[0]/o[1]/o[2]; envelope coords are x/y centred, z from envelope bottom
  const envDims = [env.L, env.W, env.H];
  const orientedH = envDims[IDX[o[2]]];
  const floorY = -ci.H/2 + (p.clearance.bottom || 0);
  const centre = e => [e[IDX[o[0]]], e[IDX[o[1]]], e[IDX[o[2]]]];   // -> [x, depth, vertical]

  // pieces are identical: one geometry (+ one rotation for cylinders)
  // placements are REAL; only the render geometry is shrunk a hair so
  // touching pieces read as individual pieces instead of one solid
  let geo, rot = null;
  if(piece.kind === 'cylinder'){
    geo = new THREE.CylinderGeometry(piece.diameter/2, piece.diameter/2, piece.thickness*0.94, 24);
    // cylinder axis: stack axis -> envelope axis -> carton slot -> world axis
    const slot = o.indexOf(ENV_AXIS[p.collation.stackAxis]);
    if(slot === 0) rot = new THREE.Matrix4().makeRotationZ(Math.PI/2);       // along carton length (world x)
    else if(slot === 1) rot = new THREE.Matrix4().makeRotationX(Math.PI/2);  // along carton depth (world z)
  }else{
    const d = [piece.L, piece.W, piece.H];
    geo = new THREE.BoxGeometry(d[IDX[o[0]]]*0.97, d[IDX[o[2]]]*0.97, d[IDX[o[1]]]*0.97);
  }

  const inst = new THREE.InstancedMesh(geo, productMat, p.result.placements.length);
  const M = new THREE.Matrix4();
  p.result.placements.forEach((pl, i) => {
    const e = [pl.x, pl.y, pl.z - env.H/2];            // envelope-centred
    const [cx, cd, cv] = centre(e);
    if(rot) M.copy(rot); else M.identity();
    M.setPosition(cx, floorY + orientedH/2 + cv, cd);
    inst.setMatrixAt(i, M);
  });
  productGroup.add(inst);

  productGroup.visible = visible;
  pivot.add(productGroup);
  setCamSpan(Math.max(co.L, co.W, co.H));
}

export function showProduct(v){ if(productGroup) productGroup.visible = v; }
