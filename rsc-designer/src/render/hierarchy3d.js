/**
 * Hierarchy cascade view: product < wrap < carton < case < pallet.
 *
 * At the selected depth it renders the FULL population of that level's
 * immediate children, opens exactly ONE child, and recurses the same rule
 * inside it — a single cutaway channel drilling to a piece, one open unit
 * per level. Closed units are instanced and fully opaque; opened units are
 * cutaways (near walls hidden as the camera orbits) so the interior is
 * directly visible.
 *
 * Every placement comes from the model (collate / solveParent / fitInto,
 * surfaced by project.js). This renderer performs NO packaging math.
 * Wrap-vs-box keys off `structure`, never a styleId.
 */
import {getPivot, setCamSpan, getCamera, onFrame, kraft, kraft2, roundedBoxGeo} from './fold3d.js';

const T_FLOOR = 0.6;                    // min rendered wall thickness, mm
const IDX = {L: 0, W: 1, H: 2};
const ENV_AXIS = {X: 'L', Y: 'W', Z: 'H'};

const board   = kraft;                  // case/carton board (opaque)
const board2  = kraft2;
const pieceMat = new THREE.MeshStandardMaterial({color: 0xE0C089, roughness: 0.75, metalness: 0});
const filmMat = new THREE.MeshStandardMaterial({color: 0xBcd8e6, roughness: 0.25, metalness: 0,
  transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false});
const filmClosedMat = new THREE.MeshStandardMaterial({color: 0xBcd8e6, roughness: 0.25, metalness: 0,
  transparent: true, opacity: 0.72, side: THREE.DoubleSide});
const sealMat = new THREE.MeshStandardMaterial({color: 0x8fb3c4, roughness: 0.4, metalness: 0, side: THREE.DoubleSide});
const deckMat = new THREE.MeshStandardMaterial({color: 0xA0815A, roughness: 0.95, metalness: 0});
const edgeMat = new THREE.LineBasicMaterial({color: 0x6b5636, transparent: true, opacity: 0.5});

let group = null;                       // the whole hierarchy scene
let cutawayWalls = [];                  // {mesh, n:Vector3 localOutwardNormal} updated per frame
let pickables = [];                     // {mesh, path} for click-to-open
let disposeFrame = null;
let hud = null;

/* ---------- geometry helpers ---------- */

// oriented outer dims of a child given a containment orientation string
function orient(outer, o){ return {l: outer[o[0]], w: outer[o[1]], h: outer[o[2]]}; }

// world rotation that stands a child (design x=L, y=H, z=W) into orientation o.
// H-up cases use a proper Y rotation; other axes fall back to a basis (may
// reflect a symmetric body — visually identical for our boxes/grids).
function orientQuat(o){
  const q = new THREE.Quaternion();
  if(o[2] === 'H') return q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), o[0] === 'L' ? 0 : Math.PI/2);
  const slot = a => a === 0 ? new THREE.Vector3(1, 0, 0) : a === 1 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4().makeBasis(slot(o.indexOf('L')), slot(o.indexOf('H')), slot(o.indexOf('W')));
  return q.setFromRotationMatrix(m);
}

// child centre in the parent's local frame (parent cavity centred; z from floor)
function childPos(pl, parentInnerH){ return new THREE.Vector3(pl.x, -parentInnerH/2 + pl.z, pl.y); }

/** A cutaway rigid box: floor + 4 vertical walls with real board thickness,
 *  open top. Near walls are hidden per-frame so the interior stays visible. */
function cutawayBox(outer, inner, mat){
  const g = new THREE.Group();
  const t = Math.max((outer.L - inner.L) / 2, T_FLOOR);
  const {L, W, H} = outer;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(L, t, W), mat);
  floor.position.y = -H/2 + t/2; g.add(floor);
  // 4 walls; store outward normal so the frame loop can hide the near ones
  const walls = [
    {geo: [t, H, W], pos: [ L/2 - t/2, 0, 0], n: [ 1, 0, 0]},
    {geo: [t, H, W], pos: [-L/2 + t/2, 0, 0], n: [-1, 0, 0]},
    {geo: [L, H, t], pos: [0, 0,  W/2 - t/2], n: [0, 0,  1]},
    {geo: [L, H, t], pos: [0, 0, -W/2 + t/2], n: [0, 0, -1]}
  ];
  for(const w of walls){
    const m = new THREE.Mesh(new THREE.BoxGeometry(...w.geo), mat);
    m.position.set(...w.pos);
    g.add(m);
    cutawayWalls.push({mesh: m, n: new THREE.Vector3(...w.n)});
  }
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), edgeMat));
  return g;
}

