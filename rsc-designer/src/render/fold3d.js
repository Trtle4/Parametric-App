/**
 * 3D fold view: owns the shared three.js renderer/scene/camera/orbit loop
 * (the 3D hierarchy views render into the same scene), plus the box fold
 * animation.
 * Uses the global THREE from the classic script tag in index.html.
 * All geometry in mm.
 */

/** Rendering-only floor for mesh thickness: guards against degenerate
 *  (z-fighting, invisible) thin meshes. It may NEVER influence any
 *  dimension the packer or exporter sees — that math uses raw caliper. */
const RENDER_MIN_THICKNESS = 0.6; // mm

let renderer, scene, camera, pivot, boxGroup, raf, folding = false, foldT = 0;
let dragging = false, lastX = 0, lastY = 0, rotX = -0.5, rotY = 0.7, dist = 1;
let camSpan = 250;
let cvWrap = null;
// Pan (CAD-standard): the point the camera looks AT, slid in the screen plane
// by a right-drag (desktop) or two-finger drag (touch). Orbit stays about this
// point; Home / view changes reset it (setOrbit). One Vector3, one writer.
let panTarget = null;                       // THREE.Vector3, lazily created in init3d
// Multi-input gesture state: every active pointer, the mouse drag mode, and the
// last two-finger centroid/spread so touch can pan+pinch simultaneously.
const pointers = new Map();                 // pointerId -> {x, y}
let dragMode = null;                        // 'orbit' | 'pan' (mouse only)
let lastCentroid = null, pinchDist = 0;     // two-finger pan centroid + pinch spread

/** The one "default three-quarter isometric" orbit — app.js's own
 *  resetCam (applyHierarchy) and the ViewCube's Home button both read this
 *  SAME constant, so "home" can never mean two different views. */
export const HOME_ORBIT = {rotX: 0.5, rotY: 0.65};

/** Fold an angle into [-pi, pi) — vertical orbit is a full circle now, so
 *  rotX is wrapped after every drag instead of growing without bound. The
 *  pose below is 2*pi-periodic, so the wrap is invisible mid-gesture. */
const wrapPi = a => { const m = (a + Math.PI) % (2*Math.PI); return (m < 0 ? m + 2*Math.PI : m) - Math.PI; };

// held this far off an exact pole (0.006 deg — invisible)
const POLE_EPS = 1e-4;

/**
 * THE orbit->camera formula: where the camera sits for an angle pair, and
 * which way is up there. ONE definition, shared by the main camera and the
 * ViewCube's mirror (viewcube.js imports it) — the cube used to re-state the
 * same spherical formula, which was harmless only while `up` was a constant.
 * It no longer is, and two copies would let the cube disagree with the view
 * it exists to report.
 *
 * Vertical orbit is UNCLAMPED: rotX may pass through +/-90 deg and keep
 * going down the far side. Past a pole cos(rotX) turns negative, which flips
 * the horizontal offset to the opposite side of the model — the camera
 * carries on the same way around — and the world must then appear INVERTED.
 * So `upY` follows sign(cos(rotX)). Without that flip the screen-up vector
 * reverses discontinuously at the pole and the view snaps through 180 deg of
 * roll: the gimbal flip the old +/-1.35 rad drag clamp existed to dodge.
 * Flipping `up` in step with the crossing is what makes removing the clamp
 * safe rather than just trading a wall for a glitch.
 *
 * Exactly ON a pole the view direction is parallel to up and lookAt is
 * degenerate (THREE resolves it with an arbitrary internal nudge). The angle
 * is therefore held POLE_EPS off the pole for the CAMERA only, on whichever
 * side keeps cos's sign — and so `upY` — as it was: nudging the other way
 * would let the epsilon pick the roll, landing a ViewCube TOP snap 180 deg
 * from where it lands today. The stored orbit state keeps the exact +/-90 deg.
 */
export function orbitPose(rotX, rotY, r){
  const upY = Math.cos(rotX) >= 0 ? 1 : -1;
  let rx = rotX;
  if(Math.abs(Math.cos(rx)) < POLE_EPS){
    const s = Math.sin(rx) >= 0 ? 1 : -1;          // +1 at the top pole, -1 at the bottom
    rx -= s*upY*POLE_EPS;
  }
  const c = Math.cos(rx);
  return {x: Math.sin(rotY)*c*r, y: Math.sin(rx)*r, z: Math.cos(rotY)*c*r, upY};
}

