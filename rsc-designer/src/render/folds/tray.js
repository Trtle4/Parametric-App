/**
 * 3D fold for the FEFCO 0300 die-cut tray (OPEN structure — no closed shell).
 *
 * Base flat at y=0 (L along x, W along z); the four walls fold UP 90° about
 * their base edges (phase 0). The FRONT and BACK walls (length L) each carry a
 * corner tab at both ends; each tab is a NESTED hinge that, once its wall is
 * vertical, folds IN 90° about the wall's now-vertical edge to lie against the
 * inside of the adjacent LEFT/RIGHT side wall (phase 1) — exactly the reference
 * assembly. The side walls are plain, no tabs. openStructure:true tells
 * fold3d to keep these erected panels as the final form (no rounded-shell swap).
 */
export function trayFold(geo, printText, options, ctx){
  const {t, kraft, kraft2, makeFlap, makeTextMaterial} = ctx;
  const {L, W, H} = geo.inner;
  const tw = Math.max(1, H - (geo.meta.cornerGap || 0)/2);   // tab width = H - gap/2 (matches the dieline)
  const parts = [], flaps = [];

  // base sheet, top face at y=0; the visible outer (bottom) face carries print
  const baseMat = makeTextMaterial(L, W, false, printText);
  const base = new THREE.Mesh(new THREE.BoxGeometry(L, t, W), [kraft, kraft, baseMat, kraft, kraft, kraft]);
  base.position.set(0, -t/2, 0);
  parts.push(base);

  // a corner tab nested on a wall flap: hinge along the wall's +/-x vertical
  // edge, folding about the wall-local z (which maps to world-vertical once the
  // wall stands). sx = +1 (+x end) or -1 (-x end); sz is the wall's outward
  // z-sign (+1 front / -1 back) so the tab sits ON the wall (local z = sz·H/2,
  // matching the wall mesh's own openOffset), not below the base; the fold
  // sign swings it in against the adjacent side wall.
  const addTab = (wallGrp, sx, foldSign, sz) => {
    const tab = new THREE.Group();
    tab.position.set(sx*L/2, 0, sz*H/2);              // wall +/-x edge, on the wall (local)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(tw, t, H), kraft2);
    mesh.position.set(sx*tw/2, 0, 0);                 // extends outward from the edge when open
    tab.add(mesh);
    tab.userData = {axis: 'z', closedAngle: foldSign*Math.PI/2, phase: 1};
    wallGrp.add(tab);                                 // nested under the wall
    flaps.push(tab);
  };

  // FRONT wall (+z edge): stands up rotating -90° about x
  const front = makeFlap([0, 0,  W/2], 'x', -Math.PI/2, [0, 0,  H/2], new THREE.BoxGeometry(L, t, H), kraft, 0);
  addTab(front,  1,  1,  1);   // +x tab folds in against the +x side wall
  addTab(front, -1, -1,  1);   // -x tab
  flaps.push(front);

  // BACK wall (-z edge): stands up rotating +90° about x
  const back = makeFlap([0, 0, -W/2], 'x',  Math.PI/2, [0, 0, -H/2], new THREE.BoxGeometry(L, t, H), kraft, 0);
  addTab(back,  1,  1, -1);
  addTab(back, -1, -1, -1);
  flaps.push(back);

  // LEFT / RIGHT side walls (±x edges): plain, no tabs
  flaps.push(makeFlap([ L/2, 0, 0], 'z',  Math.PI/2, [ H/2, 0, 0], new THREE.BoxGeometry(H, t, W), kraft, 0));
  flaps.push(makeFlap([-L/2, 0, 0], 'z', -Math.PI/2, [-H/2, 0, 0], new THREE.BoxGeometry(H, t, W), kraft, 0));

  return {parts, flaps, openStructure: true};
}
