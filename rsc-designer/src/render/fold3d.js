/**
 * 3D fold view: owns the shared three.js renderer/scene/camera/orbit loop
 * (pallet3d renders into the same scene), plus the box fold animation.
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

export const kraft  = new THREE.MeshStandardMaterial({color:0xC69C6D,roughness:0.9, metalness:0,side:THREE.DoubleSide});
export const kraft2 = new THREE.MeshStandardMaterial({color:0xB98A55,roughness:0.92,metalness:0,side:THREE.DoubleSide});

export const isInit = () => !!renderer;
export const getPivot = () => pivot;
export const setCamSpan = v => { camSpan = v; };

export function init3d(container){
  cvWrap = container;
  renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100000);
  pivot = new THREE.Group(); scene.add(pivot);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a949e, 0.85));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.7);  d1.position.set(1, 2, 1.4);    scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.28); d2.position.set(-1.3, 0.6, -1); scene.add(d2);

  const c = renderer.domElement;
  c.style.cursor = 'grab';
  c.addEventListener('pointerdown', e => {dragging = true; lastX = e.clientX; lastY = e.clientY; c.setPointerCapture(e.pointerId); c.style.cursor = 'grabbing';});
  c.addEventListener('pointerup',   () => {dragging = false; c.style.cursor = 'grab';});
  c.addEventListener('pointermove', e => {
    if(!dragging) return;
    rotY -= (e.clientX - lastX)*0.008; rotX += (e.clientY - lastY)*0.008; // horizontal inverted per user preference
    rotX = Math.max(-1.35, Math.min(1.35, rotX)); lastX = e.clientX; lastY = e.clientY;
  });
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
  const t = Math.max(geo.meta.caliper, RENDER_MIN_THICKNESS); // mesh thickness only

  const built = build(geo, printText, options || {}, {t, kraft, kraft2, makeFlap, makeTextMaterial});
  built.parts.forEach(o => boxGroup.add(o));
  built.flaps.forEach(f => { if(!f.parent) boxGroup.add(f); }); // nested hinges stay parented to their panel
  flaps = built.flaps;
  boxOpenParts = [...boxGroup.children];   // separate panels & flaps: shown while folding

  // continuous closed carton, swapped in when the fold completes — one rounded
  // shell (no gaps at the creases), print decal, plus style-provided extras
  boxClosedParts = [];
  const rr = Math.min(t*1.6, Math.min(L, W, H)*0.1);
  const shell = new THREE.Mesh(roundedBoxGeo(L + t, H + t, W + t, rr, 3), kraft);
  shell.position.y = H/2;
  boxClosedParts.push(shell);
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(L*0.92, H*0.92), makeTextMaterial(L, H, true, printText));
  decal.position.set(0, H/2, (W + t)/2 + Math.max(t*0.1, 0.25));
  boxClosedParts.push(decal);
  (built.closedExtras || []).forEach(o => boxClosedParts.push(o));
  boxClosedParts.forEach(o => {o.visible = false; boxGroup.add(o);});

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
  // fully folded → swap the panel construction for the continuous rounded carton
  const closed = t >= 1;
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
export function showBox(v){ if(boxGroup) boxGroup.visible = v; }

function frameCamera(){
  const span = camSpan || 100; // set by buildBox / buildPallet for the active scene
  const r = span*2.4*dist;
  camera.position.set(Math.sin(rotY)*Math.cos(rotX)*r, Math.sin(rotX)*r, Math.cos(rotY)*Math.cos(rotX)*r);
  camera.lookAt(0, 0, 0);
  camera.far = r*10; camera.updateProjectionMatrix();
}

export function startLoop(){
  if(raf) return;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if(folding){ foldT = Math.min(1, foldT + 0.02); applyFold(foldT); if(foldT >= 1) folding = false; }
    frameCamera(); renderer.render(scene, camera);
  };
  loop();
}