export const kraft  = new THREE.MeshStandardMaterial({color:0xC69C6D,roughness:0.9, metalness:0,side:THREE.DoubleSide});
export const kraft2 = new THREE.MeshStandardMaterial({color:0xB98A55,roughness:0.92,metalness:0,side:THREE.DoubleSide});

export const isInit = () => !!renderer;
export const getPivot = () => pivot;
export const getCamera = () => camera;
export const getDomElement = () => renderer && renderer.domElement;
export const setCamSpan = v => { camSpan = v; };

// per-frame callbacks (e.g. hierarchy cutaway faces track the orbiting camera)
const frameCbs = new Set();
export const onFrame = cb => { frameCbs.add(cb); return () => frameCbs.delete(cb); };

export function init3d(container){
  cvWrap = container;
  panTarget = new THREE.Vector3(0, 0, 0);
  // preserveDrawingBuffer keeps the colour buffer readable AFTER the frame so
  // capturePNG's toDataURL isn't blank — WebGL clears the buffer on present by
  // default (the same cleared-buffer trap the ViewCube diagnosis hit).
  renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  setStageBackground(stageBg);                 // apply a choice made before init
  container.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100000);
  pivot = new THREE.Group(); scene.add(pivot);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a949e, 0.85));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.7);  d1.position.set(1, 2, 1.4);    scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.28); d2.position.set(-1.3, 0.6, -1); scene.add(d2);

  const c = renderer.domElement;
  c.style.cursor = 'grab';
  c.style.touchAction = 'none';                       // we own pan/zoom/orbit; stop browser scroll/pinch
  c.addEventListener('contextmenu', e => e.preventDefault());  // right-drag pans; never pop the menu

  c.addEventListener('pointerdown', e => {
    c.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    lastX = e.clientX; lastY = e.clientY;
    if(e.pointerType === 'touch'){
      if(pointers.size === 2){ pinchDist = touchSpread(); lastCentroid = touchCentroid(); } // enter two-finger pan/pinch
    } else {
      dragMode = (e.button === 0) ? 'orbit' : 'pan';  // left orbit, right/middle pan (CAD)
      c.style.cursor = dragMode === 'pan' ? 'move' : 'grabbing';
    }
  });

  c.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if(!p) return;
    const px = e.clientX, py = e.clientY;
    if(e.pointerType === 'touch'){
      p.x = px; p.y = py;
      if(pointers.size >= 2){                          // two-finger: pan by centroid, zoom by spread
        const cen = touchCentroid();
        if(lastCentroid) panBy(cen.x - lastCentroid.x, cen.y - lastCentroid.y);
        lastCentroid = cen;
        const d = touchSpread();
        if(pinchDist && d) { dist *= pinchDist/d; dist = Math.max(0.55, Math.min(3, dist)); }
        pinchDist = d;
      } else {                                         // one-finger orbit
        rotY -= (px - lastX)*0.008; rotX += (py - lastY)*0.008;
        rotX = wrapPi(rotX); lastX = px; lastY = py;   // over the pole and on down the far side
      }
    } else {
      const dx = px - lastX, dy = py - lastY;
      if(dragMode === 'pan') panBy(dx, dy);
      else if(dragMode === 'orbit'){                   // horizontal inverted per user preference
        rotY -= dx*0.008; rotX += dy*0.008; rotX = wrapPi(rotX);   // unclamped: through the pole, down the far side
      }
      lastX = px; lastY = py;
    }
  });

  const endPointer = e => {
    pointers.delete(e.pointerId);
    if(e.pointerType === 'touch'){
      lastCentroid = null; pinchDist = 0;
      if(pointers.size === 1){ const r = [...pointers.values()][0]; lastX = r.x; lastY = r.y; } // resume orbit without a jump
    } else {
      dragMode = null; c.style.cursor = 'grab';
    }
  };
  c.addEventListener('pointerup', endPointer);
  c.addEventListener('pointercancel', endPointer);

  c.addEventListener('wheel', e => {e.preventDefault(); dist *= (1 + Math.sign(e.deltaY)*0.08); dist = Math.max(0.55, Math.min(3, dist));}, {passive:false});
  new ResizeObserver(resize3d).observe(container);
}

