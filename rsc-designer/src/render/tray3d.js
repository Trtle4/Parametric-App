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
import {packPitchOf} from '../core/cookietray.js';

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

/** Product tint — distinct from the tray so contents read at a glance. */
const productMat = new THREE.MeshStandardMaterial({color: 0xC98A3C, roughness: 0.8, metalness: 0});

/** A single product solid + the rotation that lays it the way the collation
 *  does. Mirrors the shared pieceGeo convention: an ON-EDGE cylinder lies on
 *  its side with its axis along the cell run (X). */
function pieceGeo(piece, stackAxis){
  if(piece.kind === 'cylinder'){
    const g = new THREE.CylinderGeometry(piece.diameter/2, piece.diameter/2, piece.thickness, 28);
    // default cylinder axis is Y (standing). On edge -> lay it along X.
    const rot = stackAxis === 'Z' ? null : new THREE.Matrix4().makeRotationZ(Math.PI/2);
    return {geo: g, rot};
  }
  return {geo: new THREE.BoxGeometry(piece.L, piece.H, piece.W), rot: null};
}

/** Height of a piece's CENTRE above the surface it bears on. */
function pieceRise(piece, stackAxis){
  if(piece.kind === 'cylinder') return stackAxis === 'Z' ? piece.thickness/2 : piece.diameter/2;
  return piece.H/2;
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
export function buildTray3d(p, contents){
  const group = new THREE.Group();
  const {topL, topW, bottomL, bottomW, outerL, outerW, H, cellWid, cellLen, cellH, cradleR,
         wall, divider, colDivider, flangeT, lipH, lipT, overallH, cornerR,
         bottomCornerR, outerR, cols, nCells} = p;
  const y0 = -overallH/2;                         // the tray's own base plane

  /* ---- outer drafted body, with ROUNDED CORNERS ------------------------
   * Lofted between two rounded-rect outlines (inset base -> rim), so the
   * draft and the corner radius are both real geometry. No booleans: the
   * body is a surface stitched from two loops plus a base cap. */
  const base = roundedRectLoop(bottomL, bottomW, bottomCornerR, CORNER_SEG);
  const rim  = roundedRectLoop(topL, topW, cornerR, CORNER_SEG);
  group.add(new THREE.Mesh(loftLoops(base, y0, rim, y0 + H), trayMat));
  group.add(new THREE.Mesh(capLoop(base, y0, false), trayMat));      // underside

  /* ---- flange and lip as DISTINCT STEPS --------------------------------
   * flange: a flat rounded ring from the rim out to outerL/W, sitting just
   * below the rim face. lip: a shorter, taller ring standing proud of it —
   * two separate steps rather than one slab, which is what reads as a
   * thermoformed rim. */
  const flOut = roundedRectLoop(outerL, outerW, outerR, CORNER_SEG);
  const flIn  = roundedRectLoop(topL, topW, cornerR, CORNER_SEG);
  const yFl = y0 + H;
  group.add(new THREE.Mesh(ringBetween(flIn, flOut, yFl), trayMat2));                    // flange top face
  group.add(new THREE.Mesh(loftLoops(flOut, yFl - flangeT, flOut, yFl), trayMat2));      // flange edge
  group.add(new THREE.Mesh(ringBetween(flIn, flOut, yFl - flangeT, true), trayMat2));    // flange underside

  const lipIn = roundedRectLoop(outerL - 2*lipT, outerW - 2*lipT, Math.max(outerR - lipT, 0.5), CORNER_SEG);
  const yLip = yFl + lipH;
  group.add(new THREE.Mesh(loftLoops(flOut, yFl, flOut, yLip), trayMat2));   // lip outer face
  group.add(new THREE.Mesh(loftLoops(lipIn, yFl, lipIn, yLip), trayMat2));   // lip inner face
  group.add(new THREE.Mesh(ringBetween(lipIn, flOut, yLip), trayMat2));      // lip crown

  /* ---- the cells as RECESSED TROUGHS with a CRADLE-CURVED bottom -------
   * Each cell is a real pocket: a U cross-section (straight sides down to a
   * cradleR arc) swept along the cell length, capped at both ends. The rim
   * land between pockets is the divider, drawn as the flat strip left over —
   * so the dividers are what remains between recesses rather than bars laid
   * on a flat pan.
   *
   * THE 2D GRID: `nCells` channels stack along Z, each its own uniform
   * cellWid/cellH/cradleR (never per-row — see cookietray.js's own doc: the
   * real Cookie-Tray grid keeps cell SIZE uniform and only varies pocket
   * COUNT per row). Each channel is split along X into `cols[row]` pockets
   * of `cellLen`, `colDivider` apart — a row with fewer pockets than the
   * widest row is centred within the tray's own length, matching
   * trayParams' own `topL` derivation exactly (same `cols`/`colDivider`
   * values, so the geometry and that derivation can never disagree about
   * how wide a row's own span is). */
  const rimY = y0 + H;                        // trough opening, shared by every pocket
  const floorY = rimY - cellH;                // uniform floor — one cellH for the whole tray
  const rowSpanMax = topL - 2*wall;           // = maxCols*cellLen + (maxCols-1)*colDivider
  const prof = troughProfile(cellWid, Math.max(cellH, 0.5), Math.min(cradleR, cellWid/2), TROUGH_SEG);
  const pockets = [];                         // {cx, cz, row, col} — every pocket, reused below
  for(let r = 0; r < nCells; r++){
    const cz = -topW/2 + wall + cellWid/2 + r*(cellWid + divider);
    const colsInRow = cols[r];
    const rowSpan = colsInRow*cellLen + (colsInRow - 1)*colDivider;
    const rowX0 = -rowSpanMax/2 + (rowSpanMax - rowSpan)/2;   // this row's own left edge, centred
    for(let c = 0; c < colsInRow; c++){
      const cx = rowX0 + cellLen/2 + c*(cellLen + colDivider);
      pockets.push({cx, cz, row: r, col: c});
      const halfL = cellLen/2;
      group.add(new THREE.Mesh(sweepProfileX(prof, cx - halfL, cx + halfL, cz, floorY), trayMat));
      group.add(new THREE.Mesh(capProfile(prof, cx - halfL, cz, floorY, false), trayMat));
      group.add(new THREE.Mesh(capProfile(prof, cx + halfL, cz, floorY, true),  trayMat));
    }
  }
  // the rim land: everything inside the rim that is NOT a pocket mouth
  group.add(new THREE.Mesh(rimLandGeo(topL, topW, nCells, cellWid, divider, wall,
                                      cols, cellLen, colDivider, rimY), trayMat2));

  /* ---- product sitting IN the cells ------------------------------------
   * The tray owns the cells; the COLLATION owns what sits in one of them, so
   * the piece run is replicated per pocket rather than re-derived here (the
   * SAME product fills every pocket in every row — one collation feeds the
   * whole grid). Pieces bear on the trough floor, which is why a tall
   * product visibly stands proud of the rim — the same fact the envelope's
   * max() encodes. */
  if(contents && contents.piece && contents.perCell > 0){
    const {geo, rot} = pieceGeo(contents.piece, contents.stackAxis);
    const stack = contents.stackAxis === 'Z';
    // Along-cell positions come from the COLLATION's own placements — the
    // list the caller already hands us — not from an even spread. The two
    // differ by endClearance/perCell per product: an even spread silently
    // distributes the end clearance BETWEEN every product, where physically
    // the products sit nose-to-tail (standing) or face-to-face (stack) and
    // the slack pools at the ends of the run/stack. Used EXACTLY (dropped
    // straight in, both the along-cell x AND the resting z — a stacked
    // piece's own z climbs per piece, never one constant "rise" applied to
    // all of them) only when there is a SINGLE pocket per row: with more
    // than one pocket the collation's one combined run has to be split into
    // that many shorter ones, which needs its own pitch-based placement —
    // an even spread within each pocket, not pixel-identical to what the
    // real Cookie-Tray app's own symmetric distribution would draw, but a
    // correct, non-overlapping, non-overflowing one.
    const pls = (contents.pieces && contents.pieces.length) ? contents.pieces : null;
    const per = pls ? pls.length : Math.max(1, Math.round(contents.perCell));
    const pitch = packPitchOf(contents.piece);
    const rise = pieceRise(contents.piece, contents.stackAxis);
    // `per` is that ROW's own total (every row gets the SAME collation, split
    // across that row's own pockets -- see the doc above), so the instance
    // count is per*nCells, NOT per*pockets.length: with more than one pocket
    // per row (nCols > 1) `pockets.length` over-counts by the pocket-per-row
    // factor, which over-allocated the InstancedMesh and left the surplus
    // instances with an uninitialized (identity) transform -- ghost product
    // rendered at the tray's local origin. Caught testing a real multi-pocket
    // Cookie-Tray link end to end (nCells=3, nCols=2): 9 real placements,
    // 18 allocated.
    const total = per*nCells;
    if(total > 0 && total <= 4000){
      const inst = new THREE.InstancedMesh(geo, productMat, total);
      const M = new THREE.Matrix4();
      let k = 0;
      for(const {cx, cz, row, col} of pockets){
        const colsInRow = cols[row];
        if(colsInRow === 1 && pls){
          for(let i = 0; i < per; i++){
            if(rot) M.copy(rot); else M.identity();
            M.setPosition(cx + pls[i].x, floorY + pls[i].z, cz);
            inst.setMatrixAt(k++, M);
          }
        }else{
          // this pocket's own share of the row's total count, split evenly
          // (see the doc above — not the real app's exact symmetric split)
          const perPocket = Math.ceil(per/colsInRow);
          const start = col*perPocket, count = Math.min(perPocket, per - start);
          for(let i = 0; i < count; i++){
            if(rot) M.copy(rot); else M.identity();
            if(stack) M.setPosition(cx, floorY + rise + i*pitch, cz);
            else      M.setPosition(cx + (i + 0.5)*pitch - count*pitch/2, floorY + rise, cz);
            inst.setMatrixAt(k++, M);
          }
        }
      }
      inst.count = k;   // exactly the matrices actually written -- see the `total` doc above
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
  }

  const outer = p.longAxis === 'Y'
    ? {L: outerW, W: outerL, H: overallH}
    : {L: outerL, W: outerW, H: overallH};
  if(p.longAxis === 'Y') group.rotation.y = Math.PI/2;

  return {group, span: Math.max(outer.L, outer.W, outer.H), outer};
}

/* ---------------- surface builders (no CSG, no fillets) ------------------
 * Everything below stitches explicit triangles. Corner ROUNDING is a real
 * arc in the outline; edge FILLETS (blends between two surfaces) genuinely
 * need a kernel and are deliberately skipped — the brief says so. */

const CORNER_SEG = 6;    // arc segments per rounded corner
const TROUGH_SEG = 10;   // arc segments across the cradle

/** A closed rounded-rectangle outline as [x, z] points, CCW seen from above. */
function roundedRectLoop(L, W, r, seg){
  const hx = L/2, hz = W/2;
  const rr = Math.max(0.01, Math.min(r, Math.min(hx, hz) - 0.01));
  const pts = [];
  // corner centres, in order: +x+z, -x+z, -x-z, +x-z
  const corners = [[hx - rr, hz - rr, 0], [-(hx - rr), hz - rr, Math.PI/2],
                   [-(hx - rr), -(hz - rr), Math.PI], [hx - rr, -(hz - rr), 1.5*Math.PI]];
  for(const [cx, cz, a0] of corners)
    for(let i = 0; i <= seg; i++){
      const a = a0 + (Math.PI/2)*(i/seg);
      pts.push([cx + rr*Math.cos(a), cz + rr*Math.sin(a)]);
    }
  return pts;
}

/** Side surface between two outlines at two heights (they must share length). */
function loftLoops(loopA, yA, loopB, yB){
  const n = Math.min(loopA.length, loopB.length);
  const pos = [], idx = [];
  for(let i = 0; i < n; i++){
    pos.push(loopA[i][0], yA, loopA[i][1]);
    pos.push(loopB[i][0], yB, loopB[i][1]);
  }
  for(let i = 0; i < n; i++){
    const a = 2*i, b = 2*i + 1, c = 2*((i + 1)%n), d = 2*((i + 1)%n) + 1;
    idx.push(a, b, d, a, d, c);
  }
  return finish(pos, idx);
}

/** Flat fan cap across one outline at height y. */
function capLoop(loop, y, up = true){
  const pos = [0, y, 0], idx = [];
  for(const [x, z] of loop) pos.push(x, y, z);
  const n = loop.length;
  for(let i = 0; i < n; i++){
    const a = 1 + i, b = 1 + (i + 1)%n;
    if(up) idx.push(0, a, b); else idx.push(0, b, a);
  }
  return finish(pos, idx);
}

/** Flat annulus between an inner and an outer outline at height y. */
function ringBetween(inner, outer, y, flip = false){
  const n = Math.min(inner.length, outer.length);
  const pos = [], idx = [];
  for(let i = 0; i < n; i++){
    pos.push(inner[i][0], y, inner[i][1]);
    pos.push(outer[i][0], y, outer[i][1]);
  }
  for(let i = 0; i < n; i++){
    const a = 2*i, b = 2*i + 1, c = 2*((i + 1)%n), d = 2*((i + 1)%n) + 1;
    if(flip) idx.push(a, d, b, a, c, d); else idx.push(a, b, d, a, d, c);
  }
  return finish(pos, idx);
}

/**
 * The U cross-section of one trough as [dz, dy] offsets from the cell centre
 * at the trough floor: straight sides rising from a cradleR arc. This is the
 * cradle — a curved bottom, not a flat pan.
 */
function troughProfile(cellWid, depth, cradleR, seg){
  const half = cellWid/2;
  const r = Math.max(0.01, Math.min(cradleR, half));
  const flat = half - r;                       // 0 when the cradle is a full half-round
  const pts = [];
  pts.push([-half, depth]);                    // rim, -W side
  if(depth > r + 1e-9) pts.push([-half, r]);   // straight wall down to where the arc starts
  // left corner arc: centre (-flat, r), sweeping pi -> pi/2 (down to the floor)
  for(let i = 0; i <= seg; i++){
    const a = Math.PI - (Math.PI/2)*(i/seg);
    pts.push([-flat + r*Math.cos(a), r - r*Math.sin(a)]);
  }
  // right corner arc: centre (+flat, r), sweeping pi/2 -> 0 (floor back up)
  for(let i = 1; i <= seg; i++){
    const a = (Math.PI/2)*(1 - i/seg);
    pts.push([flat + r*Math.cos(a), r - r*Math.sin(a)]);
  }
  if(depth > r + 1e-9) pts.push([half, r]);
  pts.push([half, depth]);                     // rim, +W side
  return pts;
}

/** Sweep a [dz, dy] profile along X between x0 and x1, centred at cz/base y. */
function sweepProfileX(prof, x0, x1, cz, y){
  const pos = [], idx = [];
  for(const [dz, dy] of prof){
    pos.push(x0, y + dy, cz + dz);
    pos.push(x1, y + dy, cz + dz);
  }
  for(let i = 0; i < prof.length - 1; i++){
    const a = 2*i, b = 2*i + 1, c = 2*i + 2, d = 2*i + 3;
    idx.push(a, b, d, a, d, c);
  }
  return finish(pos, idx);
}

/** Close one end of a trough with a flat U-shaped wall. */
function capProfile(prof, x, cz, y, flip){
  const pos = [], idx = [];
  const top = prof[0][1];
  for(const [dz, dy] of prof){
    pos.push(x, y + dy, cz + dz);      // profile point
    pos.push(x, y + top, cz + dz);     // straight up to the rim
  }
  for(let i = 0; i < prof.length - 1; i++){
    const a = 2*i, b = 2*i + 1, c = 2*i + 2, d = 2*i + 3;
    if(flip) idx.push(a, d, b, a, c, d); else idx.push(a, b, d, a, d, c);
  }
  return finish(pos, idx);
}

/**
 * The flat land at rim height INSIDE the tray: the region between the rim
 * outline and the pocket mouths. Drawn as strips around each pocket, so the
 * dividers appear as the material left between recesses rather than as bars
 * sitting on a flat pan.
 *
 * THE 2D GRID: `nCells` rows stack along Z at the UNIFORM `cellWid` (never
 * per row — cell size is the same everywhere, only pocket COUNT varies —
 * see cookietray.js). Within a row the land follows THAT row's own pocket
 * count (`cols[row]`), centred within the tray's own length exactly as
 * buildTray3d's own pocket walk centres it (same `rowSpanMax` derivation),
 * so the land and the troughs can never disagree about where a pocket
 * mouth is; the bands BETWEEN two rows, and above/below the first and last
 * row, span the full topL.
 */
function rimLandGeo(topL, topW, nCells, cellWid, divider, wall, cols, cellLen, colDivider, y){
  const parts = [];
  const hx = topL/2, hz = topW/2;
  const add = (x0, x1, z0, z1) => {
    if(x1 - x0 <= 1e-6 || z1 - z0 <= 1e-6) return;
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    g.rotateX(-Math.PI/2);
    g.translate((x0 + x1)/2, y, (z0 + z1)/2);
    parts.push(g);
  };
  const rowSpanMax = topL - 2*wall;
  let prevEdge = -hz;                        // z of the land/pocket boundary walked so far
  for(let r = 0; r < nCells; r++){
    const z0 = -hz + wall + r*(cellWid + divider);
    const z1 = z0 + cellWid;
    const colsInRow = cols[r];
    const rowSpan = colsInRow*cellLen + (colsInRow - 1)*colDivider;
    const rowX0 = -rowSpanMax/2 + (rowSpanMax - rowSpan)/2;
    const cellX = c => rowX0 + c*(cellLen + colDivider);
    // the band above this row (outer wall, or the divider since the last row)
    add(-hx, hx, prevEdge, z0);
    // this row's own end lands (beyond its pockets, centring a shorter row)
    // + its internal pocket-to-pocket dividers
    add(-hx, rowX0, z0, z1);
    add(rowX0 + rowSpan, hx, z0, z1);
    for(let c = 0; c < colsInRow - 1; c++)
      add(cellX(c) + cellLen, cellX(c + 1), z0, z1);
    prevEdge = z1;
  }
  add(-hx, hx, prevEdge, hz);                // the band below the last row
  return parts.length ? mergeGeos(parts) : new THREE.BufferGeometry();
}

/** positions + indices -> a normalled BufferGeometry. */
function finish(pos, idx){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
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
