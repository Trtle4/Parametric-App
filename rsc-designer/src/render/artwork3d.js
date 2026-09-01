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
 * `packArtGeometry` is the ONE geometry builder, shared by the single-pack fold
 * view (buildWrapArt) AND by the hierarchy/shelf InstancedMeshes (so every
 * instance of a pack type carries the same art from one texture). It returns a
 * CLOSED body: the printed faces as material group 0, plus (per end) either
 * printed MAJOR-FLAP quads — when the style declares `am.caps.top`/`.bottom`,
 * e.g. an RSC's two major flaps, folded flat and tiling the cap exactly, so
 * they join material group 0 too — or a plain board cap, as group 1, for a
 * style/end that declares none — so "Solid" looks solid either way.
 *
 * Verified from the ViewCube: FRONT faces +Z (the shopper), upright, unmirrored
 * (the texture's default flipY cancels artMap's bottom-up v).
 */
import {getPivot, setCamSpan, kraft} from './fold3d.js';

/** A CanvasTexture configured for artwork (sRGB, anisotropic). One per pack
 *  type — callers share it across every instance rather than duplicating. */
export function makeArtTexture(texCanvas){
  const tex = new THREE.CanvasTexture(texCanvas);
  tex.anisotropy = 8;
  if(THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The closed pack geometry in the pack's canonical local frame (centred on the
 * origin, FRONT toward +Z). Material groups: 0 = printed faces (+ wrap crimp
 * fins), 1 = board caps (the tube ends a carton closes with flaps). Wraps
 * declare `ends` (crimped seals) instead of caps, so they get fins, no caps.
 * @param {object} am  geo.meta.artMap
 * @returns {THREE.BufferGeometry}
 */
export function packArtGeometry(am){
  const CW = am.canvas.w, CH = am.canvas.h, half = am.length/2, ax = am.extrude, eU = am.extrudeIsU;
  const sec = am.section;
  const V = (e, pt) => ax === 'x' ? [e, pt[0], pt[1]]
                     : ax === 'y' ? [pt[0], e, pt[1]]
                     :              [pt[0], pt[1], e];

  const artP = [], artU = [], capP = [], capU = [];
  const tri = (P, Q, R, uP, uQ, uR, pArr, uArr) => { pArr.push(...P, ...Q, ...R); uArr.push(...uP, ...uQ, ...uR); };
  const quad = (A, B, C, D, uA, uB, uC, uD, pArr, uArr) => { tri(A, B, C, uA, uB, uC, pArr, uArr); tri(A, C, D, uA, uC, uD, pArr, uArr); };

  // printed faces
  for(let i = 0; i < am.faces.length; i++){
    const f = am.faces[i], pa = sec[i], pb = sec[i + 1];
    const u0 = f.u0/CW, u1 = f.u1/CW, v0 = f.v0/CH, v1 = f.v1/CH;
    const A = V(-half, pa), B = V(half, pa), C = V(half, pb), D = V(-half, pb);
    // eU: extrude axis carries u (wrap). Else extrude carries v (carton, upright
    // = +half→v1) and the section walk carries u REVERSED — transposing u/v
    // flips handedness, so one axis must flip back to keep the print unmirrored.
    if(eU) quad(A, B, C, D, [u0, v0], [u1, v0], [u1, v1], [u0, v1], artP, artU);
    else   quad(A, B, C, D, [u1, v0], [u1, v1], [u0, v1], [u0, v0], artP, artU);
  }

  // crimped end fins (wrap only): flat quads standing out along the extrude
  // axis, carrying the end-seal column. Part of the printed group.
  if(am.ends && ax === 'x'){
    const finLen = Math.max(am.ends[0].u1 - am.ends[0].u0, am.length*0.04);
    const yMax = Math.max(...sec.map(p => p[0])), yMin = Math.min(...sec.map(p => p[0]));
    const addFin = (baseX, dir, col) => {
      const ex = baseX + dir*finLen, cu0 = col.u0/CW, cu1 = col.u1/CW;
      quad([baseX, yMin, 0], [ex, yMin, 0], [ex, yMax, 0], [baseX, yMax, 0],
           [cu0, 0], [cu1, 0], [cu1, 1], [cu0, 1], artP, artU);
    };
    addFin(-half, -1, am.ends[0]);
    addFin(half, 1, am.ends[1]);
  }

  // caps: close the tube at ±half (a carton's top/bottom flap faces) when the
  // style has no crimped ends. Two shapes, per end independently:
  //   - PRINTED major flaps (am.caps.top / .bottom, e.g. an RSC): each flap
  //     folds flat about an axis parallel to the extrude axis, so its crease
  //     corners are exactly the wall's own top/bottom edge (V(e, pa/pb), the
  //     SAME points the printed-faces loop above already places) and its tip
  //     is that same section point pulled toward the centreline by the
  //     flap's own depth — folding never moves the extrude-axis coordinate
  //     (pt[0]), only the girth coordinate (pt[1]) shifts. u is inherited
  //     unchanged from the flap's own wall face (u never moves either); v
  //     runs from the crease (the wall's own edge v) to the declared tip.
  //     Joins the PRINTED group (artP/artU) — this is real artwork, not board.
  //   - a plain BOARD cap (the previous, only, behaviour), triangle-fanned
  //     from the section centroid — UVs unused (0,0) — for any end a style
  //     does not declare `caps` for.
  if(!am.ends){
    const uniq = sec.slice(0, sec.length - 1);        // drop the repeated closing point
    const cx = uniq.reduce((s, p) => s + p[0], 0)/uniq.length;
    const cy = uniq.reduce((s, p) => s + p[1], 0)/uniq.length;
    const boardCap = (e, flip) => {
      const C0 = V(e, [cx, cy]);
      for(let k = 0; k < uniq.length; k++){
        const a = V(e, uniq[k]), b = V(e, uniq[(k + 1) % uniq.length]);
        if(flip) tri(C0, b, a, [0, 0], [0, 0], [0, 0], capP, capU);
        else     tri(C0, a, b, [0, 0], [0, 0], [0, 0], capP, capU);
      }
    };
    const printedCap = (e, flaps) => {
      for(const flap of flaps){
        const pa = sec[flap.face], pb = sec[flap.face + 1];
        const depth = Math.abs(flap.v1 - flap.v0);
        const shift = pt => [pt[0], pt[1] - Math.sign(pt[1])*depth];
        const f = am.faces[flap.face];
        const u0 = f.u0/CW, u1 = f.u1/CW, v0 = flap.v0/CH, v1 = flap.v1/CH;
        const creaseA = V(e, pa), tipA = V(e, shift(pa)), tipB = V(e, shift(pb)), creaseB = V(e, pb);
        quad(creaseA, tipA, tipB, creaseB, [u1, v0], [u1, v1], [u0, v1], [u0, v0], artP, artU);
      }
    };
    const capsTop = am.caps && am.caps.top, capsBottom = am.caps && am.caps.bottom;
    if(capsTop && capsTop.length) printedCap(half, capsTop); else boardCap(half, false);
    if(capsBottom && capsBottom.length) printedCap(-half, capsBottom); else boardCap(-half, true);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(artP.concat(capP), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(artU.concat(capU), 2));
  g.computeVertexNormals();
  const artVerts = artP.length/3, capVerts = capP.length/3;
  g.addGroup(0, artVerts, 0);                         // group 0 → printed material
  if(capVerts) g.addGroup(artVerts, capVerts, 1);     // group 1 → board caps
  g.userData.spanMax = Math.max(am.length, ...sec.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1]))*2));
  return g;
}