export function resize3d(){
  if(!renderer) return;
  const w = cvWrap.clientWidth, h = cvWrap.clientHeight;
  if(!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix();
}

// solid box with rounded vertical edges AND rounded top/bottom (bevel) — reads as one
// continuous carton instead of separate panels meeting at hard, gappy corners.
// Returns geometry sized w(x) × h(y) × d(z), centred on origin.
export function roundedBoxGeo(w, h, d, r, seg){
  seg = seg || 3;
  // NB: extrude bevels GROW the cross-section by bevelSize, so the base shape
  // is shrunk by the radius on every side — final solid is exactly w × h × d.
  const rr = Math.max(0.01, Math.min(r, w/4, d/4, h/4));
  const hw = w/2 - rr, hd = d/2 - rr, cr = rr*0.35, s = new THREE.Shape();
  s.moveTo(-hw+cr, -hd);
  s.lineTo(hw-cr, -hd);  s.quadraticCurveTo(hw, -hd, hw, -hd+cr);
  s.lineTo(hw, hd-cr);   s.quadraticCurveTo(hw, hd, hw-cr, hd);
  s.lineTo(-hw+cr, hd);  s.quadraticCurveTo(-hw, hd, -hw, hd-cr);
  s.lineTo(-hw, -hd+cr); s.quadraticCurveTo(-hw, -hd, -hw+cr, -hd);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.01, h - 2*rr), bevelEnabled: true,
    bevelThickness: rr, bevelSize: rr, bevelSegments: seg, curveSegments: seg
  });
  g.center(); g.rotateX(-Math.PI/2); // extrude runs along +Z; stand it up so height is +Y
  return g;
}

