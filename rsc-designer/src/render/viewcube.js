/**
 * ViewCube — a live 3D orientation cube in the corner of the 3D stage,
 * OnShape/Fusion style. View-only: it reads the main camera's orbit angles
 * every frame and writes back only through fold3d.js's own tweenOrbit() —
 * it never touches the project, a style, or any packaging geometry.
 *
 * Prompt 23 reset this file against one spec after four separate patch
 * rounds drifted from OnShape's restraint. Deliberate choices this reset
 * made, so a future patch doesn't re-litigate them:
 *   - Face labels are the plain face name only (FRONT/BACK/TOP/BOTTOM/
 *     LEFT/RIGHT) — no parenthetical dimension letters. Those belong on
 *     the triad, not the faces.
 *   - Face label font size is chosen by MEASURING the text against the
 *     texture width and shrinking until it fits (labelTexture below) —
 *     never a fixed size guessed in advance. A fixed guess is exactly
 *     what truncated "X (L)" down to "(L" last round: the string got
 *     longer at the same time the guessed font got bigger.
 *   - Edges and corners are ONE uniform tier (a single darker-than-face
 *     tone), not two. No outline mesh, no third colour — the tint alone
 *     is the affordance.
 *   - The axis triad is a small gnomon anchored AT the cube's own
 *     front-lower-left corner, its three arms lying along that corner's
 *     three incident cube edges (short, inward, not floating outward on
 *     a diagonal). Single-letter labels only (X/Y/Z).
 *
 * A SEPARATE THREE.Scene + OrthographicCamera + WebGLRenderer, in their own
 * small canvas, laid over a corner of the main stage. It has no orientation
 * of its own: every frame it is rebuilt from getOrbit()'s rotX/rotY, so it
 * is provably a mirror, never a second source of camera truth.
 *
 * Face labels are in the PACK's own frame, matching the render convention
 * already established throughout hierarchy3d.js/fold3d.js (the print decal
 * sits at +Z, the case's open top is +Y): +Z FRONT, -Z BACK, +Y TOP,
 * -Y BOTTOM, +X RIGHT, -X LEFT. TOP is the closure; BOTTOM is where the fin
 * sits (Prompt 20, Part A) — clicking BOTTOM is the one-click check that
 * Part A landed correctly.
 *
 * The 26 clickable regions (6 faces, 12 edges, 8 corners) are each defined
 * by a direction vector whose components are each in {-1,0,1} (never all
 * zero). The same vector gives the region's target camera angles directly:
 * rotX = asin(dy/|d|), rotY = atan2(dx,dz) — this is exactly fold3d.js's
 * own orbit formula solved for direction, so the 12 edges and 8 corners
 * fall out of ONE formula rather than 20 hand-picked angle pairs.
 *
 * Each region is actually TWO meshes sharing one position: a plain
 * axis-aligned BoxGeometry `pickMesh` (invisible, used only for raycasting
 * — the hit-test volume, kept separate so rounding the visuals can never
 * shrink or distort a click target) and a rounded `dispMesh` (the visible,
 * subtly chamfered plate).
 *
 * The 4 orbit arrows are NOT part of this scene — they are ordinary DOM
 * buttons the caller lays out in a fixed ring around the canvas (see
 * index.html's .viewcube markup + app.js's wiring). A ring that lived in
 * this rotating 3D scene would itself rotate with the camera. stepOrbit()
 * below is the pure, DOM-free math those buttons call into.
 */
import {getOrbit, tweenOrbit} from './fold3d.js';

const FACE_LABEL = {
  '1,0,0': 'RIGHT', '-1,0,0': 'LEFT',
  '0,1,0': 'TOP',   '0,-1,0': 'BOTTOM',
  '0,0,1': 'FRONT', '0,0,-1': 'BACK'
};

const BEVEL = 0.30;      // fraction of the half-extent given to edge/corner cells
const MID = 1 - BEVEL;   // face cells span -MID..MID on their two "flat" axes
const CUBE_EXTENT = 1;   // outer half-extent of the whole cube shape

// Restrained, two-tier palette: faces are light neutral panels; edges AND
// corners share ONE darker tone (no separate tiers, no outline, no third
// colour — the tint alone is the affordance).
const COLOR_FACE = 0xEEF1F4, COLOR_FACE_HOVER = 0xFFFFFF;
const COLOR_EDGECORNER = 0xC7CED5, COLOR_EDGECORNER_HOVER = 0xE1E6EA;
const FACE_TEXT = 0x3A434B;   // dark grey on light neutral, per spec

