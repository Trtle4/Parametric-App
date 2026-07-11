/**
 * 3D fold construction for the ECMA A6120 reverse tuck end.
 *
 * The dust flaps reuse the flat flap-hinge model (phase 0, fold first).
 * The tuck closure needs something the RSC never did: a NESTED hinge —
 * the tuck panel rotates -90° over the opening, and the tuck tab is a
 * child group with its own -90° hinge at the panel's far edge, so the two
 * rotations compose and the tab ends up vertical, tucked inside the far
 * wall. Both share phase 1 and animate together. applyFold() needed no
 * changes: it walks the flap list and nested groups compose naturally.
 */
export function a6120Fold(geo, printText, options, ctx){
  const {t, kraft, kraft2, makeFlap, makeTextMaterial} = ctx;
  const {L, W, H} = geo.inner;
  const T = geo.meta.tuckDepth, TT = geo.meta.tuckTab, D = geo.meta.dustDepth;
  const parts = [], flaps = [];

  // 4 walls (base at y=0); front wall (+z) carries the print texture
  const textMat = makeTextMaterial(L, H, false, printText);
  const frontMats = [kraft, kraft, kraft, kraft, textMat, kraft];
  const walls = [
    [new THREE.BoxGeometry(L, H, t), [0, H/2,  W/2], frontMats], // front
    [new THREE.BoxGeometry(L, H, t), [0, H/2, -W/2], kraft],     // back
    [new THREE.BoxGeometry(t, H, W), [ L/2, H/2, 0], kraft],     // right side
    [new THREE.BoxGeometry(t, H, W), [-L/2, H/2, 0], kraft],     // left side
  ];
  walls.forEach(([g, pos, mat]) => {const m = new THREE.Mesh(g, mat); m.position.set(...pos); parts.push(m);});

  // dust flaps on the side walls, top and bottom — fold first (phase 0)
  const gD = new THREE.BoxGeometry(t, D, W);
  flaps.push(makeFlap([ L/2, H, 0], 'z',  Math.PI/2, [0,  D/2, 0], gD, kraft2, 0));
  flaps.push(makeFlap([-L/2, H, 0], 'z', -Math.PI/2, [0,  D/2, 0], gD, kraft2, 0));
  flaps.push(makeFlap([ L/2, 0, 0], 'z', -Math.PI/2, [0, -D/2, 0], gD, kraft2, 0));
  flaps.push(makeFlap([-L/2, 0, 0], 'z',  Math.PI/2, [0, -D/2, 0], gD, kraft2, 0));

  // tuck panel + nested tab (phase 1). Top closure hinges on the FRONT
  // panel; bottom on the BACK panel (the reverse-tuck signature).
  const mkTuck = (hingeY, hingeZ, sign) => {
    // sign: +1 = extends up from the top crease, -1 = down from the bottom
    const panel = makeFlap([0, hingeY, hingeZ], 'x', -Math.PI/2, [0, sign*T/2, 0],
                           new THREE.BoxGeometry(L, T, t), kraft, 1);
    const tab = new THREE.Group();
    tab.position.set(0, sign*T, 0);                       // hinge at the panel's far edge
    const tabMesh = new THREE.Mesh(new THREE.BoxGeometry(L, TT, t), kraft2);
    tabMesh.position.set(0, sign*TT/2, 0);
    tab.add(tabMesh);
    tab.userData = {axis: 'x', closedAngle: -Math.PI/2, phase: 1};
    panel.add(tab);                                       // nested hinge
    flaps.push(panel, tab);
  };
  mkTuck(H,  W/2, +1);   // top tuck on the front panel
  mkTuck(0, -W/2, -1);   // bottom tuck on the back panel

  // closed-state extras: the tuck panel's free edge is visible on the top
  // face near the far (back) wall, mirrored on the bottom near the front
  const closedExtras = [];
  const seamGeo = new THREE.BoxGeometry(L*0.9, t*0.35, Math.max(t*0.6, 1));
  const inset = Math.max(t, 1)*1.5;
  [[H + t/2, -(W/2) + inset], [-t/2, (W/2) - inset]].forEach(([y, z]) => {
    const s = new THREE.Mesh(seamGeo, kraft2);
    s.position.set(0, y, z); closedExtras.push(s);
  });

  return {parts, flaps, closedExtras};
}
