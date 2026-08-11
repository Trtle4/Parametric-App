/**
 * Thermoformed sizing tray — the 3D VISUAL.
 *
 * This is a sibling renderer (the product2d.js precedent), not a Geometry
 * style: the tray has no blank, no cut path and no creases, so nothing here
 * feeds a dieline or a DXF. It draws the ported dimensions (core/cookietray.js)
 * as a solid-looking part so the engineer can see what the envelope describes.
 *
 * APPROXIMATE BY DESIGN — with one exception. There is no CSG kernel here, so
 * the troughs are not boolean-cut out of a drafted body the way the upstream
 * CadQuery/replicad model does; the shell is assembled from drawn parts
 * (floor, perimeter walls, dividers, flange, lip) and the cells are the gaps
 * left between them. What must NOT be approximate is the TAPER: the part is
 * genuinely wider at the flange than at the base, because that is exactly the
 * fact the envelope handoff depends on (outer.L/W is the max cross-section,
 * never the inset base). A render that looked like a straight-sided box would
 * silently disagree with the number the whole chain is sized from.
 *
 * Uses the global THREE (classic script tag). All lengths mm. The group is
 * centred on the origin in plan and sits with its base at y = -overallH/2, to
 * match how every other depth centres its subject for the Dims overlay.
 */

/** Slight tint difference so the flange/lip read as separate features. */
const trayMat = new THREE.MeshStandardMaterial({
  color: 0xD8D2C4, roughness: 0.55, metalness: 0, side: THREE.DoubleSide
});
const trayMat2 = new THREE.MeshStandardMaterial({
  color: 0xC9C2B2, roughness: 0.6, metalness: 0, side: THREE.DoubleSide
});

/**
 * A four-sided frustum shell wall: a box whose BOTTOM face is inset by
 * `inset` on each horizontal axis relative to its top. Built as an explicit
 * 8-vertex hexahedron so the draft is real geometry, not a scale trick.
 */
function taperedSlab(topL, topW, botL, botW, h, matIdx){
  const g = new THREE.BufferGeometry();
  const tl = topL/2, tw = topW/2, bl = botL/2, bw = botW/2, hh = h/2;
  // 0-3 bottom (y=-hh), 4-7 top (y=+hh), CCW seen from above
  const v = new Float32Array([
    -bl, -hh, -bw,   bl, -hh, -bw,   bl, -hh,  bw,  -bl, -hh,  bw,
    -tl,  hh, -tw,   tl,  hh, -tw,   tl,  hh,  tw,  -tl,  hh,  tw
  ]);
  const idx = [
    0,1,2, 0,2,3,          // bottom
    4,6,5, 4,7,6,          // top
    0,4,5, 0,5,1,          // -W side
    1,5,6, 1,6,2,          // +L side
    2,6,7, 2,7,3,          // +W side
    3,7,4, 3,4,0           // -L side
  ];
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, matIdx ? trayMat2 : trayMat);
}

const box = (l, h, w, mat) => new THREE.Mesh(new THREE.BoxGeometry(l, h, w), mat ? trayMat2 : trayMat);

/**
 * Build the tray group from a resolved parameter set.
 * @param {Object} p  a core/cookietray.js trayParams() result
 * @returns {{group: THREE.Group, span: number, outer: {L,W,H}}}
 *   `outer` is the TRAY'S OWN placed box (long-axis rotation applied). It is
 *   deliberately NOT trayOuter(): that envelope also covers product standing
 *   proud of the cells, which this view does not draw. The Dims overlay must
 *   annotate what is actually on screen, so the two legitimately differ — the
 *   tray-depth HUD states the envelope alongside, so the difference reads as
 *   information rather than a contradiction.
 */