/** Nudge step: 15° per arrow click. Six clicks bring the adjacent face
 *  (90°) into view. Sign convention is PINNED to these two cases (tested
 *  in test/viewcube.test.html), not re-derived:
 *    viewing FRONT, click "right" x6  -> viewing LEFT
 *    viewing FRONT, click "bottom" x6 -> viewing TOP
 */
export const NUDGE = Math.PI/12;
const clampRx = rx => Math.max(-Math.PI/2, Math.min(Math.PI/2, rx));

/** Pure orbit-angle step for one arrow click — no THREE, no DOM, so the
 *  sign convention can be asserted directly. `which` is 'left'|'right'|
 *  'top'|'bottom' (screen-space ring position, matching index.html's
 *  fixed buttons). */
export function stepOrbit(which, rotX, rotY){
  switch(which){
    case 'right':  return {rx: rotX, ry: rotY - NUDGE};
    case 'left':   return {rx: rotX, ry: rotY + NUDGE};
    case 'bottom': return {rx: clampRx(rotX + NUDGE), ry: rotY};
    case 'top':    return {rx: clampRx(rotX - NUDGE), ry: rotY};
    default: throw new Error(`viewcube.stepOrbit: unknown arrow "${which}"`);
  }
}

let renderer = null, scene = null, camera = null, canvas = null;
let regions = [];          // {pickMesh, dispMesh, dir:[dx,dy,dz], isFace, ...}
let hovered = null;        // currently-hovered region (or null)

const hexStr = c => `#${c.toString(16).padStart(6, '0')}`;

/** A face's label plate is baked as a texture (background + text) rather
 *  than tinted via material.color, because material.color can only
 *  DARKEN a texture (multiply), never brighten it past its own baked
 *  value — so hover needs its own, brighter texture to swap to.
 *
 *  Font size is found by MEASURING the label against the texture width
 *  and shrinking until it fits, not guessed as a fixed size — a fixed
 *  guess is what truncated "X (L)" to "(L" in the previous version.
 *
 *  `xform` is {a,b,c,d} (see FACE_TEXT_XFORM below) that pre-corrects the
 *  text's orientation for whichever face this texture lands on. FRONT's
 *  transform is the identity. */
function labelTexture(text, bgHex, xform){
  const SIZE = 256;
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const g = c.getContext('2d');
  g.fillStyle = hexStr(bgHex); g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = hexStr(FACE_TEXT);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const maxWidth = SIZE * 0.8;
  let size = 116;
  do{
    g.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    size -= 2;
  }while(g.measureText(text).width > maxWidth && size > 20);
  g.save();
  g.translate(SIZE/2, SIZE/2);
  g.transform(xform.a, xform.b, xform.c, xform.d, 0, 0);
  g.fillText(text, 0, 2);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 2;
  return tex;
}

/** Per-face canvas correction so each label's texture lands upright when
 *  that face is viewed head-on (the only time it's read).
 *
 *  An analytical attempt (computing the shape-local-axes-to-screen basis
 *  via the same lookAt math the camera uses) got FRONT, BACK and TOP
 *  right but produced a doubled (180°) rotation on RIGHT. The missing
 *  factor: roundedCellGeometry always extrudes along local +Z, so its
 *  "front" and "back" caps are mirror images of each other in shape-uv
 *  terms — and WHICH cap ends up facing the camera flips with the SIGN
 *  of the face's direction component, independent of the aIdx/bIdx axis
 *  math. (This is why TOP needed a flip but BOTTOM didn't, even though
 *  they share the same aIdx/bIdx pairing — and why LEFT/RIGHT, sharing
 *  their own pairing, don't need the same correction as each other.)
 *
 *  Rather than keep modeling that in the abstract, these 6 entries were
 *  each derived by rendering the real roundedCellGeometry/uv pipeline
 *  with a quadrant-marked probe texture (no correction applied), reading
 *  back which marker landed in which screen quadrant via gl.readPixels,
 *  and solving for the canvas transform that cancels the observed
 *  mapping. {a,b,c,d} are ctx.transform's linear-part arguments (e=f=0),
 *  applied after translating to the canvas center: (x,y) -> (a*x+c*y,
 *  b*x+d*y). Keyed by the same "dx,dy,dz" string FACE_LABEL uses. */