/** Printed + cap material array for a pack, sharing one texture. capMat
 *  defaults to the shared kraft board. */
export function packArtMaterials(texCanvas, capMat){
  const artMat = new THREE.MeshStandardMaterial({map: makeArtTexture(texCanvas), roughness: 0.62, metalness: 0, side: THREE.DoubleSide});
  return [artMat, capMat || kraft];
}

/* ---------- single-pack fold view (the active style level in Fold mode) ---- */

let artGroup = null;

function disposeArtGroup(){
  if(!artGroup) return;
  getPivot().remove(artGroup);
  artGroup.traverse(o => {
    if(o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    mats.forEach(m => { if(m.map) m.map.dispose(); if(m !== kraft) m.dispose(); });
  });
  artGroup = null;
}

/**
 * Build (or rebuild) the single opened pack's art cladding (Fold view).
 * @param {import('../core/types.js').Geometry} geo   must carry meta.artMap
 * @param {HTMLCanvasElement} texCanvas
 * @param {boolean} visible
 */
export function buildWrapArt(geo, texCanvas, visible){
  disposeArtGroup();
  const am = geo.meta.artMap;
  if(!am || !texCanvas) return;
  const g = packArtGeometry(am);
  const mats = packArtMaterials(texCanvas);
  artGroup = new THREE.Group();
  artGroup.add(new THREE.Mesh(g, mats));
  artGroup.visible = visible;
  getPivot().add(artGroup);
  setCamSpan(g.userData.spanMax);
}

export function showWrapArt(v){ if(artGroup) artGroup.visible = v; }
export function clearWrapArt(){ disposeArtGroup(); }
export function hasWrapArt(){ return !!artGroup; }
