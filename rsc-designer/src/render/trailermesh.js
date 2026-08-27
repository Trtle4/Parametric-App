/**
 * The trailer SHELL — floor, translucent walls/ceiling, and a highlighted
 * door opening at the rear. RENDER ONLY, same idiom as palletmesh.js: the
 * fit math (core/trailer.js) never reads anything from here, and this file
 * never re-derives a fit number.
 *
 * Convention: +X is the NOSE (front, farthest from the door), -X is the
 * REAR (the door end) — loading proceeds from -X toward +X. Matches
 * hierarchy3d.js's own "front-left bottom" default-selected load: the
 * floor position with the smallest X (closest to the door is normally
 * where a forklift starts, but the FRONT of the load — the first one set,
 * deepest in — is the natural "reference" unit a loader would check first;
 * see buildTrailer's own comment for the exact tie-break).
 *
 * Uses the global THREE (classic script tag), like palletmesh.js. All
 * lengths in mm.
 */

// depthWrite:false -- the shell is 4 large, overlapping DoubleSide transparent
// boxes (nose/2 sides/ceiling) sharing edges at every corner. With depth
// writes on, whichever overlapping face rasterizes first at a pixel blocks
// the other from blending there at all, and WHICH one wins can flip as the
// camera moves a hair -- a classic three.js transparent-sort flicker. None of
// these boxes need to occlude each other (they're one translucent cage, not
// solid geometry), so turning off depth writes costs nothing and removes the
// flicker source outright; opaque contents behind them are unaffected since
// those are depth-tested normally in the opaque pass before this ever draws.
const wall = new THREE.MeshStandardMaterial({color: 0xBFC7CE, roughness: 0.6, metalness: 0.1, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false});
const floorMat = new THREE.MeshStandardMaterial({color: 0x8A8F94, roughness: 0.85, metalness: 0.05});
const doorOutline = new THREE.LineBasicMaterial({color: 0xE0A030, linewidth: 2});

/**
 * @param {number} L  interior length, mm (nose-to-door, the X axis)
 * @param {number} W  interior width, mm (the Z axis)
 * @param {number} H  interior height, mm (the Y axis)
 * @param {number} doorH  door opening height, mm — highlighted separately
 *        from the interior height so a stack that clears one and not the
 *        other reads as visually distinct, matching the two-verdict fit report
 * @param {number} doorW  door opening width, mm
 * @returns {THREE.Group} floor at y=0 (matching the load's own floor plane),
 *          centred on X=0/Z=0, spanning y=[0,H]
 */
export function buildTrailerShell(L, W, H, doorH, doorW){
  const g = new THREE.Group();
  g.name = 'trailerShell';

  const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 20, W), floorMat);
  floor.position.set(0, -10, 0);
  g.add(floor);

  const t = 4;   // wall/ceiling render thickness — cosmetic only, never a clearance
  const walls = [
    {size: [t, H, W], pos: [ L/2 - t/2, H/2, 0]},          // nose (+X, opaque-ish nose wall)
    {size: [L, H, t], pos: [0, H/2,  W/2 - t/2]},           // side
    {size: [L, H, t], pos: [0, H/2, -W/2 + t/2]},           // side
    {size: [L, t, W], pos: [0, H - t/2, 0]}                 // ceiling
  ];
  for(const wdef of walls){
    const m = new THREE.Mesh(new THREE.BoxGeometry(...wdef.size), wall);
    m.position.set(...wdef.pos);
    g.add(m);
  }

  // DOOR OPENING at the rear (-X face) — an outline at its own real size,
  // separate from the (possibly taller) interior wall it sits in, so a load
  // that clears the interior but not the door reads visually distinct.
  const hx = -L/2;
  const doorPts = [
    new THREE.Vector3(hx, 0, -doorW/2), new THREE.Vector3(hx, doorH, -doorW/2),
    new THREE.Vector3(hx, doorH, doorW/2), new THREE.Vector3(hx, 0, doorW/2),
    new THREE.Vector3(hx, 0, -doorW/2)
  ];
  const doorLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(doorPts), doorOutline);
  doorLine.name = 'doorOutline';
  g.add(doorLine);

  return g;
}
