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

/* ---------- flow-wrap geometry: conforming pillow body + tapered, crimped
   ends. Dimensional truth: the overall bounding box of body+tapers always
   equals the wrap style's own outer L×W×H (flowwrap.js's L+2*endSealWidth
   compensation; H+finHeight is added separately by the unchanged fin mesh,
   exactly as before). The pillow rounding, the taper, and the fin's
   serration are cosmetic geometry INSIDE that envelope — nothing here
   invents or alters a dimension. ---------------------------------------- */

const WRAP_N = 20;           // profile sample count per loft ring
const WRAP_SERR = 9;         // serration cycles around the crimped fin tip
const WRAP_SERR_AMT = 0.16;  // serration amplitude, fraction of the tip's own half-size
const PIECE_SHRINK = 0.03;   // conservative render-only clearance every piece gets (pieceGeo's smaller margin)

/**
 * A safe corner-fillet radius for the film's rounded-rectangle cross-section
 * — small enough that no product corner can poke through it, computed from
 * the ACTUAL per-piece clearance rather than a fraction of the envelope.
 *
 * A Z-stack of N layers divides envelope.H by N to get back to one piece's
 * own thickness; that piece still only gets pieceGeo's ~3% render shrink,
 * so the true margin at the OUTERMOST layer is (envelope.H/N)*PIECE_SHRINK/2
 * — independent of how tall the whole stack is. Using envelope.H directly
 * (as an early version of this did) makes the fillet grow with the stack
 * while the real margin doesn't, so for enough layers the fillet eventually
 * cuts back into the product. Same reasoning for nx/ny in the plan axes.
 * Halved again for headroom; never above the envelope's own 25%.
 */
function safeFillet(envelope, stackAxis, nx, ny, layers, axisIsW){
  const divH = stackAxis === 'Z' ? Math.max(1, layers) : 1;
  // the CROSS dimension (paired with H in the ring) is whichever of true
  // L/W is NOT the machine direction — divided by whichever of nx/ny
  // subdivides IT (plus the stack layers, if the stack axis runs across it)
  const crossDim = axisIsW ? envelope.L : envelope.W;
  const divCross = axisIsW
    ? nx*(stackAxis === 'X' ? Math.max(1, layers) : 1)
    : ny*(stackAxis === 'Y' ? Math.max(1, layers) : 1);
  const marginH = (envelope.H/divH)/2*PIECE_SHRINK;
  const marginCross = (crossDim/divCross)/2*PIECE_SHRINK;
  return 0.5*Math.min(marginH, marginCross);
}

/**
 * One closed ring of profile points, in the wrap's local Y-Z cross-section.
 *
 * roundish: a true ellipse (hH,hW half-axes) — safe ONLY when the actual
 * cross-section is genuinely round (a single cylindrical slug wrapped with
 * its own axis as the pack length), since an ellipse with the same
 * half-axes exactly circumscribes the circle it's built from.
 *
 * Otherwise: a ROUNDED RECTANGLE (flat sides + a small corner fillet), not
 * a superellipse. This distinction is load-bearing, not cosmetic: a box, or
 * a cylinder lying with its axis vertical (whose Y-Z slice is itself a
 * rectangle, not a circle), has REAL material out to its own full extent
 * along an entire flat face — at the piece's own top edge, a puck's disc is
 * still full-diameter, it doesn't taper. A superellipse tapers its w extent
 * to ZERO at h=hH for every finite exponent, so any product spanning the
 * full height/width at a real (non-zero) width there pokes straight through
 * it — verified against the actual rendered vertex data (see commit notes).
 * A rounded rectangle's flat sides touch hH/hW exactly, with only a small
 * fillet cut at the four corners, sized by the CALLER (fillet(hH,hW) —
 * see safeFillet) from the actual per-piece clearance, not a fixed fraction
 * of the envelope: a Z-stack of many thin layers has a piece-to-piece
 * margin that shrinks with layer count while the envelope grows, so a
 * fillet sized off hH/hW alone (as this used to be) can outgrow that
 * shrinking margin and cut back into the product — confirmed empirically.
 *
 * `axisIsW` places the ring for the case where the WRAP's machine direction
 * is true W, not true L: the loft still varies its own local "pos" as it
 * runs along the pack length, but that position now lands on local Z, not
 * X, with the ring's "w" coordinate (paired with h=true H) landing on X
 * instead. The piece-placement convention elsewhere (render-local X=true L,
 * Y=true H, Z=true W) never changes — only which local axis THIS shape
 * treats as its own "length" varies, so the end seals and fin land on
 * whichever true axis is actually the machine direction, in every
 * containment orientation.
 */
