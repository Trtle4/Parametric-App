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
import {orientBasis} from './orient.js';

const T_FLOOR = 0.6;                    // min rendered wall thickness, mm
const IDX = {L: 0, W: 1, H: 2};
const ENV_AXIS = {X: 'L', Y: 'W', Z: 'H'};

// Colors chosen to be mutually distinct and, for film, clear of the CREASE
// blue (#3E63DD) used in the 2D dieline. Seals are warm orange so they never
// collide with any blue. The LEGEND export keeps the HUD swatches in sync.
const C_PRODUCT = 0xE0C089, C_FILM = 0x8FD4C4, C_SEAL = 0xE08A2E, C_BOARD = 0xC69C6D;
export const LEGEND = [
  {name: 'Product',           hex: '#E0C089'},
  {name: 'Film',              hex: '#8FD4C4'},
  {name: 'Fin seal',          hex: '#E08A2E'},
  {name: 'End seal',          hex: '#E08A2E'},
  {name: 'Board (carton/case)', hex: '#C69C6D'}
];

const board   = kraft;                  // case/carton board (opaque)
const board2  = kraft2;
const pieceMat = new THREE.MeshStandardMaterial({color: C_PRODUCT, roughness: 0.75, metalness: 0});
const filmMat = new THREE.MeshStandardMaterial({color: C_FILM, roughness: 0.25, metalness: 0,
  transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false});
const filmClosedMat = new THREE.MeshStandardMaterial({color: C_FILM, roughness: 0.25, metalness: 0,
  transparent: true, opacity: 0.7, side: THREE.DoubleSide});
const sealMat = new THREE.MeshStandardMaterial({color: C_SEAL, roughness: 0.5, metalness: 0, side: THREE.DoubleSide});
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

// world rotation that stands a child (local x=L, y=H, z=W) into orientation o.
// orientBasis guarantees a PROPER rotation (det +1) for all six orientations,
// never a reflection — a reflected body is a mirrored dieline.
function orientQuat(o){
  const [cx, cy, cz] = orientBasis(o);
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...cx), new THREE.Vector3(...cy), new THREE.Vector3(...cz));
  return new THREE.Quaternion().setFromRotationMatrix(m);
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

/** A wrap body: rounded conforming surface over the collation envelope, plus
 *  the seals drawn at their TRUE model dimensions.
 *
 *  end-seal crimp: L-extent = endSealWidth (the exact per-end L compensation),
 *    over the pack end face (envelope W × H). Nothing eyeballed.
 *  fin seal: stands finHeight proud (exact — the H compensation for a standing
 *    fin), runs the full pack length L. Its ONLY non-true dimension is
 *    thickness, which is film gauge (sub-visible) rendered at a floor and
 *    labelled as such in the report — it is film, not a seal parameter.
 *  Fin sits on the back face by default (seals.finFace: 'back'|'top'|'front'). */
function wrapBody(envelope, seals, opened){
  const g = new THREE.Group();
  const {L, W, H} = envelope;
  g.add(new THREE.Mesh(roundedBoxGeo(L, H, W, Math.min(W, H) * 0.22, 3), opened ? filmMat : filmClosedMat));

  const esw = seals.endSealWidth || 0;
  if(esw > 0){
    const crimp = new THREE.BoxGeometry(esw, H, W);         // true endSealWidth × pack end face
    for(const sx of [ (L + esw)/2, -(L + esw)/2 ]){
      const m = new THREE.Mesh(crimp, sealMat); m.position.set(sx, 0, 0); g.add(m);
    }
  }

  const fh = seals.finHeight || 0;
  if(seals.sealType !== 'lap' && fh > 0){
    const standing = seals.finTreatment === 'standing';
    const thick = T_FLOOR;                                  // film gauge — not to scale (only non-true dim)
    const proud = standing ? fh : thick;                    // standing: true finHeight; folded: ~flat
    const face = seals.finFace || 'back';
    const zEdge = face === 'front' ? W/2 : face === 'top' ? 0 : -W/2;   // back by default
    const fin = new THREE.Mesh(new THREE.BoxGeometry(L, proud, thick), sealMat);
    fin.position.set(0, H/2 + proud/2, zEdge);
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

// Default open unit: the OUTER-CORNER unit of the top layer nearest the
// camera — the one you can actually see into. Projecting each top-layer
// unit's plan position onto the camera's horizontal direction is maximised
// at the near corner (never an interior/near-face unit); a tiny radial
// tiebreak keeps it a corner when the camera faces straight down an axis.
function nearestCameraCorner(children){
  if(!children.length) return 0;
  const cam = getCamera();
  const maxZ = Math.max(...children.map(c => c.z));
  let cdx = 1, cdy = 1;
  if(cam){ cdx = cam.position.x; cdy = cam.position.z; const n = Math.hypot(cdx, cdy) || 1; cdx /= n; cdy /= n; }
  let best = 0, bestScore = -Infinity;
  children.forEach((c, i) => {
    if(c.z < maxZ - 1e-6) return;                          // top layer only
    const score = (c.x*cdx + c.y*cdy) + 1e-6*(c.x*c.x + c.y*c.y);
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
    children: bundle.wraps ? bundle.wraps.placements : [],
    childOuter: bundle.wrapGeo ? bundle.wrapGeo.outer : bundle.cartonGeo.outer, childMat: filmClosedMat,
    buildChild: (b, s, path) => buildWrapOpened(b)
  };
  const caseTier = {
    name: 'case', geo: bundle.caseGeo, mat: board, childKind: 'carton',
    children: bundle.cartons.placements, childOuter: bundle.cartonGeo.outer, childMat: board2,
    buildChild: (b, s, path) => buildContainer(cartonTier, b, s, path)
  };

  // default openings: outer-corner unit nearest the camera, per level, where
  // the user hasn't clicked an override. Recomputed each build (app rebuilds
  // on pointerup after an orbit, so the channel tracks the near corner).
  const S = {
    case:   sel.case   ?? nearestCameraCorner(bundle.cases.placements),
    carton: sel.carton ?? nearestCameraCorner(bundle.cartons.placements),
    wrap:   sel.wrap   ?? (bundle.wraps ? nearestCameraCorner(bundle.wraps.placements) : 0)
  };

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
  const openIdx = S.case ?? nearestCameraCorner(cases.placements);

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
