/**
 * U-board interlayer — the 3D VISUAL: base + two flap panels folded up at
 * 90°, real caliper thickness. Mirrors tray3d.js's own paperboard tint (the
 * closest sibling: a folded interlayer part, not a scored/creased rigid
 * dieline fold like the carton/case builders) rather than inventing a new
 * material.
 *
 * Sibling to core/uboard.js: that module owns the Geometry-contract flat
 * blank (drawn by the existing draw2d() with no changes there); this file
 * is purely the folded solid, for the standalone U-board 3D view and for
 * the main assembly between product and wrap.
 *
 * Uses the global THREE (classic script tag). All lengths mm. Local frame
 * matches hierarchy3d.js's canonical x=L, y=H (up), z=W convention — so the
 * group drops into the assembly with no extra rotation: x = the flow axis
 * (the blank's unfolded length), z = the across axis (the base panel
 * width). Base UNDERSIDE sits at y = -outer.H/2, matching how every other
 * depth centres its subject for the Dims overlay.
 */
const uboardMat = new THREE.MeshStandardMaterial({
  color: 0xD8D2C4, roughness: 0.55, metalness: 0, side: THREE.DoubleSide
});

/**
 * @param {{L:number,W:number,H:number}} content  the collation envelope the
 *   U-board wraps — its base panel spans content.W (the across axis)
 * @param {{caliper:number, f:number}} params  core/uboard.js's uboardParams() result
 * @returns {{group: THREE.Group, span: number, outer: {L:number,W:number,H:number}}}
 */
export function buildUboard3d(content, params){
  const {caliper: t, f} = params;
  const flow = content.L;      // flow-axis run, unchanged by the U-board
  const across = content.W;    // base panel width, unfolded
  const outer = {L: flow, W: across + 2*t, H: t + Math.max(content.H, f)};

  const group = new THREE.Group();
  const y0 = -outer.H/2;              // base UNDERSIDE
  const baseTopY = y0 + t;            // base TOP — where the collation bears, and where the flaps hinge

  const base = new THREE.Mesh(new THREE.BoxGeometry(flow, t, across), uboardMat);
  base.position.set(0, y0 + t/2, 0);
  group.add(base);

  // two flap panels, folded up 90° at each long edge: they rise from the
  // base's top face at its outer z-edges, thickness t, standing height f.
  [-1, 1].forEach(side => {
    const flap = new THREE.Mesh(new THREE.BoxGeometry(flow, f, t), uboardMat);
    flap.position.set(0, baseTopY + f/2, side*(across/2 + t/2));
    group.add(flap);
  });

  return {group, span: Math.max(outer.L, outer.W, outer.H), outer};
}
