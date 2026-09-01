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
 * printed FLAP quads — when the style declares `am.caps.top`/`.bottom`, e.g.
 * an RSC's two major flaps (which tile the cap exactly, zero leftover) or a
 * reverse-tuck's single tuck panel (which usually doesn't reach the far
 * side) — joining material group 0 too, PLUS a plain board rectangle (group
 * 1) for whatever girth span those flaps don't reach, computed from their
 * own folded footprint rather than declared by the style — or a plain board
 * cap fan, entirely group 1, for a style/end that declares no caps at all —
 * so "Solid" looks solid either way.
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
 * The crimped end seal's two PLIES, derived — never authored.
 *
 * A flow wrap's end seal is not a panel with artwork of its own. It is the
 * tube's own film, continuing past the product and pinched flat, so its
 * mapping has to come from the SAME girth parameterisation the bands use: the
 * section polyline, walked with the `faces` v-breakpoints. Flattening cuts
 * that polyline where it crosses the mid-plane of the DECLARED flatten axis
 * (`am.flattenAxis` — a machine fact the style states, never inferred from the
 * section's shape) and lays each half flat. Each ply is therefore a
 * half-girth run of v, read straight off the band breakpoints; together the
 * two account for the full girth exactly once.
 *
 * The ply on the + side of the flatten axis is the one facing the shopper
 * (the FRONT band sits there); the − side ply is centred on the rear seam,
 * which is where the girth parameterisation starts and ends — so THAT ply
 * comes back as TWO runs, contiguous around the tube but split in the
 * template. Callers must draw both.
 *
 * IDEALISATION, stated: a half-girth of film (girth/2) is gathered into a flat
 * width of only `across` — real film pleats at the corners. Each run is
 * stretched uniformly over its share of the width rather than modelling the
 * pleat, which keeps the mapping continuous and lands the FRONT band's own
 * midpoint exactly on the fin's centreline.
 *
 * @param {object} am  geo.meta.artMap (needs section, faces, flattenAxis, ends)
 * @returns {?{across: number[], acrossAxis: number, flatAxis: number,
 *             plies: Array<{side: number, runs: Array<{v0,v1,a0,a1: number}>}>}}
 *   null when the style declares no flatten axis, or when the section does not
 *   cut into exactly two plies (anything else is not a simple flatten, and a
 *   guess there would be worse than no mapping).
 */
export function finPlies(am){
  if(!am || !Array.isArray(am.section) || !Array.isArray(am.faces)) return null;
  const ci = am.flattenAxis === 'z' ? 1 : am.flattenAxis === 'y' ? 0 : -1;
  if(ci < 0) return null;                       // undeclared: refuse, never assume
  const ai = 1 - ci;                            // the ACROSS axis the flat fin spans
  const sec = am.section, faces = am.faces;
  if(sec.length !== faces.length + 1) return null;   // one band per segment, or this walk is not the girth

  // v at each section vertex, straight off the bands' own breakpoints
  const vAt = faces.map(f => f.v0);
  vAt.push(faces[faces.length - 1].v1);

  const vals = sec.map(p => p[ci]);
  const mid = (Math.min(...vals) + Math.max(...vals))/2;
  const cuts = [];
  for(let i = 0; i < sec.length - 1; i++){
    const A = sec[i], B = sec[i + 1], dA = A[ci] - mid, dB = B[ci] - mid;
    if((dA < 0 && dB > 0) || (dA > 0 && dB < 0)){
      const t = dA/(dA - dB);
      cuts.push({
        v: vAt[i] + t*(vAt[i + 1] - vAt[i]),
        across: A[ai] + t*(B[ai] - A[ai]),
        into: dB > 0 ? 1 : -1                   // which half the walk enters here
      });
    }
  }
  if(cuts.length !== 2) return null;

  const vStart = vAt[0], vEnd = vAt[vAt.length - 1], half = (vEnd - vStart)/2;
  const [c0, c1] = cuts;
  const span = c0.across - c1.across;           // the far ply walks c1 -> c0
  const l1 = vEnd - c1.v, l2 = c0.v - vStart;   // the far ply's two runs
  const aMid = c1.across + (l1/half)*span;      // where its seam lands across the fin
  return {
    across: [c0.across, c1.across],
    acrossAxis: ai, flatAxis: ci,
    plies: [
      // the walk between the two cuts lies in the half c0 opens into
      {side: c0.into, runs: [{v0: c0.v, v1: c1.v, a0: c0.across, a1: c1.across}]},
      // ...and the complement wraps the seam, so it is two runs, not one
      {side: -c0.into, runs: [
        {v0: c1.v, v1: vEnd, a0: c1.across, a1: aMid},
        {v0: vStart, v1: c0.v, a0: aMid, a1: c0.across}
      ]}
    ]
  };
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
    const fp = finPlies(am);
    // the crimp's PLIES, each a half-girth run of the tube's own v (finPlies).
    // The fin used to be ONE quad carrying v 0..1 — the whole canvas height,
    // fin allowance and all, squashed across its width. That is the same
    // arbitrary-range mistake hierarchy3d.js's crimp tab already fixed for the
    // pillow body by reading the crimp ring's own v; this reads the section
    // walk instead, which is the same girth, one level earlier.
    const spanAcross = Math.abs(fp ? fp.across[1] - fp.across[0]
                                  : Math.max(...sec.map(p => p[0])) - Math.min(...sec.map(p => p[0])));
    // the two plies are pressed together; separate them by a hair so neither
    // z-fights the other. RENDER-ONLY, like fold3d's RENDER_MIN_THICKNESS —
    // real film gauge is microns and would render as one surface.
    const plyGap = Math.max(1e-3, spanAcross*0.002);
    const addFin = (baseX, dir, end) => {
      // draw the FULL printed extent, not just the seal: the bleed lies
      // between the seal boundary and the film edge, so a fin drawn u0..u1
      // stops exactly where the bleed starts and the bleed never prints.
      const pU0 = end.printU0 != null ? end.printU0 : end.u0;
      const pU1 = end.printU1 != null ? end.printU1 : end.u1;
      const finLen = Math.max(pU1 - pU0, am.length*0.04);
      const ex = baseX + dir*finLen;
      // u runs INBOARD -> tip. At the leading end the film's u decreases
      // outward (the blank's own edge is u=0); at the trailing end it
      // increases. Reading it off the end's own printed extent by direction
      // keeps both ends' bleed at the OUTSIDE, where bleed belongs.
      const uIn = (dir < 0 ? pU1 : pU0)/CW, uTip = (dir < 0 ? pU0 : pU1)/CW;
      if(!fp){                                   // no declared flatten: board-flat, unmapped
        const yMax = Math.max(...sec.map(p => p[0])), yMin = Math.min(...sec.map(p => p[0]));
        quad([baseX, yMin, 0], [ex, yMin, 0], [ex, yMax, 0], [baseX, yMax, 0],
             [uIn, 0], [uTip, 0], [uTip, 1], [uIn, 1], artP, artU);
        return;
      }
      for(const ply of fp.plies){
        const off = ply.side*plyGap;
        for(const r of ply.runs){
          // positions are built from WORLD across-coordinates, identical at
          // both ends -- the film's v at a given point of the tube does not
          // depend on which end you look at, so the two crimps must not
          // mirror in v. Only u mirrors, and that comes from `dir` above.
          const P = a => { const pt = []; pt[fp.acrossAxis] = a; pt[fp.flatAxis] = off; return pt; };
          const A = V(baseX, P(r.a0)), B = V(ex, P(r.a0)), C = V(ex, P(r.a1)), D = V(baseX, P(r.a1));
          const v0 = r.v0/CH, v1 = r.v1/CH;
          quad(A, B, C, D, [uIn, v0], [uTip, v0], [uTip, v1], [uIn, v1], artP, artU);
        }
      }
    };
    addFin(-half, -1, am.ends[0]);
    addFin(half, 1, am.ends[1]);
  }

  // caps: close the tube at ±half (a carton's top/bottom flap faces) when the
  // style has no crimped ends. Two shapes, per end independently, and they
  // can COMBINE on the same end:
  //   - PRINTED flaps (am.caps.top / .bottom, e.g. an RSC's two majors or a
  //     reverse-tuck's single tuck panel): each flap folds flat about an
  //     axis parallel to the extrude axis, so its crease corners are exactly
  //     the wall's own top/bottom edge (V(e, pa/pb), the SAME points the
  //     printed-faces loop above already places) and its tip is that same
  //     section point pulled toward the centreline by the flap's own depth
  //     — folding never moves the extrude-axis coordinate (pt[0]), only the
  //     girth coordinate (pt[1]) shifts. u is inherited unchanged from the
  //     flap's own wall face (u never moves either); v runs from the crease
  //     (the wall's own edge v) to the declared tip. Joins the PRINTED group
  //     (artP/artU) — this is real artwork, not board. A style hands this
  //     builder only VISIBLE depths (e.g. a seal-end's major flap trimmed to
  //     the portion its own seal flap doesn't glue over) — this function
  //     draws exactly the rectangles it's given, no style-specific overlap
  //     reasoning lives here.
  //   - a plain BOARD residual for whatever girth span the declared flaps
  //     don't reach (a reverse-tuck's tuck panel alone rarely reaches the
  //     full W — nothing else on that end carries print, since the dust
  //     flaps under it are never declared here either, so the honest fill
  //     is the same unprinted board `boardCap` already draws when an end
  //     has NO printed flaps at all). Computed generically from the
  //     declared flaps' own folded footprint — a style that exactly tiles
  //     (an RSC's two majors, a seal-end's major+seal) produces zero
  //     residual and this never runs.
  //   - the ORIGINAL all-board fan (triangulated from the section centroid)
  //     for any end a style declares NO `caps` for at all.
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
    // a plain board RECTANGLE, full extrude-axis width, for one leftover
    // girth sub-range -- the flat-style analogue of boardCap's fan, but for
    // a partial gap rather than the whole end.
    const boardStrip = (e, x0, x1, z0, z1) => {
      const A = V(e, [x0, z0]), B = V(e, [x1, z0]), C = V(e, [x1, z1]), D = V(e, [x0, z1]);
      quad(A, B, C, D, [0, 0], [0, 0], [0, 0], [0, 0], capP, capU);
    };
    const printedCap = (e, flaps) => {
      const covered = [];   // [min,max] girth sub-range each flap actually reaches
      for(const flap of flaps){
        const depth = Math.abs(flap.v1 - flap.v0);
        if(depth <= 0) continue;   // fully trimmed away (e.g. one flap's seal overlap reaches the whole cap) -- nothing to draw
        const pa = sec[flap.face], pb = sec[flap.face + 1];
        const shift = pt => [pt[0], pt[1] - Math.sign(pt[1])*depth];
        const f = am.faces[flap.face];
        const u0 = f.u0/CW, u1 = f.u1/CW, v0 = flap.v0/CH, v1 = flap.v1/CH;
        const creaseA = V(e, pa), tipA = V(e, shift(pa)), tipB = V(e, shift(pb)), creaseB = V(e, pb);
        quad(creaseA, tipA, tipB, creaseB, [u1, v0], [u1, v1], [u0, v1], [u0, v0], artP, artU);
        const shifted = pa[1] - Math.sign(pa[1])*depth;
        covered.push([Math.min(pa[1], shifted), Math.max(pa[1], shifted)]);
      }
      // fill whatever girth span none of the declared flaps reached
      const allX = sec.map(p => p[0]), allZ = sec.map(p => p[1]);
      const minX = Math.min(...allX), maxX = Math.max(...allX);
      const minZ = Math.min(...allZ), maxZ = Math.max(...allZ);
      const merged = covered.sort((a, b) => a[0] - b[0]).reduce((acc, [a, b]) => {
        if(acc.length && a <= acc[acc.length - 1][1] + 1e-6) acc[acc.length - 1][1] = Math.max(acc[acc.length - 1][1], b);
        else acc.push([a, b]);
        return acc;
      }, []);
      let cursor = minZ;
      for(const [a, b] of merged){
        if(a > cursor + 1e-6) boardStrip(e, minX, maxX, cursor, a);
        cursor = Math.max(cursor, b);
      }
      if(maxZ > cursor + 1e-6) boardStrip(e, minX, maxX, cursor, maxZ);
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