// canvas texture carrying the free print text. Opaque (kraft-toned) for a full wall face,
// or transparent so it can sit as a decal on the continuous closed box.
function makeTextMaterial(L, H, transparent, txt){
  const cw = 1024, chh = Math.max(96, Math.min(1024, Math.round(cw*H/Math.max(L, 1))));
  const c = document.createElement('canvas'); c.width = cw; c.height = chh;
  const g = c.getContext('2d');
  if(!transparent){ g.fillStyle = '#C69C6D'; g.fillRect(0, 0, cw, chh); }
  if(txt){
    g.fillStyle = '#4a3826';
    let fs = Math.min(chh*0.4, 180);
    g.font = `700 ${fs}px system-ui, sans-serif`;
    while(g.measureText(txt).width > cw*0.88 && fs > 18){ fs -= 6; g.font = `700 ${fs}px system-ui, sans-serif`; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, cw/2, chh/2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return new THREE.MeshStandardMaterial({map:tex, roughness:0.9, metalness:0, side:THREE.DoubleSide,
    transparent: !!transparent, alphaTest: transparent ? 0.35 : 0});
}

// flap that folds about an axis; open state coplanar with its wall
// phase 0 = inner (folds first), phase 1 = outer (folds second, on top)
function makeFlap(hinge, axis, closedAngle, openOffset, geo, mat, phase){
  const grp = new THREE.Group();
  grp.position.set(hinge[0], hinge[1], hinge[2]);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(openOffset[0], openOffset[1], openOffset[2]);
  grp.add(mesh);
  grp.userData = {axis, closedAngle, phase};
  return grp;
}

let flaps = [], boxOpenParts = [], boxClosedParts = [];
// an OPEN structure (e.g. the FEFCO 0300 tray) has no closed rounded shell to
// morph into — its erected panels/flaps ARE the final form, so the fold never
// swaps them out. Closed boxes leave this false and keep the shell swap.
let openStructure = false;

/**
 * Assemble the fold view from a style's fold builder. Style-agnostic:
 * the builder returns open parts, hinged flap groups (possibly nested),
 * and closed-state extras; this function owns the scene plumbing plus the
 * generic closed carton (rounded shell + print decal).
 * @param {Function} build   fold builder from render/folds/index.js
 * @param {import('../core/types.js').Geometry} geo
 * @param {string} printText
 * @param {Object} options   style-specific view options (e.g. outerFlaps)
 */
export function buildBox(build, geo, printText, options){
  if(boxGroup){
    pivot.remove(boxGroup);
    boxGroup.traverse(o => {
      if(o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      mats.forEach(m => { if(m.map){ m.map.dispose(); m.dispose(); } }); // only the per-build text material owns a texture
    });
  }
  boxGroup = new THREE.Group(); flaps = [];
  const {L, W, H} = geo.inner;
  // flexible styles have no caliper (film gauge is not caliper); the render
  // floor keeps the shell drawable either way — mesh thickness only
  const t = Math.max(geo.meta.caliper || 0, RENDER_MIN_THICKNESS);

  const built = build(geo, printText, options || {}, {t, kraft, kraft2, makeFlap, makeTextMaterial});
  openStructure = !!built.openStructure;
  built.parts.forEach(o => boxGroup.add(o));
  built.flaps.forEach(f => { if(!f.parent) boxGroup.add(f); }); // nested hinges stay parented to their panel
  flaps = built.flaps;
  boxOpenParts = [...boxGroup.children];   // separate panels & flaps: shown while folding

  // continuous closed carton, swapped in when the fold completes — one rounded
  // shell (no gaps at the creases), print decal, plus style-provided extras.
  // Skipped entirely for an OPEN structure: its erected panels stay the form.
  boxClosedParts = [];
  if(!openStructure){
    const rr = Math.min(t*1.6, Math.min(L, W, H)*0.1);
    const shell = new THREE.Mesh(roundedBoxGeo(L + t, H + t, W + t, rr, 3), kraft);
    shell.position.y = H/2;
    boxClosedParts.push(shell);
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(L*0.92, H*0.92), makeTextMaterial(L, H, true, printText));
    decal.position.set(0, H/2, (W + t)/2 + Math.max(t*0.1, 0.25));
    boxClosedParts.push(decal);
    (built.closedExtras || []).forEach(o => boxClosedParts.push(o));
    boxClosedParts.forEach(o => {o.visible = false; boxGroup.add(o);});
  }

  boxGroup.position.y = -H/2;         // centre vertically for orbit
  pivot.add(boxGroup);
  camSpan = Math.max(L, W, H);

  applyFold(foldT);
}

export function applyFold(t){
  flaps.forEach(f => {
    const {axis, closedAngle, phase} = f.userData;
    const lt = Math.min(1, Math.max(0, (t - (phase ? 0.5 : 0))*2)); // inner pair folds in first half, outer in second
    f.rotation[axis] = closedAngle*lt;
  });
  // fully folded → swap the panel construction for the continuous rounded
  // carton. An OPEN structure has no shell to swap to, so its erected panels
  // stay visible at every t (they ARE the final erected tray).
  const closed = t >= 1 && !openStructure;
  boxOpenParts.forEach(o => o.visible = !closed);
  boxClosedParts.forEach(o => o.visible = closed);
}

/** (Re)start the fold animation; jumps straight to closed under reduced motion. */
export function startFold(){
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  foldT = reduce ? 1 : 0; folding = !reduce;
  applyFold(foldT);
}
export function stopFold(){ folding = false; }
// two-finger touch helpers — centroid (for pan) and spread (for pinch zoom)
function touchCentroid(){ const p = [...pointers.values()]; return {x: (p[0].x + p[1].x)/2, y: (p[0].y + p[1].y)/2}; }
function touchSpread(){ const p = [...pointers.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }

/** Slide the look-at point in the camera's screen plane by a pixel delta.
 *  Content follows the drag (CAD): dragging right moves the scene right. The
 *  scale converts screen pixels to world units at the target's depth, so pan
 *  tracks the cursor 1:1 regardless of zoom/span. Reads the camera's world
 *  right/up axes (matrixWorld cols 0/1), kept current by frameCamera. */
function panBy(dxPx, dyPx){
  if(!panTarget) return;
  const span = camSpan || 100, r = span*2.4*dist;
  const h = (cvWrap && cvWrap.clientHeight) || 1;
  const worldPerPx = 2*Math.tan((camera.fov*Math.PI/180)/2)*r / h;
  const m = camera.matrixWorld.elements;
  const right = new THREE.Vector3(m[0], m[1], m[2]);
  const up    = new THREE.Vector3(m[4], m[5], m[6]);
  panTarget.addScaledVector(right, -dxPx*worldPerPx);
  panTarget.addScaledVector(up,     dyPx*worldPerPx);
}
/** Recentre the view (undo any pan). The ViewCube Home button calls this. */
export function resetPan(){ if(panTarget) panTarget.set(0, 0, 0); }

/** Set the orbit camera (elevated 3/4 view for the hierarchy cutaway). Also
 *  recentres the pan — a view change/reset always returns to the framed model. */
export function setOrbit(rx, ry, d){ rotX = rx; rotY = ry; dist = d; resetPan(); }
/** Current orbit angles — the single source the ViewCube slaves its own
 *  camera to every frame. Read-only: nothing outside this module writes
 *  rotX/rotY directly, so there is exactly one orbit state, never a second
 *  copy that could drift from what the main view is actually showing. */
export const getOrbit = () => ({rotX, rotY});

let tween = null;   // {fromX, fromY, toX, toY, t0, dur}
/** Animate the orbit to (rx, ry) over `dur` ms instead of jumping — used by
 *  the ViewCube so clicking a face/edge/corner doesn't discard the user's
 *  spatial context. BOTH angles tween the SHORT way around (wrapping through
 *  ±π), never the long way just because the raw difference happens to be
 *  large. rotX needs that wrap too now that vertical orbit is unclamped and
 *  circular: from an inverted pose (|rotX| > 90°, dragged over a pole) the
 *  nearer route back to a face view is often onward over the SAME pole, not
 *  all the way back the way the user came. */
export function tweenOrbit(rx, ry, dur = 450){
  const short = d => { while(d > Math.PI) d -= 2*Math.PI; while(d < -Math.PI) d += 2*Math.PI; return d; };
  tween = {fromX: rotX, fromY: rotY, toX: rotX + short(rx - rotX), toY: rotY + short(ry - rotY),
           t0: performance.now(), dur};
}
function updateTween(){
  if(!tween) return;
  const t = Math.min(1, (performance.now() - tween.t0)/tween.dur);
  const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;    // ease-in-out
  rotX = tween.fromX + (tween.toX - tween.fromX)*e;
  rotY = tween.fromY + (tween.toY - tween.fromY)*e;
  // fold rotX back into [-pi, pi) only once the tween LANDS (mid-tween it would
  // jump): the short-way target can sit outside that range, and repeated snaps
  // from inverted poses would otherwise let the stored angle drift unbounded.
  // The pose is 2*pi-periodic, so the fold is invisible.
  if(t >= 1){ rotX = wrapPi(rotX); tween = null; }
}
/** Jump straight to the closed state (flexible styles have no fold sequence). */
export function jumpClosed(){ folding = false; foldT = 1; applyFold(1); }
export function showBox(v){ if(boxGroup) boxGroup.visible = v; }

function frameCamera(){
  const span = camSpan || 100; // set by buildBox / buildPallet for the active scene
  const r = span*2.4*dist;
  const t = panTarget || {x: 0, y: 0, z: 0};   // orbit about the (possibly panned) look-at point
  const pose = orbitPose(rotX, rotY, r);
  camera.position.set(t.x + pose.x, t.y + pose.y, t.z + pose.z);
  camera.up.set(0, pose.upY, 0);          // flips past a pole — see orbitPose
  camera.lookAt(t.x, t.y, t.z);
  camera.far = r*10; camera.updateProjectionMatrix();
}

/** Snapshot the current 3D view (exactly the on-screen camera/orbit/zoom, the
 *  active scene) as a PNG data URL, rendered at `scale`× the on-screen pixels
 *  for a crisp deck image. The ViewCube is a SEPARATE renderer/canvas, so it
 *  is never composited in. Renders once at the higher backing-store size,
 *  reads it back (needs preserveDrawingBuffer), then restores the on-screen
 *  size — all synchronous, so the animation loop never sees the enlarged
 *  buffer. Returns null if the 3D view isn't initialised. */
/** Stage background — 'grid' (transparent canvas, the page's drafting grid
 *  shows through) or 'white' (the renderer's own opaque clear colour).
 *
 *  ONE mechanism for the on-screen toggle and every capture: white is not a
 *  post-process or an export-only variant, it is the colour the canvas
 *  actually clears to, so what the user sees IS what toDataURL reads back.
 *  A view preference, not project state — it lives on the renderer, which
 *  scene rebuilds never touch, so it survives every recompute without
 *  registering anywhere. */
let stageBg = 'grid';
export function setStageBackground(mode){
  stageBg = mode === 'white' ? 'white' : 'grid';
  if(!renderer) return;                        // stored; init3d applies it
  if(stageBg === 'white') renderer.setClearColor(0xffffff, 1);
  else renderer.setClearColor(0x000000, 0);
}
export const getStageBackground = () => stageBg;

/** Render ONE fixed view at an explicit pixel size and read it back — the
 *  print-capture path. Unlike capturePNG (the 3D PNG button, which grabs the
 *  CURRENT camera at the on-screen aspect), this sets its own orbit and its
 *  own backing-store size, so a PDF sheet gets consistent, print-resolution
 *  views regardless of what the user was looking at. Restores everything —
 *  orbit, pan, pixel ratio, canvas size — and repaints, all synchronously,
 *  so the animation loop never sees the capture state. Background is
 *  whatever setStageBackground says (the caller sets 'white' around a print
 *  capture — the same mechanism as the toggle, not a second one). */
/**
 * @param {number} [fovDeg] a NARROWER lens for this shot, with the distance
 *   scaled to keep the framing identical — a telephoto, in the photographic
 *   sense. It exists for the PLAN view: at the normal 38° a load 1.4m tall
 *   seen from overhead is magnified against the deck a metre below it (the
 *   near plane of a perspective frustum is simply wider), so the top layer
 *   covers a pallet only 3% wider than itself and the pallet is not in the
 *   picture at all — measured, the deck contributed ZERO pixels. Narrowing
 *   the lens compresses that divergence toward the orthographic projection a
 *   plan view is supposed to be. The distance compensation is the standard
 *   relation tan(fov0/2)/tan(fov/2), so the subject fills the frame exactly
 *   as before and only the perspective changes.
 */
export function captureOrbitPNG(rx, ry, d, w, h, quality = 0.92, fovDeg = 0){
  if(!renderer || !scene || !camera) return null;
  const prev = {rotX, rotY, dist, fov: camera.fov,
                pan: panTarget ? {x: panTarget.x, y: panTarget.y, z: panTarget.z} : null,
                pr: renderer.getPixelRatio()};
  const size = new THREE.Vector2(); renderer.getSize(size);
  const T = a => Math.tan(a*Math.PI/360);      // tan of half the fov
  // clamp so the compensated distance stays inside the camera's far plane
  const fov = fovDeg > 0 ? Math.max(1.6, Math.min(camera.fov, fovDeg)) : 0;
  rotX = rx; rotY = ry; dist = fov ? d*T(prev.fov)/T(fov) : d;
  if(fov) camera.fov = fov;
  if(panTarget) panTarget.set(0, 0, 0);        // a print view is centred, never panned
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w/h;
  frameCamera();
  // Run the per-frame hooks against the CAPTURE camera before rendering. The
  // cutaway's near-panel suppression is one of these hooks — it hides the
  // walls that face the camera, and it only ever runs inside the RAF loop
  // with the ON-SCREEN camera. A synchronous capture that skips it renders
  // whatever visibility the last on-screen frame (or a fresh build, which
  // creates every wall visible) left behind: the PDF's cutaway came out a
  // closed box with an end gap, open toward a camera nobody was using.
  for(const cb of frameCbs) cb(camera);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/jpeg', quality);
  rotX = prev.rotX; rotY = prev.rotY; dist = prev.dist; camera.fov = prev.fov;
  if(panTarget && prev.pan) panTarget.set(prev.pan.x, prev.pan.y, prev.pan.z);
  renderer.setPixelRatio(prev.pr);
  renderer.setSize(size.x, size.y, false);
  if(size.y > 0) camera.aspect = size.x/size.y;
  frameCamera();
  for(const cb of frameCbs) cb(camera);        // …and again for the restored view
  renderer.render(scene, camera);
  return url;
}

export function capturePNG(scale = 2){
  if(!renderer || !scene || !camera || !cvWrap) return null;
  const w = cvWrap.clientWidth, h = cvWrap.clientHeight;
  if(!w || !h) return null;
  const prevPR = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(w*scale, h*scale, false);   // backing store only; CSS size (updateStyle=false) untouched
  frameCamera();                                // exact current orbit/zoom/span
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setPixelRatio(prevPR);
  renderer.setSize(w, h, false);                // restore, then repaint on-screen
  frameCamera();
  renderer.render(scene, camera);
  return url;
}

export function startLoop(){
  if(raf) return;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if(folding){ foldT = Math.min(1, foldT + 0.02); applyFold(foldT); if(foldT >= 1) folding = false; }
    updateTween();
    frameCamera();
    for(const cb of frameCbs) cb(camera);   // cutaway faces etc. track the camera; the ViewCube syncs here too
    renderer.render(scene, camera);
  };
  loop();
}
