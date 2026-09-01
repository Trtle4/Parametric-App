/**
 * Dimension callouts overlay. Projects the active component's OUTER bounding
 * box (centred on the world origin — the convention every 3D view shares:
 * x = L, y = H, z = W) and emits SVG dimension lines, one per axis.
 *
 * Each dimension line is offset OUTBOARD of the box in 3D (not just in screen
 * space) so it always stands clear of the load/pallet mesh: the offset runs
 * along the edge's perpendicular-outward direction, scaled to the box size, so
 * the callout clears the geometry from every orbit angle. Thin extension
 * leaders run from the measured points (after a small gap) out to the
 * dimension line; arrowheads terminate exactly at the extents; a monospaced
 * number sits just beyond.
 *
 * At pallet level the single height is split into three stacked dimensions —
 * Pallet (deck), Load (stack), Total (floor to top) — see splitHeight; the
 * caller passes them via `labels.heights`. Pure given the box, labels, camera
 * and canvas size; app.js redraws every frame so the callouts track the orbit.
 * Uses the global THREE (classic script tag), like the other render modules.
 */

/** Split a pallet's total height into its three reported dimensions. Pure and
 *  THREE-free so it can be unit-tested: Total is always Pallet + Load. */
export function splitHeight(totalH, palletH){
  return {pallet: palletH, load: totalH - palletH, total: totalH};
}

/** Project a world point to screen pixels. `behind` guards points at/through
 *  the camera plane, where the projection is meaningless. */
function project(v, cam, w, h){
  const p = v.clone().project(cam);
  return {x: (p.x*0.5 + 0.5)*w, y: (-p.y*0.5 + 0.5)*h, z: p.z, behind: p.z <= -1 || p.z >= 1};
}

/** Filled arrowhead path pointing toward `tip`, coming from `from` (px). */
function arrowHead(tip, from, size){
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx/len, uy = dy/len;          // unit vector, toward tip
  const px = -uy, py = ux;                  // perpendicular
  const wd = size*0.42;
  const bx = tip.x - ux*size, by = tip.y - uy*size;
  return `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} `
       + `L${(bx + px*wd).toFixed(1)} ${(by + py*wd).toFixed(1)} `
       + `L${(bx - px*wd).toFixed(1)} ${(by - py*wd).toFixed(1)} Z`;
}

/** One linear dimension in 3D: measured points a3,b3, pushed out by out3*off.
 *  Extension leaders run from each point (after `gap`) to the dimension line;
 *  arrowheads terminate at the extents; the label sits `labelOff` further out. */
function linearDim(a3, b3, out3, off, gap, labelOff, label, cam, w, h){
  const A = a3.clone().addScaledVector(out3, off);
  const B = b3.clone().addScaledVector(out3, off);
  const pA = project(A, cam, w, h), pB = project(B, cam, w, h);
  if(pA.behind || pB.behind) return '';
  const pEA = project(a3.clone().addScaledVector(out3, gap), cam, w, h);
  const pEB = project(b3.clone().addScaledVector(out3, gap), cam, w, h);
  const pM  = project(a3.clone().add(b3).multiplyScalar(0.5).addScaledVector(out3, labelOff), cam, w, h);
  const HEAD = 9;
  return `<line class="dx-ext" x1="${pEA.x.toFixed(1)}" y1="${pEA.y.toFixed(1)}" x2="${pA.x.toFixed(1)}" y2="${pA.y.toFixed(1)}"/>`
    + `<line class="dx-ext" x1="${pEB.x.toFixed(1)}" y1="${pEB.y.toFixed(1)}" x2="${pB.x.toFixed(1)}" y2="${pB.y.toFixed(1)}"/>`
    + `<line class="dx-line" x1="${pA.x.toFixed(1)}" y1="${pA.y.toFixed(1)}" x2="${pB.x.toFixed(1)}" y2="${pB.y.toFixed(1)}"/>`
    + `<path class="dx-head" d="${arrowHead(pA, pB, HEAD)}"/>`
    + `<path class="dx-head" d="${arrowHead(pB, pA, HEAD)}"/>`
    + `<text class="dx-txt" x="${pM.x.toFixed(1)}" y="${pM.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${label}</text>`;
}

