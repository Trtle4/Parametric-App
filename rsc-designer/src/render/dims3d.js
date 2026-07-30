/**
 * Dimension callouts overlay. Projects the active component's OUTER bounding
 * box (centred on the world origin — the convention every 3D view shares:
 * x = L, y = H, z = W) to screen space and emits SVG for three dimension
 * lines, one per axis: thin extension leaders, arrowheads, and a DM Mono
 * number. Pure given the box, camera, and canvas size — app.js decides which
 * box/labels to show and redraws every frame so the callouts track the
 * orbiting camera. Uses the global THREE (classic script tag), like the other
 * render modules.
 */

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
  const w = size*0.42;
  const bx = tip.x - ux*size, by = tip.y - uy*size;
  return `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} `
       + `L${(bx + px*w).toFixed(1)} ${(by + py*w).toFixed(1)} `
       + `L${(bx - px*w).toFixed(1)} ${(by - py*w).toFixed(1)} Z`;
}

/** One dimension callout: a dim line offset OUTWARD from the box centroid,
 *  extension leaders back to the two corners, an arrowhead at each end, and
 *  the number floated just beyond the line. */
function callout(a, b, cc, label){
  if(a.behind || b.behind) return '';
  const OFF = 34, GAP = 7, TXT = 15, HEAD = 9;
  const mid = {x: (a.x + b.x)/2, y: (a.y + b.y)/2};
  let ox = mid.x - cc.x, oy = mid.y - cc.y;
  const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;   // outward unit (screen space)
  const off = p => ({x: p.x + ox*OFF, y: p.y + oy*OFF});
  const da = off(a), db = off(b), dm = off(mid);
  const ext = (p, dp) =>
    `<line class="dx-ext" x1="${(p.x + ox*GAP).toFixed(1)}" y1="${(p.y + oy*GAP).toFixed(1)}" `
    + `x2="${dp.x.toFixed(1)}" y2="${dp.y.toFixed(1)}"/>`;
  return ext(a, da) + ext(b, db)
    + `<line class="dx-line" x1="${da.x.toFixed(1)}" y1="${da.y.toFixed(1)}" x2="${db.x.toFixed(1)}" y2="${db.y.toFixed(1)}"/>`
    + `<path class="dx-head" d="${arrowHead(da, db, HEAD)}"/>`
    + `<path class="dx-head" d="${arrowHead(db, da, HEAD)}"/>`
    + `<text class="dx-txt" x="${(dm.x + ox*TXT).toFixed(1)}" y="${(dm.y + oy*TXT).toFixed(1)}" `
    + `text-anchor="middle" dominant-baseline="central">${label}</text>`;
}

/**
 * SVG markup for the three L/W/H callouts on `box` (a THREE.Box3, world).
 * @param {THREE.Box3} box   subject outer bounds (centred on origin)
 * @param {{L:string,W:string,H:string}} labels  formatted numbers per axis
 * @param {THREE.Camera} cam
 * @param {number} w  canvas width (css px)
 * @param {number} h  canvas height (css px)
 */
export function dimsSVG(box, labels, cam, w, h){
  const P = {};
  for(const sx of [-1, 1]) for(const sy of [-1, 1]) for(const sz of [-1, 1]){
    const v = new THREE.Vector3(sx < 0 ? box.min.x : box.max.x,
                                sy < 0 ? box.min.y : box.max.y,
                                sz < 0 ? box.min.z : box.max.z);
    P[`${sx}${sy}${sz}`] = project(v, cam, w, h);
  }
  const cor = (sx, sy, sz) => P[`${sx}${sy}${sz}`];
  const cc = project(box.getCenter(new THREE.Vector3()), cam, w, h);

  // the four edges parallel to each axis (the other two signs vary)
  const xEdges = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([sy,sz]) => ({a: cor(-1,sy,sz), b: cor(1,sy,sz)}));
  const zEdges = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([sx,sy]) => ({a: cor(sx,sy,-1), b: cor(sx,sy,1)}));
  const yEdges = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([sx,sz]) => ({a: cor(sx,-1,sz), b: cor(sx,1,sz)}));

  // L (x) and W (z) ride the front-bottom edges (lowest on screen); H (y) rides
  // the vertical edge nearest the camera — the readable near corner, matching
  // how a drafter dimensions a three-quarter view.
  const lowest  = es => es.reduce((m, e) => (e.a.y + e.b.y) > (m.a.y + m.b.y) ? e : m);
  const nearest = es => es.reduce((m, e) => (e.a.z + e.b.z) < (m.a.z + m.b.z) ? e : m);
  const eL = lowest(xEdges), eW = lowest(zEdges), eH = nearest(yEdges);

  return callout(eL.a, eL.b, cc, labels.L)
       + callout(eW.a, eW.b, cc, labels.W)
       + callout(eH.a, eH.b, cc, labels.H);
}