/** A wrap body: rounded conforming surface over the envelope, plus the fin
 *  seal (why H grows) and the two end-seal crimp tabs (why L grows). */
function wrapBody(envelope, seals, opened){
  const g = new THREE.Group();
  const {L, W, H} = envelope;
  const body = new THREE.Mesh(roundedBoxGeo(L, H, W, Math.min(W, H) * 0.22, 3),
                              opened ? filmMat : filmClosedMat);
  g.add(body);
  // end-seal crimps: flattened tabs proud of each L end, spanning the girth
  const esw = seals.endSealWidth || 0;
  if(esw > 0){
    const crimp = new THREE.BoxGeometry(esw, H * 0.9, W * 0.96);
    for(const sx of [ (L + esw)/2, -(L + esw)/2 ]){
      const m = new THREE.Mesh(crimp, sealMat); m.position.set(sx, 0, 0); g.add(m);
    }
  }
  // fin seal along the top-back, running the length; standing or folded flat
  const fh = seals.finHeight || 0;
  if(seals.sealType !== 'lap' && fh > 0){
    const standing = seals.finTreatment === 'standing';
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.96, standing ? fh : Math.max(fh * 0.15, 0.4), standing ? Math.max(fh * 0.12, 0.4) : fh),
      sealMat);
    fin.position.set(0, H/2 + (standing ? fh/2 : 0), W/2 - (standing ? Math.max(fh * 0.06, 0.2) : fh/2));
    g.add(fin);
  }
  return g;
}

function pieceGeo(piece, stackAxis, o){
  if(piece.kind === 'cylinder'){
    const geo = new THREE.CylinderGeometry(piece.diameter/2, piece.diameter/2, piece.thickness * 0.94, 24);
    const slot = o.indexOf(ENV_AXIS[stackAxis]);          // where the cylinder axis lands
    let rot = null;
    if(slot === 0) rot = new THREE.Matrix4().makeRotationZ(Math.PI/2);
    else if(slot === 1) rot = new THREE.Matrix4().makeRotationX(Math.PI/2);
    return {geo, rot};
  }
  const d = [piece.L, piece.W, piece.H];
  return {geo: new THREE.BoxGeometry(d[IDX[o[0]]] * 0.97, d[IDX[o[2]]] * 0.97, d[IDX[o[1]]] * 0.97), rot: null};
}

/* ---------- recursive build ---------- */

// tiers, outer→inner. Each returns a Group representing ONE unit.
// `sel` holds the opened child index per tier; `depthTiers` is the visible chain.
function buildWrapOpened(bundle){
  // an opened wrap: translucent conforming film + all pieces inside
  const g = new THREE.Group();
  const {envelope, pieces, piece, stackAxis} = bundle.wraps;
  const o = 'LWH';                                         // pieces already in envelope frame
  g.add(wrapBody(envelope, bundle.wraps.seals, true));
  const {geo, rot} = pieceGeo(piece, stackAxis, o);
  const inst = new THREE.InstancedMesh(geo, pieceMat, pieces.length);
  const M = new THREE.Matrix4();
  pieces.forEach((pl, i) => {
    const pos = new THREE.Vector3(pl.x, -envelope.H/2 + pl.z, pl.y);
    if(rot) M.copy(rot); else M.identity();
    M.setPosition(pos.x, pos.y, pos.z);
    inst.setMatrixAt(i, M);
  });
  g.add(inst);
  return g;
}

function closedWrap(bundle){
  const g = new THREE.Group();
  g.add(wrapBody(bundle.wraps.envelope, bundle.wraps.seals, false));
  return g;
}

// group placements by orientation string
function groupByOrientation(placements, skipIdx){
  const m = new Map();
  placements.forEach((pl, i) => {
    if(i === skipIdx) return;
    if(!m.has(pl.orientation)) m.set(pl.orientation, []);
    m.get(pl.orientation).push({pl, i});
  });
  return m;
}