function ringPoints(pos, hH, hCross, roundish, serrate, fillet, axisIsW){
  const pts = [];
  const wobble = (h, w, a) => {
    if(!serrate) return [h, w];
    const m = 1 + WRAP_SERR_AMT*Math.sin(a*WRAP_SERR);
    return [h*m, w*m];
  };
  const place = (h, w) => axisIsW ? new THREE.Vector3(w, h, pos) : new THREE.Vector3(pos, h, w);
  if(roundish){
    for(let k = 0; k < WRAP_N; k++){
      const a = k/WRAP_N*Math.PI*2;
      const [h, w] = wobble(Math.cos(a)*hH, Math.sin(a)*hCross, a);
      pts.push(place(h, w));
    }
    return pts;
  }
  const r = Math.max(0.0005, Math.min(fillet, 0.25*Math.min(hH, hCross)));
  const segs = Math.max(1, Math.round(WRAP_N/4));
  const centers = [[hH - r, hCross - r], [-(hH - r), hCross - r], [-(hH - r), -(hCross - r)], [hH - r, -(hCross - r)]];
  for(let ci = 0; ci < 4; ci++){
    const [cx, cy] = centers[ci];
    for(let i = 0; i < segs; i++){
      const a = ci*(Math.PI/2) + i/segs*(Math.PI/2);
      const [h, w] = wobble(cx + r*Math.cos(a), cy + r*Math.sin(a), a);
      pts.push(place(h, w));
    }
  }
  return pts;
}