const FACE_TEXT_XFORM = {
  '0,0,1':  {a: 1, b: 0, c: 0, d: 1},    // FRONT — identity (the reference)
  '0,0,-1': {a: -1, b: 0, c: 0, d: 1},   // BACK — horizontal mirror
  '0,1,0':  {a: 1, b: 0, c: 0, d: -1},   // TOP — vertical mirror
  '0,-1,0': {a: 1, b: 0, c: 0, d: 1},    // BOTTOM — identity (opposite cap cancels TOP's flip)
  '-1,0,0': {a: 0, b: -1, c: -1, d: 0},  // LEFT
  '1,0,0':  {a: 0, b: 1, c: -1, d: 0}    // RIGHT
};

/** Cell extent along one axis for direction component c (-1, 0, or 1):
 *  returns {center, size}. c=0 is the wide "flat" span; c=±1 is the thin
 *  bevel strip on that side. */
function cellAxis(c){
  if(c === 0) return {center: 0, size: 2*MID};
  const center = c*(MID + 1)/2;
  return {center, size: 1 - MID};
}

/** A rounded rectangle Shape, centered at the origin. */
function roundedRectShape(w, h, r){
  const s = new THREE.Shape();
  const x = -w/2, y = -h/2;
  s.moveTo(x, y + r);
  s.lineTo(x, y + h - r);
  s.quadraticCurveTo(x, y + h, x + r, y + h);
  s.lineTo(x + w - r, y + h);
  s.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
  s.lineTo(x + w, y + r);
  s.quadraticCurveTo(x + w, y, x + w - r, y);
  s.lineTo(x + r, y);
  s.quadraticCurveTo(x, y, x, y + r);
  return s;
}

/** The VISUAL geometry for one region: a subtly rounded plate occupying
 *  exactly the same (sx,sy,sz) box the pick geometry does — cosmetic only,
 *  never used for raycasting. Rounds the plate's two WIDE axes (its visible
 *  face) and extrudes flat along whichever axis is thinnest, then remaps
 *  the extrusion's local (x,y,z) onto the actual (sx,sy,sz) axis order so
 *  it lines up with the box it's replacing, whichever axis that is. */