// generic: a container tier holding children, one opened, the rest closed.
// Rigid children (cartons, cases) instance as one mesh per orientation; wrap
// children are multi-mesh film bodies (film + fin + crimps) placed
// individually — counts here are wrapsPerCarton, tiny by construction.
function buildContainer(tier, bundle, sel, path){
  const g = new THREE.Group();
  const {geo, children, childKind} = tier;
  g.add(cutawayBox(geo.outer, geo.inner, tier.mat));

  const openIdx = clampIdx(sel[tier.name], children);
  const parentInnerH = geo.inner.H;

  if(childKind === 'wrap'){
    children.forEach((pl, i) => {
      if(i === openIdx) return;
      const wb = closedWrap(bundle);
      wb.position.copy(childPos(pl, parentInnerH));
      wb.quaternion.copy(orientQuat(pl.orientation));
      g.add(wb);
    });
  }else{
    for(const [o, list] of groupByOrientation(children, openIdx)){
      const od = orient(tier.childOuter, o);
      const cg = roundedBoxGeo(Math.max(od.l - 1, 1), Math.max(od.h - 1, 1), Math.max(od.w - 1, 1), 2, 2);
      const inst = new THREE.InstancedMesh(cg, tier.childMat, list.length);
      const M = new THREE.Matrix4();
      list.forEach(({pl}, k) => { M.identity(); M.setPosition(...childPos(pl, parentInnerH).toArray()); inst.setMatrixAt(k, M); });
      // a closed CHILD is pickable; opening it sets the child tier's selection
      inst.userData = {pick: list.map(x => x.i), tierName: tier.childKind};
      pickables.push({mesh: inst, tier: tier.name});
      g.add(inst);
    }
  }

  // the one opened child, recursed
  if(children[openIdx]){
    const pl = children[openIdx];
    const childGroup = tier.buildChild(bundle, sel, path.concat(openIdx));
    childGroup.position.copy(childPos(pl, parentInnerH));
    childGroup.quaternion.copy(orientQuat(pl.orientation));
    g.add(childGroup);
  }
  return g;
}

function clampIdx(i, arr){ return Math.min(Math.max(i | 0, 0), Math.max(arr.length - 1, 0)); }

// pick the top layer child nearest the camera (default open channel)
function nearestTopCorner(children, parentInnerH){
  if(!children.length) return 0;
  const cam = getCamera();
  let best = 0, bestScore = -Infinity;
  const maxZ = Math.max(...children.map(c => c.z));
  children.forEach((c, i) => {
    const top = c.z > maxZ - 1e-6 ? 1e6 : 0;                // strongly prefer the top layer
    const p = childPos(c, parentInnerH);
    const score = top + (cam ? p.clone().normalize().dot(cam.position.clone().normalize()) : 0);
    if(score > bestScore){ bestScore = score; best = i; }
  });
  return best;
}

/* ---------- public: build for a depth + selection ---------- */

const DEPTHS = ['product', 'wrap', 'carton', 'case', 'pallet'];

export function buildHierarchy(bundle, depth, sel){
  const pivot = getPivot();
  clear();
  group = new THREE.Group();
  sel = sel || {};

  // tier descriptors (inner→outer wiring). childOuter is the child's OUTER dims.
  const cartonTier = {
    name: 'carton', geo: bundle.cartonGeo, mat: board, childKind: 'wrap',
    children: bundle.wraps.placements, childOuter: bundle.wrapGeo.outer, childMat: filmClosedMat,
    buildChild: (b, s, path) => buildWrapOpened(b)
  };
  const caseTier = {
    name: 'case', geo: bundle.caseGeo, mat: board, childKind: 'carton',
    children: bundle.cartons.placements, childOuter: bundle.cartonGeo.outer, childMat: board2,
    buildChild: (b, s, path) => buildContainer(cartonTier, b, s, path)
  };

  // default openings (nearest top corner) where unset
  const defaults = {
    case: nearestTopCorner(bundle.cartons.placements, bundle.caseGeo.inner.H),
    carton: nearestTopCorner(bundle.wraps.placements, bundle.cartonGeo.inner.H)
  };
  const S = {case: sel.case ?? defaults.case, carton: sel.carton ?? defaults.carton, wrap: 0};

  let span = 100, opened = {};
  if(depth === 'product'){
    const p = bundle.wraps.piece;
    const {geo} = pieceGeo(p, bundle.wraps.stackAxis, 'LWH');
    group.add(new THREE.Mesh(geo, pieceMat));
    span = p.kind === 'cylinder' ? p.diameter : Math.max(p.L, p.W, p.H);
  }else if(depth === 'wrap'){
    group.add(buildWrapOpened(bundle));
    const e = bundle.wraps.envelope; span = Math.max(e.L, e.W, e.H);
  }else if(depth === 'carton'){
    group.add(buildContainer(cartonTier, bundle, S, []));
    opened = {wrap: S.wrap};
    const o = bundle.cartonGeo.outer; span = Math.max(o.L, o.W, o.H);
  }else if(depth === 'case'){
    group.add(buildContainer(caseTier, bundle, S, []));
    opened = {carton: S.carton, wrap: S.wrap};
    const o = bundle.caseGeo.outer; span = Math.max(o.L, o.W, o.H);
  }else if(depth === 'pallet'){
    span = buildPallet(bundle, caseTier, S);
    opened = {case: S.case, carton: S.carton, wrap: S.wrap};
  }

  pivot.add(group);
  setCamSpan(span);
  registerFrame();
  return {opened: S, span, counts: bundle.counts};
}