// hand-built loft: N-point rings connected by quads, capped at both ends.
// Every material in this file is DoubleSide, so winding direction only
// affects computeVertexNormals()'s lighting side, never visibility.
function loftGeometry(rings){
  const N = rings[0].length;
  const pos = [];
  rings.forEach(r => r.forEach(p => pos.push(p.x, p.y, p.z)));
  const idx = (ri, k) => ri*N + (k % N);
  const indices = [];
  for(let r = 0; r < rings.length - 1; r++)
    for(let k = 0; k < N; k++){
      const a = idx(r, k), b = idx(r, k + 1), c = idx(r + 1, k), d = idx(r + 1, k + 1);
      indices.push(a, c, b,  b, c, d);
    }
  function cap(ri, flip){
    const base = pos.length/3;
    let cx = 0, cy = 0, cz = 0;
    rings[ri].forEach(p => { cx += p.x; cy += p.y; cz += p.z; });
    cx /= N; cy /= N; cz /= N;
    pos.push(cx, cy, cz);
    for(let k = 0; k < N; k++){
      const a = ri*N + k, b = ri*N + ((k + 1) % N);
      indices.push(base, flip ? b : a, flip ? a : b);
    }
  }
  cap(0, true); cap(rings.length - 1, false);
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Body (constant cross-section over the product span, along whichever true
 *  axis is the resolved machine direction) + two end tapers (shoulder at
 *  the pack's own end -> crimped fin tip endSealWidth further out — each
 *  taper spans EXACTLY endSealWidth, so body+tapers together span
 *  machineDim + 2*endSealWidth = the wrap's true outer dimension on that
 *  axis). envelope = the TRUE collation/product envelope (never permuted —
 *  the permutation lives in project.js, on the way into flowwrap.js only);
 *  wrapAxis ('L'|'W') says which of envelope.L/W is that machine direction,
 *  never H. The pillow rounding, the taper, and the fin's serration are
 *  cosmetic geometry INSIDE that envelope — nothing here invents or alters
 *  a dimension. */
function wrapPartsGeometry(envelope, seals, roundish, stackInfo, wrapAxis){
  const axisIsW = wrapAxis === 'W';
  const H = envelope.H;
  const lenDim = axisIsW ? envelope.W : envelope.L;      // machine direction — where the seals/fin go
  const crossDim = axisIsW ? envelope.L : envelope.W;    // the OTHER horizontal axis
  const esw = Math.max(seals.endSealWidth || 0, 0.01);
  const gaugeMM = Math.max((seals.gauge || 0)/1000, 0.01);
  const finThk = Math.max(gaugeMM*2, 0.15);        // ~2x film gauge, floored only for visibility
  const finW = crossDim*0.42;                      // pinched tip width — cosmetic, stays inside crossDim
  const fillet = safeFillet(envelope, stackInfo.stackAxis, stackInfo.nx, stackInfo.ny, stackInfo.layers, axisIsW);

  const hH = H/2, hCross = crossDim/2;   // body half-dims — every taper ring stays AT OR INSIDE these, never bulges past them
  const bodyGeo = loftGeometry([
    ringPoints(-lenDim/2, hH, hCross, roundish, false, fillet, axisIsW),
    ringPoints( lenDim/2, hH, hCross, roundish, false, fillet, axisIsW)
  ]);

  function taper(sign){
    // shoulder -> neck: the actual taper, over a SHORT run (35% of esw) so
    // it reads as a pinch, not a cone stretched over the full seal width.
    // neck -> tip: constant cross-section (finThk/finW at BOTH rings) — a
    // genuinely flat tab, not a further narrowing wedge. Serration only at
    // the cut tip, so the flat run shows a crimped edge, not a smooth cone.
    const shoulder = sign*(lenDim/2), tip = sign*(lenDim/2 + esw);
    const neck = shoulder + (tip - shoulder)*0.35;
    const rings = [
      ringPoints(shoulder, hH, hCross, roundish, false, fillet, axisIsW),
      ringPoints(neck, finThk/2, finW/2, roundish, false, fillet, axisIsW),
      ringPoints(tip, finThk/2, finW/2, roundish, true, fillet, axisIsW)
    ];
    return loftGeometry(sign > 0 ? rings : rings.slice().reverse());
  }
  return {bodyGeo, taperPos: taper(1), taperNeg: taper(-1)};
}

/** The fin seal: a solid tab lying FLUSH against the chosen face (back by
 *  default), running the full pack length along the MACHINE direction
 *  (wrapAxis — true L or true W, never H), standing `finHeight` proud of
 *  that face when the treatment is standing, or lying flat (a thin visible
 *  sliver, floored for visibility) when folded. `finSealBand` is the tab's
 *  width across the OTHER horizontal axis, centred on it — never collapsed
 *  to a zero-thickness plane, so it can't read as a line from any angle,
 *  and it moves with the wrap under every orientation because it's baked
 *  into the geometry, not positioned post-hoc. */
function wrapFinGeometry(envelope, seals, wrapAxis){
  const axisIsW = wrapAxis === 'W';
  const H = envelope.H;
  const lenDim = axisIsW ? envelope.W : envelope.L;
  const crossDim = axisIsW ? envelope.L : envelope.W;
  const fh = seals.finHeight || 0;
  if(seals.sealType === 'lap' || fh <= 0) return null;
  const standing = seals.finTreatment === 'standing';
  const proud = standing ? fh : T_FLOOR;                     // how far it stands off the face
  const face = seals.finFace || 'back';
  const band = Math.max(1, Math.min(seals.finSealBand || H*0.3, face === 'top' ? crossDim : H));
  let geo;
  if(face === 'top'){
    // proud stands up in Y off the top face; length runs along whichever
    // local axis (X or Z) the machine direction maps to
    geo = axisIsW ? new THREE.BoxGeometry(band, proud, lenDim) : new THREE.BoxGeometry(lenDim, proud, band);
    geo.translate(0, H/2 + proud/2, 0);
  }else{
    const sign = face === 'front' ? 1 : -1;                  // back (default) or front
    if(axisIsW){
      geo = new THREE.BoxGeometry(proud, band, lenDim);      // proud stands out in X, length runs in Z
      geo.translate(sign*(crossDim/2 + proud/2), 0, 0);
    }else{
      geo = new THREE.BoxGeometry(lenDim, band, proud);      // proud stands out in Z, length runs in X
      geo.translate(0, 0, sign*(crossDim/2 + proud/2));
    }
  }
  return geo;
}

// true when the collation is a single cylindrical slug wrapped along its OWN
// axis — the one case where slicing the wrap's cross-section actually cuts
// a circle. That means the collation's stack axis must align with the
// RESOLVED machine direction (wrapAxis 'L' -> collation axis 'X', 'W' ->
// collation axis 'Y'), not just be 'X' unconditionally: a cylinder lying
// with its axis vertical ('Z', a puck) or across the OTHER horizontal axis
// has a rectangular cross-section slice (thickness x diameter) just like a
// box — verified against rendered vertex data: without this check, a
// Z-axis puck's full-diameter edge poked straight through an ellipse
// profile that tapers to zero at the top/bottom of its own height.
function isRoundishWrap(w){
  const requiredStackAxis = w.wrapAxis === 'W' ? 'Y' : 'X';
  return w.piece.kind === 'cylinder' && w.nx === 1 && w.ny === 1 && w.stackAxis === requiredStackAxis;
}

// {stackAxis, nx, ny, layers} for safeFillet — layers is the per-plan-cell
// piece count (perStack in collation.js terms), read back from the
// placement count rather than threaded separately through the model.
function stackInfoOf(w){
  return {stackAxis: w.stackAxis, nx: w.nx, ny: w.ny, layers: w.pieces.length/(w.nx*w.ny)};
}

/** Assemble one wrap (body + 2 tapers + fin) as ordinary Meshes — used for
 *  the single opened wrap. Closed (repeated) wraps use the instanced path
 *  in buildContainer instead, sharing these same geometries. */
function buildWrapMeshes(envelope, seals, roundish, stackInfo, wrapAxis, opened){
  const parts = wrapPartsGeometry(envelope, seals, roundish, stackInfo, wrapAxis);
  const finGeo = wrapFinGeometry(envelope, seals, wrapAxis);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(parts.bodyGeo, opened ? filmMat : filmClosedMat));
  g.add(new THREE.Mesh(parts.taperPos, sealMat));
  g.add(new THREE.Mesh(parts.taperNeg, sealMat));
  if(finGeo) g.add(new THREE.Mesh(finGeo, sealMat));
  return g;
}