function roundedCellGeometry(sx, sy, sz){
  const sizes = [sx, sy, sz];
  const thinIdx = sizes.indexOf(Math.min(...sizes));
  const [aIdx, bIdx] = [0, 1, 2].filter(i => i !== thinIdx);
  const w = sizes[aIdx], h = sizes[bIdx], depth = sizes[thinIdx];
  const r = Math.min(w, h) * 0.16;
  const geo = new THREE.ExtrudeGeometry(roundedRectShape(w, h, r), {depth, bevelEnabled: false, curveSegments: 6});
  geo.translate(0, 0, -depth/2);
  const arr = geo.attributes.position.array;
  const out = new Float32Array(arr.length);
  // ExtrudeGeometry's own auto-generated UVs do not reliably span the full
  // 0..1 range on this rounded-rect cap (it clipped the last letter of
  // every face label) — recompute UV directly from the shape-space x,y
  // (still available in `arr` before the axis remap below), guaranteeing
  // the label texture's full width actually lands on the visible plate.
  const uv = new Float32Array(arr.length/3*2);
  for(let i = 0, j = 0; i < arr.length; i += 3, j += 2){
    const local = [arr[i], arr[i + 1], arr[i + 2]];
    out[i + aIdx] = local[0]; out[i + bIdx] = local[1]; out[i + thinIdx] = local[2];
    uv[j] = local[0]/w + 0.5; uv[j+1] = local[1]/h + 0.5;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

function buildRegion(dx, dy, dz){
  const ax = cellAxis(dx), ay = cellAxis(dy), az = cellAxis(dz);
  const key = `${dx},${dy},${dz}`;
  const label = FACE_LABEL[key];
  const isFace = !!label;
  const baseColor = isFace ? COLOR_FACE : COLOR_EDGECORNER;
  const hoverColor = isFace ? COLOR_FACE_HOVER : COLOR_EDGECORNER_HOVER;

  // pick geometry: exactly the old flat box, used only for raycasting.
  // visible=false so the RENDERER never draws it at all (a transparent-
  // but-still-drawn mesh here z-fought against the coplanar display
  // plate) — Raycaster.intersectObjects doesn't consult .visible, and we
  // always pass this mesh in explicitly by reference, so hit-testing is
  // unaffected.
  const pickMesh = new THREE.Mesh(
    new THREE.BoxGeometry(ax.size, ay.size, az.size),
    new THREE.MeshBasicMaterial()
  );
  pickMesh.visible = false;
  pickMesh.position.set(ax.center, ay.center, az.center);

  // display geometry: the rounded, visible plate
  const dispGeo = roundedCellGeometry(ax.size, ay.size, az.size);
  let dispMat, texRest = null, texHover = null;
  if(isFace){
    const xform = FACE_TEXT_XFORM[key];
    texRest = labelTexture(label, baseColor, xform);
    texHover = labelTexture(label, hoverColor, xform);
    dispMat = new THREE.MeshBasicMaterial({map: texRest});
  }else{
    dispMat = new THREE.MeshBasicMaterial({color: baseColor});
  }
  const dispMesh = new THREE.Mesh(dispGeo, dispMat);
  dispMesh.position.set(ax.center, ay.center, az.center);

  return {pickMesh, dispMesh, dir: [dx, dy, dz], isFace, baseColor, hoverColor, texRest, texHover};
}

function buildCube(){
  const g = new THREE.Group();
  regions = [];
  for(let dx = -1; dx <= 1; dx++)
    for(let dy = -1; dy <= 1; dy++)
      for(let dz = -1; dz <= 1; dz++){
        if(dx === 0 && dy === 0 && dz === 0) continue;
        const r = buildRegion(dx, dy, dz);
        g.add(r.pickMesh, r.dispMesh);
        regions.push(r);
      }
  return g;
}

/** A small axis gnomon, OnShape-style: anchored AT the cube's own
 *  front-lower-left corner (LEFT+BOTTOM+FRONT), with its three short arms
 *  lying ALONG that corner's own incident cube edges — not floating out
 *  on a diagonal. Because it sits in the same local frame the cube
 *  regions live in, it turns together with the cube as the camera orbits,
 *  exactly like every face label does.
 *
 *  DISPLAY LABELING ONLY — a relabeling, not a scene change: the three
 *  arms still point along the exact same physical directions used
 *  everywhere else in this file/hierarchy3d.js/fold3d.js ((1,0,0),
 *  (0,1,0), (0,0,1) — the render-local axes where Y is vertical). Only
 *  the letter and colour each arm carries changes, to match the
 *  packaging convention (Z is vertical/up, X is left-right, Y is
 *  front-to-back) rather than Three's own Y-up naming:
 *    Three's X (left/right)        -> labeled "X"
 *    Three's Z (front/back, depth) -> labeled "Y", pointing toward -Z
 *    Three's Y (vertical, up)      -> labeled "Z"
 *  No axis, geometry, or camera math anywhere else in this file changes —
 *  this only picks which existing direction the "Y" arm is drawn along.
 *
 *  Y points toward -Z (BACK), not +Z (FRONT): "front-to-back" means away
 *  from the viewer at the FRONT view, into the screen — and the anchor
 *  corner sits at z=+CUBE_EXTENT (the FRONT side), so -Z is also the only
 *  one of the two choices that actually runs along a real cube edge from
 *  that corner (+Z would immediately exit the cube into empty space). */
function buildTriad(){
  const g = new THREE.Group();
  const anchor = new THREE.Vector3(-CUBE_EXTENT, -CUBE_EXTENT, CUBE_EXTENT);
  const axes = [
    {dir: [1, 0, 0], color: 0xE5484D, label: 'X'},    // Three's X -> pack's L (left-right)
    {dir: [0, 0, -1], color: 0x30A46C, label: 'Y'},   // Three's -Z -> pack's W (front-to-back)
    {dir: [0, 1, 0], color: 0x3E63DD, label: 'Z'}     // Three's Y -> pack's H (vertical)
  ];
  const armLen = 0.55;   // short — lies along the edge, doesn't reach past it
  const up = new THREE.Vector3(0, 1, 0);
  for(const a of axes){
    const d = new THREE.Vector3(...a.dir);
    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, armLen, 8),
      new THREE.MeshBasicMaterial({color: a.color})
    );
    arm.quaternion.setFromUnitVectors(up, d);
    arm.position.copy(anchor).addScaledVector(d, armLen/2);
    g.add(arm);

    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = hexStr(a.color);
    ctx.font = '700 66px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(a.label, 48, 50);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: new THREE.CanvasTexture(c), depthTest: false}));
    sprite.position.copy(anchor).addScaledVector(d, armLen*1.35);
    sprite.scale.set(0.4, 0.4, 0.4);
    g.add(sprite);
  }
  return g;
}

