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