export function buildTray3d(p){
  const group = new THREE.Group();
  const {topL, topW, bottomL, bottomW, outerL, outerW, H, floor, cellLen, cellWid,
         nCells, wall, divider, flangeT, lipH, lipT, overallH} = p;

  // ---- drafted outer body: bottom inset by the draft, top at the rim ----
  // drawn as a shell: floor slab + four tapered perimeter walls, so the cells
  // are open from above (there is no lid) and the taper is visible on the
  // outside faces.
  const bodyH = H;
  const yBody = -overallH/2 + bodyH/2;

  // floor slab, itself drafted (it is the bottom of the tapered body)
  const floorTop = -overallH/2 + floor;
  const fBotL = bottomL, fBotW = bottomW;
  // interpolate the taper at the top of the floor slab
  const tf = floor/bodyH;
  const fTopL = bottomL + (topL - bottomL)*tf, fTopW = bottomW + (topW - bottomW)*tf;
  const floorMesh = taperedSlab(fTopL, fTopW, fBotL, fBotW, floor, false);
  floorMesh.position.y = -overallH/2 + floor/2;
  group.add(floorMesh);

  // perimeter walls above the floor, tapered over their own height
  const wallH = bodyH - floor;
  if(wallH > 0.01){
    const wTop = topL, wTopW = topW;
    const wBotL = fTopL, wBotW = fTopW;
    const yW = -overallH/2 + floor + wallH/2;
    // four separate tapered walls so the interior stays open (a single
    // tapered slab would fill the cells solid)
    const mk = (len, wid, cx, cz, botLen, botWid, botCx, botCz) => {
      const g = new THREE.BufferGeometry();
      const hh = wallH/2;
      const v = new Float32Array([
        botCx - botLen/2, -hh, botCz - botWid/2,  botCx + botLen/2, -hh, botCz - botWid/2,
        botCx + botLen/2, -hh, botCz + botWid/2,  botCx - botLen/2, -hh, botCz + botWid/2,
        cx - len/2,        hh, cz - wid/2,        cx + len/2,        hh, cz - wid/2,
        cx + len/2,        hh, cz + wid/2,        cx - len/2,        hh, cz + wid/2
      ]);
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex([0,1,2, 0,2,3, 4,6,5, 4,7,6, 0,4,5, 0,5,1, 1,5,6, 1,6,2, 2,6,7, 2,7,3, 3,7,4, 3,4,0]);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, trayMat);
      m.position.y = yW;
      return m;
    };
    const sTop = wall, sBot = wall + (topW - wBotW)/2;   // walls thicken toward the base with the draft
    // ±W walls (run along L)
    group.add(mk(wTop, sTop, 0, -(wTopW - sTop)/2, wBotL, sBot, 0, -(wBotW - sBot)/2));
    group.add(mk(wTop, sTop, 0,  (wTopW - sTop)/2, wBotL, sBot, 0,  (wBotW - sBot)/2));
    // ±L walls (run along W), inset so they meet the others
    const eTop = wTopW - 2*sTop, eBot = wBotW - 2*sBot;
    group.add(mk(sTop, Math.max(eTop, 0.1), -(wTop - sTop)/2, 0, sBot, Math.max(eBot, 0.1), -(wBotL - sBot)/2, 0));
    group.add(mk(sTop, Math.max(eTop, 0.1),  (wTop - sTop)/2, 0, sBot, Math.max(eBot, 0.1),  (wBotL - sBot)/2, 0));

    // ---- dividers between cells (vertical, per the upstream note that only
    // the outer body drafts — internal cell walls stay vertical) ----
    for(let j = 1; j < nCells; j++){
      const cz = -topW/2 + wall + j*(cellWid + divider) - divider/2;
      const d = box(cellLen, wallH, divider, true);
      d.position.set(0, yW, cz);
      group.add(d);
    }
  }

  // ---- flange: a flat ring flush with the rim, extending past the body ----
  const yFl = -overallH/2 + H - flangeT/2;
  const flange = new THREE.Mesh(ringGeo(outerL, outerW, topL, topW, flangeT), trayMat2);
  flange.position.y = yFl;
  group.add(flange);

  // ---- perimeter lip standing above the flange ----
  const lip = new THREE.Mesh(ringGeo(outerL, outerW, outerL - 2*lipT, outerW - 2*lipT, lipH), trayMat2);
  lip.position.y = -overallH/2 + H + lipH/2;
  group.add(lip);

  const outer = p.longAxis === 'Y'
    ? {L: outerW, W: outerL, H: overallH}
    : {L: outerL, W: outerW, H: overallH};
  if(p.longAxis === 'Y') group.rotation.y = Math.PI/2;

  return {group, span: Math.max(outer.L, outer.W, outer.H), outer};
}

/** A rectangular ring (picture-frame) solid: outer L×W, inner l×w, height h. */
function ringGeo(L, W, l, w, h){
  const parts = [];
  const dz = (W - w)/2, dx = (L - l)/2;
  const add = (bl, bw, cx, cz) => {
    const g = new THREE.BoxGeometry(bl, h, bw);
    g.translate(cx, 0, cz);
    parts.push(g);
  };
  add(L, dz, 0, -(W - dz)/2);            // -W bar
  add(L, dz, 0,  (W - dz)/2);            // +W bar
  add(dx, Math.max(w, 0.1), -(L - dx)/2, 0);   // -L bar
  add(dx, Math.max(w, 0.1),  (L - dx)/2, 0);   // +L bar
  return mergeGeos(parts);
}

/** Minimal geometry merge (r128 has no BufferGeometryUtils on the global). */
function mergeGeos(geos){
  let vCount = 0, iCount = 0;
  for(const g of geos){ vCount += g.attributes.position.count; iCount += g.index ? g.index.count : 0; }
  const pos = new Float32Array(vCount*3), nor = new Float32Array(vCount*3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for(const g of geos){
    const p = g.attributes.position, n = g.attributes.normal;
    pos.set(p.array, vo*3);
    if(n) nor.set(n.array, vo*3);
    const gi = g.index;
    for(let k = 0; k < gi.count; k++) idx[io + k] = gi.array[k] + vo;
    vo += p.count; io += gi.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* ---------------- STL export ----------------------------------------------
 * STL is a triangle soup, so it needs no CAD kernel: walk the built meshes,
 * transform every triangle into world space, and write it out. STEP is a
 * B-rep format and deliberately stays in Cookie-Tray — this exports the
 * VISUAL, which is why the header says so.
 */

/** ASCII STL of a THREE object's triangles, in world space. */
export function trayToSTL(root, name = 'tray'){
  const lines = [`solid ${name}`];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const n = new THREE.Vector3(), ab = new THREE.Vector3(), cb = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse(o => {
    if(!o.isMesh || !o.geometry) return;
    const g = o.geometry, pos = g.attributes.position;
    if(!pos) return;
    const index = g.index;
    const count = index ? index.count : pos.count;
    for(let i = 0; i < count; i += 3){
      for(let k = 0; k < 3; k++){
        const vi = index ? index.getX(i + k) : (i + k);
        v[k].fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
      }
      cb.subVectors(v[2], v[1]); ab.subVectors(v[0], v[1]);
      n.crossVectors(cb, ab).normalize();
      lines.push(`  facet normal ${n.x} ${n.y} ${n.z}`, '    outer loop');
      for(let k = 0; k < 3; k++) lines.push(`      vertex ${v[k].x} ${v[k].y} ${v[k].z}`);
      lines.push('    endloop', '  endfacet');
    }
  });
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}