/** Mount the ViewCube into `container` (a small, absolutely-positioned DOM
 *  element the caller owns — this module only appends its own canvas).
 *  `onPick(rotX, rotY)` is called on a click, and is wired to fold3d's
 *  tweenOrbit by the caller (kept there, not here, so this module truly
 *  cannot move the main camera itself, only ask). The 4 orbit-arrow
 *  buttons and the Home button live in `container`'s own DOM (index.html)
 *  and are wired directly by app.js using stepOrbit()/HOME_ORBIT — this
 *  module only owns the rotating cube canvas. */
export function mount(container, onPick){
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-2.6, 2.6, 2.6, -2.6, 0.1, 20);
  camera.position.set(0, 0, 6);
  renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  canvas = renderer.domElement;
  canvas.style.cursor = 'pointer';
  container.appendChild(canvas);
  resize();

  scene.add(buildCube());
  scene.add(buildTriad());

  const raycaster = new THREE.Raycaster();
  const pointerNDC = (e) => {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left)/r.width)*2 - 1, -((e.clientY - r.top)/r.height)*2 + 1);
  };

  function applyState(region, state){
    if(region.texRest){
      region.dispMesh.material.map = state === 'hover' ? region.texHover : region.texRest;
      region.dispMesh.material.needsUpdate = true;
    }else{
      region.dispMesh.material.color.setHex(state === 'hover' ? region.hoverColor : region.baseColor);
    }
  }

  function clearHover(){
    if(!hovered) return;
    applyState(hovered, 'rest');
    hovered = null;
  }

  canvas.addEventListener('pointermove', e => {
    raycaster.setFromCamera(pointerNDC(e), camera);
    const hit = raycaster.intersectObjects(regions.map(r => r.pickMesh), false)[0];
    const region = hit ? regions.find(r => r.pickMesh === hit.object) : null;
    if(region === hovered) return;
    clearHover();
    if(region){ hovered = region; applyState(region, 'hover'); }
  });
  canvas.addEventListener('pointerleave', clearHover);

  canvas.addEventListener('click', e => {
    raycaster.setFromCamera(pointerNDC(e), camera);
    const hit = raycaster.intersectObjects(regions.map(r => r.pickMesh), false)[0];
    if(!hit) return;
    const region = regions.find(r => r.pickMesh === hit.object);
    if(!region) return;
    const [dx, dy, dz] = region.dir;
    const mag = Math.hypot(dx, dy, dz);
    const rx = Math.asin(dy/mag), ry = Math.atan2(dx, dz);
    onPick(rx, ry);
  });

  new ResizeObserver(resize).observe(container);
}

function resize(){
  if(!renderer || !canvas.parentElement) return;
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  if(!w || !h) return;
  renderer.setSize(w, h, false);
}

/** Called every main-camera frame (via fold3d.js's onFrame): mirrors the
 *  cube's own camera to the main camera's CURRENT orbit angles and renders
 *  this scene. The cube has no orientation of its own between calls. */
export function sync(){
  // app.js owns visibility (toggling the outer .viewcube wrap's display,
  // which also hides the arrows/Home button) — offsetParent is null for
  // any element hidden by itself OR an ancestor, so this stays correct
  // regardless of which DOM layer between the canvas and that wrap is the
  // one actually toggled.
  if(!renderer || canvas.offsetParent === null) return;
  const {rotX, rotY} = getOrbit();
  const r = 6;
  camera.position.set(Math.sin(rotY)*Math.cos(rotX)*r, Math.sin(rotX)*r, Math.cos(rotY)*Math.cos(rotX)*r);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

export const isMounted = () => !!renderer;