function buildPallet(bundle, caseTier, S){
  const {caseGeo, cases} = bundle;
  const co = caseGeo.outer;
  const layers = Math.max(...cases.placements.map(p => Math.round(p.z / co.H))) + 1;
  const loadH = layers * co.H;
  const deckH = bundle.cases.deck.baseH;
  const openIdx = S.case ?? nearestTopCorner(cases.placements, loadH);

  // deck slab
  const deck = new THREE.Mesh(new THREE.BoxGeometry(bundle.cases.deck.L, deckH, bundle.cases.deck.W), deckMat);
  deck.position.y = deckH/2;
  group.add(deck);

  // closed cases (instanced per orientation), opened one recursed
  for(const [o, list] of groupByOrientation(cases.placements, openIdx)){
    const od = orient(co, o);
    const cgeo = roundedBoxGeo(Math.max(od.l - 2, 1), Math.max(od.h - 2, 1), Math.max(od.w - 2, 1), 3, 2);
    const inst = new THREE.InstancedMesh(cgeo, board, list.length);
    const M = new THREE.Matrix4();
    list.forEach(({pl}, k) => { M.identity(); M.setPosition(pl.x, deckH + pl.z, pl.y); inst.setMatrixAt(k, M); });
    inst.userData = {pick: list.map(x => x.i), tierName: 'case'};
    pickables.push({mesh: inst, tier: 'case'});
    group.add(inst);
  }
  if(cases.placements[openIdx]){
    const pl = cases.placements[openIdx];
    const cg = buildContainer(caseTier, bundle, S, [openIdx]);
    cg.position.set(pl.x, deckH + pl.z, pl.y);
    cg.quaternion.copy(orientQuat(pl.orientation));
    group.add(cg);
  }
  group.position.y = -(deckH + loadH)/2;
  return Math.max(bundle.cases.deck.L, bundle.cases.deck.W, loadH);
}

/* ---------- per-frame cutaway: hide walls facing the camera ---------- */

function registerFrame(){
  if(disposeFrame) return;
  const wp = new THREE.Vector3(), wn = new THREE.Vector3(), q = new THREE.Quaternion(), toCam = new THREE.Vector3();
  disposeFrame = onFrame(cam => {
    if(!group || !group.visible) return;
    for(const {mesh, n} of cutawayWalls){
      mesh.getWorldPosition(wp); mesh.getWorldQuaternion(q);
      wn.copy(n).applyQuaternion(q);
      toCam.copy(cam.position).sub(wp);
      mesh.visible = wn.dot(toCam) <= 0;                   // hide walls that face the camera
    }
  });
}

/* ---------- picking ---------- */

/** Ray-pick a unit; returns {tier, index} or null. */
export function pick(nx, ny){
  const cam = getCamera(); if(!cam || !group) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
  const meshes = pickables.filter(p => p.mesh.visible).map(p => p.mesh);
  const hits = ray.intersectObjects(meshes, false);
  for(const h of hits){
    const ud = h.object.userData;
    if(ud && ud.pick){
      const idx = h.instanceId != null ? ud.pick[h.instanceId] : ud.pick[0];
      return {tier: ud.tierName, index: idx};
    }
  }
  return null;
}

export function show(v){ if(group) group.visible = v; }
export function isBuilt(){ return !!group; }

function clear(){
  const pivot = getPivot();
  if(group){ pivot.remove(group); group.traverse(o => { if(o.geometry) o.geometry.dispose(); }); }
  group = null; cutawayWalls = []; pickables = [];
}

export function dispose(){ clear(); if(disposeFrame){ disposeFrame(); disposeFrame = null; } }
