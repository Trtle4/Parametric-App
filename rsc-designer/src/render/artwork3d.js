/**
 * Artwork → 3D. RENDER ONLY, and STYLE-AGNOSTIC: one builder clads any pack
 * whose style publishes a `geo.meta.artMap`. The map is the real UV mapping —
 * derivable, not guessed — because it comes from the same panel decomposition
 * the template and the 2D overlay read, so the three can never disagree.
 *
 * The map describes a tube: a cross-section polyline extruded along one world
 * axis, one quad per face, each face carrying the template rect (u,v in mm) it
 * samples. A flow wrap is a horizontal tube (extrude along L, girth around the
 * W×H section, film run = u); a carton is the same idea stood upright (extrude
 * along H, girth around the L×W walls, height = v). Nothing here is per-style —
 * the orientation lives entirely in the style's artMap.
 *
 * Verified from the ViewCube: FRONT faces +Z (the shopper), upright, unmirrored
 * (the texture's default flipY cancels artMap's bottom-up v).
 */
import {getPivot, setCamSpan} from './fold3d.js';

let artGroup = null;

function disposeArtGroup(){
  if(!artGroup) return;
  getPivot().remove(artGroup);
  artGroup.traverse(o => {
    if(o.geometry) o.geometry.dispose();
    if(o.material){ if(o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  artGroup = null;
}

/**
 * Build (or rebuild) a pack's art cladding from geo.meta.artMap + a composed
 * art-on-template canvas.
 * @param {import('../core/types.js').Geometry} geo
 * @param {HTMLCanvasElement} texCanvas
 * @param {boolean} visible
 */
export function buildWrapArt(geo, texCanvas, visible){
  disposeArtGroup();
  const am = geo.meta.artMap;
  if(!am || !texCanvas) return;

  const tex = new THREE.CanvasTexture(texCanvas);
  tex.anisotropy = 8;
  if(THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({map: tex, roughness: 0.62, metalness: 0, side: THREE.DoubleSide});

  const CW = am.canvas.w, CH = am.canvas.h, half = am.length/2, ax = am.extrude, eU = am.extrudeIsU;
  const sec = am.section;
  // place a vertex from (extrude offset e, section point [p,q])
  const V = (e, pt) => ax === 'x' ? [e, pt[0], pt[1]]
                     : ax === 'y' ? [pt[0], e, pt[1]]
                     :              [pt[0], pt[1], e];

  const pos = [], uv = [];
  const tri = (P, Q, R, uP, uQ, uR) => { pos.push(...P, ...Q, ...R); uv.push(...uP, ...uQ, ...uR); };
  const quad = (A, B, C, D, uA, uB, uC, uD) => { tri(A, B, C, uA, uB, uC); tri(A, C, D, uA, uC, uD); };

  for(let i = 0; i < am.faces.length; i++){
    const f = am.faces[i], pa = sec[i], pb = sec[i + 1];
    const u0 = f.u0/CW, u1 = f.u1/CW, v0 = f.v0/CH, v1 = f.v1/CH;
    const A = V(-half, pa), B = V(half, pa), C = V(half, pb), D = V(-half, pb);
    // eU: the extrude axis carries u (wrap — film runs along L); else it carries
    // v (carton — height runs up), and the section walk carries u. In the
    // carton case the extrude axis points up (+half = top of body = v1), so the
    // -half/+half ends take v1/v0 to keep the print upright.
    // eU: extrude axis carries u (wrap). Else extrude carries v (carton, upright
    // = +half→v1) and the section walk carries u REVERSED — transposing u/v
    // flips handedness, so one axis must flip back to keep the print unmirrored.
    if(eU) quad(A, B, C, D, [u0, v0], [u1, v0], [u1, v1], [u0, v1]);
    else   quad(A, B, C, D, [u1, v0], [u1, v1], [u0, v1], [u0, v0]);
  }

  // crimped end fins (wrap only): flat quads standing out along the extrude
  // axis, carrying the end-seal column. Skipped when the map declares no ends.
  if(am.ends && ax === 'x'){
    const finLen = Math.max(am.ends[0].u1 - am.ends[0].u0, am.length*0.04);
    // fin spans the full front/back width (the first section axis), at mid depth
    const yMax = Math.max(...sec.map(p => p[0])), yMin = Math.min(...sec.map(p => p[0]));
    const addFin = (baseX, dir, col) => {
      const ex = baseX + dir*finLen, cu0 = col.u0/CW, cu1 = col.u1/CW;
      quad([baseX, yMin, 0], [ex, yMin, 0], [ex, yMax, 0], [baseX, yMax, 0],
           [cu0, 0], [cu1, 0], [cu1, 1], [cu0, 1]);
    };
    addFin(-half, -1, am.ends[0]);
    addFin(half, 1, am.ends[1]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();

  artGroup = new THREE.Group();
  artGroup.add(new THREE.Mesh(g, mat));
  artGroup.visible = visible;
  getPivot().add(artGroup);
  setCamSpan(Math.max(am.length, ...sec.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1]))*2)));
}

export function showWrapArt(v){ if(artGroup) artGroup.visible = v; }
export function clearWrapArt(){ disposeArtGroup(); }
export function hasWrapArt(){ return !!artGroup; }