function pieceGeo(piece, stackAxis, o){
  if(piece.kind === 'cylinder'){
    // both dims get the same ~3% render-only clearance shrink as a box piece
    // (never a dimensional change — pieceGeo only feeds the product mesh,
    // not the wrap/carton/case sizing math) so safeFillet's PIECE_SHRINK
    // constant matches the actual margin on every axis
    const geo = new THREE.CylinderGeometry(piece.diameter/2*0.97, piece.diameter/2*0.97, piece.thickness*0.94, 24);
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
  g.add(buildWrapMeshes(envelope, bundle.wraps.seals, isRoundishWrap(bundle.wraps), stackInfoOf(bundle.wraps), bundle.wraps.wrapAxis, true));
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
// Both rigid children (cartons, cases) and wrap children instance — one
// InstancedMesh per PART (body/taperPos/taperNeg/fin) for wraps, since a
// wrap's shape doesn't vary by orientation the way a box's rendered
// geometry does; the rotation is baked into each instance's own matrix.
function buildContainer(tier, bundle, sel, path){
  const g = new THREE.Group();
  const {geo, children, childKind} = tier;
  g.add(cutawayBox(geo.outer, geo.inner, tier.mat));

  const openIdx = clampIdx(sel[tier.name], children);
  const parentInnerH = geo.inner.H;

  if(childKind === 'wrap'){
    const w = bundle.wraps;
    const parts = wrapPartsGeometry(w.envelope, w.seals, isRoundishWrap(w), stackInfoOf(w), w.wrapAxis);
    const finGeo = wrapFinGeometry(w.envelope, w.seals, w.wrapAxis);
    const closed = children.map((pl, i) => ({pl, i})).filter(x => x.i !== openIdx);
    if(closed.length){
      const partDefs = [
        {geo: parts.bodyGeo, mat: filmClosedMat},
        {geo: parts.taperPos, mat: sealMat},
        {geo: parts.taperNeg, mat: sealMat}
      ];
      if(finGeo) partDefs.push({geo: finGeo, mat: sealMat});
      for(const pd of partDefs){
        const inst = new THREE.InstancedMesh(pd.geo, pd.mat, closed.length);
        const M = new THREE.Matrix4();
        closed.forEach(({pl}, k) => {
          M.makeRotationFromQuaternion(orientQuat(pl.orientation));
          const p = childPos(pl, parentInnerH);
          M.setPosition(p.x, p.y, p.z);
          inst.setMatrixAt(k, M);
        });
        // a closed wrap is pickable too — click it to open it, same as any
        // other level's closed child
        inst.userData = {pick: closed.map(x => x.i), tierName: 'wrap'};
        pickables.push({mesh: inst, tier: tier.name});
        g.add(inst);
      }
    }
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
