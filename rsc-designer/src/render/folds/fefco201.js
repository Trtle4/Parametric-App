/**
 * 3D fold construction for the FEFCO 201 RSC: four walls + eight hinged
 * flaps, two-phase fold (inner pair first). Moved verbatim from the old
 * fold3d.buildBox; behaviour is unchanged.
 */
export function fefco201Fold(geo, printText, options, ctx){
  const {t, kraft, kraft2, makeFlap, makeTextMaterial} = ctx;
  const {L, W, H} = geo.inner;
  const F = geo.meta.flapDepth;
  const parts = [], flaps = [];

  // 4 walls (base at y=0); front wall carries the print-text texture on its +z face
  const textMat = makeTextMaterial(L, H, false, printText);
  const frontMats = [kraft, kraft, kraft, kraft, textMat, kraft]; // +x,-x,+y,-y,+z,-z
  const walls = [
    [new THREE.BoxGeometry(L, H, t), [0, H/2,  W/2], frontMats], // front (length wall)
    [new THREE.BoxGeometry(L, H, t), [0, H/2, -W/2], kraft],     // back
    [new THREE.BoxGeometry(t, H, W), [ L/2, H/2, 0], kraft],     // right (width wall)
    [new THREE.BoxGeometry(t, H, W), [-L/2, H/2, 0], kraft],     // left
  ];
  walls.forEach(([g, pos, mat]) => {const m = new THREE.Mesh(g, mat); m.position.set(...pos); parts.push(m);});

  const gW = new THREE.BoxGeometry(t, F, W), gL = new THREE.BoxGeometry(L, F, t); // W-wall / L-wall flap blanks
  const off = t*0.55; // stagger: inner flaps sit one board thickness toward the box interior

  // role assignment: which pair folds on the outside (standard RSC = length panels)
  const wInner = options.outerFlaps !== 'W';         // width-wall flaps are the inner (minor) pair
  const yWb = wInner ? off : 0,   yWt = wInner ? H - off : H; // width-flap hinge heights (bottom/top)
  const yLb = wInner ? 0 : off,   yLt = wInner ? H : H - off; // length-flap hinge heights
  const wMat = wInner ? kraft2 : kraft, lMat = wInner ? kraft : kraft2;
  const wPh  = wInner ? 0 : 1,          lPh  = wInner ? 1 : 0;

  // width-wall flaps
  flaps.push(makeFlap([ L/2, yWb, 0], 'z', -Math.PI/2, [0, -F/2, 0], gW, wMat, wPh));
  flaps.push(makeFlap([-L/2, yWb, 0], 'z',  Math.PI/2, [0, -F/2, 0], gW, wMat, wPh));
  flaps.push(makeFlap([ L/2, yWt, 0], 'z',  Math.PI/2, [0,  F/2, 0], gW, wMat, wPh));
  flaps.push(makeFlap([-L/2, yWt, 0], 'z', -Math.PI/2, [0,  F/2, 0], gW, wMat, wPh));
  // length-wall flaps
  flaps.push(makeFlap([0, yLb,  W/2], 'x',  Math.PI/2, [0, -F/2, 0], gL, lMat, lPh));
  flaps.push(makeFlap([0, yLb, -W/2], 'x', -Math.PI/2, [0, -F/2, 0], gL, lMat, lPh));
  flaps.push(makeFlap([0, yLt,  W/2], 'x', -Math.PI/2, [0,  F/2, 0], gL, lMat, lPh));
  flaps.push(makeFlap([0, yLt, -W/2], 'x',  Math.PI/2, [0,  F/2, 0], gL, lMat, lPh));

  // closed-state extras: outer-flap seam lines on top & bottom
  const closedExtras = [];
  const seamW = Math.max(t*0.6, 1), seamT = t*0.35;
  const seamGeo = wInner ? new THREE.BoxGeometry(L*0.9, seamT, seamW)   // L-flaps outer: seam runs along length
                         : new THREE.BoxGeometry(seamW, seamT, W*0.9);  // W-flaps outer: seam runs along width
  [H + t/2, -t/2].forEach(y => {
    const s = new THREE.Mesh(seamGeo, kraft2);
    s.position.set(0, y, 0); closedExtras.push(s);
  });

  return {parts, flaps, closedExtras};
}