// perpendicular-outward unit vector for an edge of a box centred on the origin
function outwardOf(a, b){
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  const par = dir.clone().multiplyScalar(mid.dot(dir));   // component along the edge
  const out = mid.sub(par);
  return out.lengthSq() > 1e-9 ? out.normalize() : new THREE.Vector3(0, -1, 0);
}

/**
 * SVG markup for the callouts on `box` (a THREE.Box3, world). `labels` gives
 * `{L, W, H}` strings; for a pallet pass `{L, W, heights:{palletMM, pallet,
 * load, total}}` to split the height into three stacked dimensions instead.
 */
export function dimsSVG(box, labels, cam, w, h){
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const off = maxDim*0.13, gap = maxDim*0.035, labelOff = off + maxDim*0.07;

  const cor = (sx, sy, sz) => new THREE.Vector3(
    sx < 0 ? box.min.x : box.max.x,
    sy < 0 ? box.min.y : box.max.y,
    sz < 0 ? box.min.z : box.max.z);
  const midScreenY = (a, b) => (project(a, cam, w, h).y + project(b, cam, w, h).y)/2;
  const midScreenX = (a, b) => (project(a, cam, w, h).x + project(b, cam, w, h).x)/2;

  const xEdges = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([sy,sz]) => [cor(-1,sy,sz), cor(1,sy,sz)]);
  const zEdges = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([sx,sy]) => [cor(sx,sy,-1), cor(sx,sy,1)]);
  const yEdges = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([sx,sz]) => [cor(sx,-1,sz), cor(sx,1,sz)]);

  // L and W ride the front-bottom edges (lowest on screen), so their callouts
  // sit below the load. H rides the SIDE vertical edge furthest out on screen
  // (not the near edge, which sits mid-silhouette): offsetting that edge
  // outward puts the whole height chain clear beside the object, never over it.
  const lowest  = es => es.reduce((m, e) => midScreenY(e[0], e[1]) > midScreenY(m[0], m[1]) ? e : m);
  // pick the vertical edge whose projected midpoint is furthest from the centre
  // of all four vertical edges — i.e. the outermost silhouette side edge
  const yMidsX = yEdges.map(e => midScreenX(e[0], e[1]));
  const yCentreX = yMidsX.reduce((a, b) => a + b, 0) / yMidsX.length;
  const sidemost = es => es.reduce((m, e) => Math.abs(midScreenX(e[0], e[1]) - yCentreX) > Math.abs(midScreenX(m[0], m[1]) - yCentreX) ? e : m);

  const eL = lowest(xEdges), eW = lowest(zEdges), eH = sidemost(yEdges);
  let svg = linearDim(eL[0], eL[1], outwardOf(eL[0], eL[1]), off, gap, labelOff, labels.L, cam, w, h)
          + linearDim(eW[0], eW[1], outwardOf(eW[0], eW[1]), off, gap, labelOff, labels.W, cam, w, h);

  if(labels.heights){
    // stacked vertical dimensions on the near edge: Pallet (deck) + Load (stack)
    // chained on one offset line, Total on a second line further out.
    const out = outwardOf(eH[0], eH[1]);
    const B = eH[0], T = eH[1];                       // yEdges: [0] = bottom, [1] = top
    const S = B.clone(); S.y = box.min.y + labels.heights.palletMM;
    const off2 = off + maxDim*0.13, labelOff2 = off2 + maxDim*0.07;
    svg += linearDim(B, S, out, off,  gap, labelOff,  labels.heights.pallet, cam, w, h)
         + linearDim(S, T, out, off,  gap, labelOff,  labels.heights.load,   cam, w, h)
         + linearDim(B, T, out, off2, gap, labelOff2, labels.heights.total,  cam, w, h);
  }else{
    svg += linearDim(eH[0], eH[1], outwardOf(eH[0], eH[1]), off, gap, labelOff, labels.H, cam, w, h);
  }
  return svg;
}
