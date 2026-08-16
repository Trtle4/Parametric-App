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
import {perfDisplayBody, perfSurfaceLine} from './perf3d.js';
import {isDisplayGeo} from '../core/perf.js';
import {explodeTier} from './explode.js';
import {buildTray3d} from './tray3d.js';
import {packArtGeometry, packArtMaterials, makeArtTexture} from './artwork3d.js';
import {buildGmaPallet} from './palletmesh.js';
import {orientBasis} from './orient.js';

// One shared texture per pack type drives a whole InstancedMesh (one draw call
// for the printed group + one for the caps), so texturing is ~free regardless
// of instance count. This cap is a backstop for pathological counts only: a
// full pallet is ~130 cases, well under it. Beyond the cap the overflow renders
// as flat board and the HUD says so — the same instance-cap discipline the rest
// of this view uses.
export const ART_INSTANCE_CAP = 400;
let artCapped = 0;                       // instances dropped to flat board this build (HUD reads it)
export function artCappedCount(){ return artCapped; }

const T_FLOOR = 0.6;                    // min rendered wall thickness, mm
const IDX = {L: 0, W: 1, H: 2};
const ENV_AXIS = {X: 'L', Y: 'W', Z: 'H'};

// Colors chosen to be mutually distinct and, for film, clear of the CREASE
// blue (#3E63DD) used in the 2D dieline. Seals are warm orange so they never
// collide with any blue. The LEGEND export keeps the HUD swatches in sync.
const C_PRODUCT = 0xE0C089, C_FILM = 0x8FD4C4, C_SEAL = 0xE08A2E, C_BOARD = 0xC69C6D;
const C_WRAP_SOLID = 0xF7F7F5;          // unprinted film — a closed wrap, no seal colouring
export const LEGEND = [
  {name: 'Product',           hex: '#E0C089', cutaway: true},
  {name: 'Film',              hex: '#8FD4C4', cutaway: true},
  {name: 'Fin seal',          hex: '#E08A2E', cutaway: true},
  {name: 'End seal',          hex: '#E08A2E', cutaway: true},
  {name: 'Unprinted film',    hex: '#F7F7F5', solid: true},
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
// A CLOSED wrap as it actually ships: plain unprinted film, opaque, one colour
// end to end — the crimped ends are the same film, not a coloured feature.
const wrapSolidMat = new THREE.MeshStandardMaterial({color: C_WRAP_SOLID, roughness: 0.45, metalness: 0, side: THREE.DoubleSide});
const edgeMat = new THREE.LineBasicMaterial({color: 0x6b5636, transparent: true, opacity: 0.5});
// Shrink film skin: CLEAR wrap, not the teal conforming film — a faint cool-white
// sheen so the contents read cleanly through it. polygonOffset pushes it just in
// front of the pack faces so it never z-fights the cartons/cans it wraps; a light
// specular sells the glossy film. depthWrite off so stacked skins layer without
// hard seams. The skin geometry is inflated a hair (SKIN_MARGIN) past the
// contents for the same anti-z-fight reason.
const shrinkMat = new THREE.MeshStandardMaterial({color: 0xEAF3F5, roughness: 0.12, metalness: 0,
  transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
const SKIN_MARGIN = 2;   // mm the film stands off the bundle it wraps

let group = null;                       // the whole hierarchy scene
let cutawayWalls = [];                  // {mesh, n:Vector3 localOutwardNormal} updated per frame
// When set (by buildSellableCutaway for the shelf), cutawayBox pushes its walls
// here instead of the hierarchy's own list, so the shelf can hide its own near
// walls with its own frame loop without touching the hierarchy scene.
let wallSink = null;
function pushWall(w){ (wallSink || cutawayWalls).push(w); }
let pickables = [];                     // {mesh, path} for click-to-open
let artResources = [];                  // per-build art materials+textures to dispose on clear (avoid leak on every orbit rebuild)
let disposeFrame = null;
let hud = null;

/* ---------- geometry helpers ---------- */

// oriented outer dims of a child given a containment orientation string
function orient(outer, o){ return {l: outer[o[0]], w: outer[o[1]], h: outer[o[2]]}; }

// world rotation that stands a child (local x=L, y=H, z=W) into orientation o.
// orientBasis guarantees a PROPER rotation (det +1) for all six orientations,
// never a reflection — a reflected body is a mirrored dieline.
export function orientQuat(o){
  const [cx, cy, cz] = orientBasis(o);
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...cx), new THREE.Vector3(...cy), new THREE.Vector3(...cz));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// child centre in the parent's local frame (parent cavity centred; z from floor)
function childPos(pl, parentInnerH){ return new THREE.Vector3(pl.x, -parentInnerH/2 + pl.z, pl.y); }

/**
 * Per-tier exploded-view offsets, computed ONCE from the tier's own children
 * + shell so every instance and the shell itself read the same rank set and
 * the same factor. `ex` is `{level, axis, factor}` or null/undefined for "no
 * explosion here" — this tier only explodes when `ex.level` names IT
 * (`tier.name`), so a case explosion doesn't also explode the carton nested
 * inside it unless the carton is independently toggled.
 *
 * `positions`/`extents` are in the render-local frame (x, y=vertical, z) —
 * the SAME frame `childPos` returns and `explodeTier` is written in terms
 * of, so no axis remapping happens anywhere in this file.
 *
 * Returns identity (every offset {x:0,y:0,z:0}) when `ex` doesn't apply, so
 * every call site's shape is identical whether or not explosion is active —
 * the only difference is whether the added vector is zero.
 */
function tierExplode(tier, geo, children, parentInnerH, ex){
  const zeroShell = {x: 0, y: 0, z: 0};
  const identity = {offsets: children.map(() => ({...zeroShell})), shell: zeroShell};
  if(!ex || ex.level !== tier.name || !ex.factor) return identity;
  const positions = children.map(pl => { const p = childPos(pl, parentInnerH); return {x: p.x, y: p.y, z: p.z}; });
  const extents = children.map(pl => {
    const od = orient(tier.childOuter, pl.orientation);
    return {x: od.l, y: od.h, z: od.w};
  });
  const shellExtent = {x: geo.outer.L, y: geo.outer.H, z: geo.outer.W};
  return explodeTier(positions, extents, shellExtent, ex.axis || 'all', ex.factor);
}

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
    pushWall({mesh: m, n: new THREE.Vector3(...w.n)});
  }
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), edgeMat));
  return g;
}

/** A SOLID open tray: base + 4 upright walls, NO top face — opaque board, every
 *  wall shown (not a cutaway). Used wherever a closed style would draw a full
 *  box but the style is open-top (boardLayersTop === 0, e.g. the FEFCO 0300
 *  tray): an open tray has no lid, so it never renders one. */
function openTrayBox(outer, inner, mat){
  const g = new THREE.Group();
  const t = Math.max((outer.L - inner.L) / 2, T_FLOOR);
  const {L, W, H} = outer;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(L, t, W), mat);
  floor.position.y = -H/2 + t/2; g.add(floor);
  const walls = [
    [t, H, W,  L/2 - t/2, 0, 0], [t, H, W, -L/2 + t/2, 0, 0],
    [L, H, t, 0, 0,  W/2 - t/2], [L, H, t, 0, 0, -W/2 + t/2]
  ];
  for(const [wl, wh, wd, px, py, pz] of walls){
    const m = new THREE.Mesh(new THREE.BoxGeometry(wl, wh, wd), mat);
    m.position.set(px, py, pz); g.add(m);
  }
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), edgeMat));
  return g;
}

/** True when a style is open-top (no lid) — the physical fact carried by the
 *  geometry (zero top board layer), never a styleId check. Drives the open
 *  tray/box render everywhere a closed style would show a full box. */
function isOpenTop(geo){ return geo && geo.meta && geo.meta.boardLayersTop === 0; }

// Shrink film: either the standalone Shrink Bundle style, or an open tray with
// the "shrink-wrap this tray" finish on (chain sets meta.shrinkWrapped). Both
// render their contents through a translucent skin; only the bundle has NO rigid
// shell (the tray keeps its open walls inside the film).
function isShrink(geo){ return geo && geo.meta && (geo.meta.style === 'shrinkbundle' || geo.meta.shrinkWrapped); }
function isShrinkBundle(geo){ return geo && geo.meta && geo.meta.style === 'shrinkbundle'; }

// A translucent shrink skin over a bundle: a thin box at L×H×W (centred, floor
// at −H/2 like every unit) in the same conforming film look the wraps use, so
// the contents read clearly THROUGH it. `h` overrides H when the skin must rise
// to the proud contents of an open tray (meta.shrinkLoadedH); omitted for a
// bundle whose own outer.H already IS the content height.
function filmSkin(outer, h){
  const H0 = h != null ? h : outer.H;                     // contents height from the floor
  // inflate a hair past the contents on every side (SKIN_MARGIN) so the clear
  // film reads as a skin OVER the pack, never coplanar with it (no z-fighting),
  // and NO wireframe — the faint translucent faces are the whole skin.
  const skin = new THREE.Mesh(
    new THREE.BoxGeometry(outer.L + 2*SKIN_MARGIN, H0 + 2*SKIN_MARGIN, outer.W + 2*SKIN_MARGIN), shrinkMat);
  skin.position.y = -outer.H/2 + H0/2;                    // floor−margin … content-top+margin
  return skin;
}

/* ---------- flow-wrap geometry: conforming pillow body + angled end seals.
   Each end is a RAMP (film descending from the pack face to the flat crimp
   line, over the jaw clearance) plus a flexible CRIMP TAB laid at the external
   angle. Dimensional truth: the rendered pack length is the CURRENT-angle
   length (flowwrap.js's packLengthAtAngle) — it responds to both sliders, the
   whole point of the feature, so dragging the external slider visibly lengthens
   the pack toward outer.L (the 90°/straight-out max that sizes the carton) and
   dragging the internal slider moves the ramp reach. The jaw clearance and the
   fin's flat length come straight from flowwrap.js's meta.seal (read, never
   recomputed here). The pillow rounding and the crimp taper are cosmetic
   geometry INSIDE that length — nothing here invents a dimension. ---------- */

const WRAP_N = 20;           // profile sample count per loft ring
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
function ringPoints(pos, hH, hCross, roundish, fillet, axisIsW){
  const pts = [];
  const place = (h, w) => axisIsW ? new THREE.Vector3(w, h, pos) : new THREE.Vector3(pos, h, w);
  if(roundish){
    for(let k = 0; k < WRAP_N; k++){
      const a = k/WRAP_N*Math.PI*2;
      pts.push(place(Math.cos(a)*hH, Math.sin(a)*hCross));
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
      pts.push(place(cx + r*Math.cos(a), cy + r*Math.sin(a)));
    }
  }
  return pts;
}

/**
 * The FACETED cross-section of film over a rigid tray, as WRAP_N [h, w]
 * pairs (same count as ringPoints, so body lofts and the seal-ramp collapse
 * pair ring-to-ring with either generator). Film is a membrane in tension:
 * it is STRAIGHT between the things it touches and never bulges, so every
 * arc the pillow profile would draw is wrong here. Contact points, half-
 * profile bottom-up (mirrored about the centreline):
 *
 *   1. flat bottom  — against the tray underside, spanning the drafted-in
 *      BASE width (bottomL/bottomW — the tray is widest at the top);
 *   2. up the drafted sidewall and out over the flange to the LIP CROWN —
 *      the widest contact (outerL/outerW = the envelope cross dim);
 *   3. the lip's own outer face (lipH tall, full width);
 *   4. slope inward and up, lip crown -> the outermost PROUD product tops
 *      (the cells' across-span; along the machine axis it's cellLen);
 *   5. flat top — taut across the product tops, bridging cell to cell,
 *      never dipping between rows.
 *
 * When nothing stands proud (envelope.H == overallH) the film rests on the
 * lip crown instead: facet 4 collapses and the top flat spans the full
 * width — same code path, degenerate corners (zero-length edges are legal
 * in the resample and loft as zero-area quads).
 *
 * All contact dims come from the tray params the chain already carries
 * (bundle.tray.params) and the film envelope — nothing is re-derived. The
 * profile stays exactly inside the envelope: max |w| = hCross, h in
 * [-hH, +hH], so the drawn film still occupies precisely the box the chain
 * sized (the uisync tray-envelope pin measures this).
 *
 * `pick` maps the tray's OWN L/W dims to the placed cross axis: trayOuter
 * swaps L and W when longAxis is 'Y', and the section lives on whichever
 * placed axis is NOT the machine direction (axisIsW ? placed L : placed W).
 */
function traySectionProfile(envelope, p, axisIsW){
  const hH = envelope.H/2;
  const hCross = (axisIsW ? envelope.L : envelope.W)/2;
  const longY = p.longAxis === 'Y';
  const pick = (ownL, ownW) => {
    const placedL = longY ? ownW : ownL, placedW = longY ? ownL : ownW;
    return axisIsW ? placedL : placedW;
  };
  const baseHalf = Math.min(pick(p.bottomL, p.bottomW)/2, hCross - 0.01);
  // outermost product extent: across the cells it's the full cell run
  // (cells + dividers between them); along the tray's own L it's cellLen
  const cellSpan = p.nCells*p.cellWid + (p.nCells - 1)*p.divider;
  const prodHalf = Math.min(pick(p.cellLen, cellSpan)/2, hCross);
  const crownY  = Math.min(-hH + p.overallH, hH);
  const flangeY = Math.max(crownY - p.lipH, -hH);
  const proud = envelope.H > p.overallH + 1e-9;
  const topHalf = proud ? prodHalf : hCross;
  // corner order matches ringPoints's start + winding (top, +w side, then
  // descending h; across the bottom; back up the -w side)
  const corners = [
    [hH, topHalf], [crownY, hCross], [flangeY, hCross], [-hH, baseHalf],
    [-hH, -baseHalf], [flangeY, -hCross], [crownY, -hCross], [hH, -topHalf]
  ];
  return resampleClosed(corners, WRAP_N);
}

/** Resample a closed polygon to exactly N points: every corner is kept
 *  exact (facets stay sharp), the remaining points spread over the edges
 *  proportional to length (largest remainder). Zero-length edges (a
 *  degenerate facet) simply get no interior points. */
function resampleClosed(corners, N){
  const E = corners.length;
  const lens = corners.map((c, i) => {
    const n = corners[(i + 1) % E];
    return Math.hypot(n[0] - c[0], n[1] - c[1]);
  });
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const extra = N - E;
  const raw = lens.map(l => extra*l/total);
  const cnt = raw.map(Math.floor);
  let left = extra - cnt.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - cnt[i], i]).sort((a, b) => b[0] - a[0]);
  for(let k = 0; k < left; k++) cnt[order[k][1]]++;
  const pts = [];
  corners.forEach((c, i) => {
    pts.push(c);
    const n = corners[(i + 1) % E];
    for(let j = 1; j <= cnt[i]; j++){
      const t = j/(cnt[i] + 1);
      pts.push([c[0] + (n[0] - c[0])*t, c[1] + (n[1] - c[1])*t]);
    }
  });
  return pts;
}

/** Place an [h, w] profile as a loft ring at `pos` along the machine axis —
 *  the same local-axis convention as ringPoints (axisIsW: length on Z). */
function profileRing(profile, pos, axisIsW){
  return profile.map(([h, w]) => axisIsW ? new THREE.Vector3(w, h, pos) : new THREE.Vector3(pos, h, w));
}

// hand-built loft: N-point rings connected by quads, capped at both ends.
// Every material in this file is DoubleSide, so winding direction only
// affects computeVertexNormals()'s lighting side, never visibility.
// Optional `ringUVs` (parallel to `rings`, one [u,v] per point) adds a uv
// attribute so a textured material can wrap the loft — the printed-wrap body
// uses it to map the artwork's girth panels; a cap vertex takes its ring's
// average uv (caps are hidden by the ramps, so their uv is immaterial).
function loftGeometry(rings, ringUVs, open){
  const N = rings[0].length;
  // an OPEN ring already carries its own closing point (first and last sit at
  // the same place, with DIFFERENT uv — the seam), so the wrap-around segment
  // must not be generated: it would be a zero-area quad, and worse, it is the
  // segment the girth walk is discontinuous across.
  const segs = open ? N - 1 : N;
  const pos = [], uv = [];
  rings.forEach((r, ri) => r.forEach((p, k) => { pos.push(p.x, p.y, p.z); if(ringUVs) uv.push(ringUVs[ri][k][0], ringUVs[ri][k][1]); }));
  const idx = (ri, k) => ri*N + (k % N);
  const indices = [];
  for(let r = 0; r < rings.length - 1; r++)
    for(let k = 0; k < segs; k++){
      const a = idx(r, k), b = idx(r, k + 1), c = idx(r + 1, k), d = idx(r + 1, k + 1);
      indices.push(a, c, b,  b, c, d);
    }
  function cap(ri, flip){
    const base = pos.length/3;
    let cx = 0, cy = 0, cz = 0;
    rings[ri].forEach(p => { cx += p.x; cy += p.y; cz += p.z; });
    cx /= N; cy /= N; cz /= N;
    pos.push(cx, cy, cz);
    if(ringUVs){ let cu = 0, cv = 0; ringUVs[ri].forEach(t => { cu += t[0]; cv += t[1]; }); uv.push(cu/N, cv/N); }
    for(let k = 0; k < segs; k++){
      const a = ri*N + k, b = ri*N + ((k + 1) % N);
      indices.push(base, flip ? b : a, flip ? a : b);
    }
  }
  cap(0, true); cap(rings.length - 1, false);
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if(ringUVs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Re-open a closed section ring AT THE SEAM — the bottom-face centre, where
 * the fin lands and the girth walk starts and ends.
 *
 * A closed ring has no vertex there and no way to carry two values at one
 * point, so the girth walk had to interpolate its whole range across the ONE
 * segment that spans the bottom face: v swept 0.79 -> 0.21 straight across it.
 * The bottom therefore rendered a mirrored, squashed sweep of SIDE-FRONT-SIDE,
 * and the template's two BACK half-bands and its fin allowance never appeared
 * on the pack at all — artwork the user painted that the model silently threw
 * away. (It hid because the seam is on the face nobody photographs.)
 *
 * The fix is a real discontinuity: the seam point is inserted (interpolated at
 * the w=0 crossing of the bottom edge, never snapped to a neighbour) and
 * DUPLICATED, so the ring starts and ends there and the two copies can carry
 * v = vHi and v = vLo. The band boundaries themselves need no new vertices —
 * they fall on the section corners, which the corner arcs already populate.
 *
 * Shape is unchanged: the inserted point is collinear on a straight edge and
 * the duplicate closes nothing (loftGeometry skips the wrap segment for an
 * open ring), so an UNPRINTED wrap renders exactly as before. Applied to every
 * section ring — body and both ramp ends — printed or not, so the printed and
 * unprinted packs stay the same geometry.
 */
function seamOpenRing(ring, axisIsW){
  const n = ring.length;
  const cross = p => axisIsW ? [p.y, p.x] : [p.y, p.z];   // [h(height), w(cross)]
  let si = -1, t = 0;
  for(let k = 0; k < n; k++){
    const a = cross(ring[k]), b = cross(ring[(k + 1) % n]);
    if(a[0] < 0 && b[0] < 0 && ((a[1] <= 0 && b[1] >= 0) || (a[1] >= 0 && b[1] <= 0)) && a[1] !== b[1]){
      si = k; t = a[1]/(a[1] - b[1]); break;                // fraction along to w = 0
    }
  }
  // no bottom crossing (a degenerate section): open at the first point rather
  // than leaving the caller a ring it cannot walk
  if(si < 0) return ring.map(p => p.clone()).concat([ring[0].clone()]);
  const seam = new THREE.Vector3().lerpVectors(ring[si], ring[(si + 1) % n], t);
  const out = [seam];
  for(let k = 1; k <= n; k++) out.push(ring[(si + k) % n].clone());
  out.push(seam.clone());
  return out;
}

/** Per-point [u,v] for the two body rings so the artwork's girth panels wrap
 *  the real pillow body. u runs across the product span (the L panel run);
 *  v runs around the girth (back½ → side → front → side → back½), measured by
 *  CUMULATIVE PERIMETER (proportional to the artMap's bands, which sum to the
 *  physical perimeter) and started at the SEAM — the bottom-face centre, where
 *  the fin lands and the two back halves meet. The seam is not snapped to a
 *  vertex (the ring has no vertex at the bottom-edge midpoint; snapping to the
 *  nearest one lands ~W/2 off-centre and shifts every band by one back-half).
 *  Instead it's the interpolated w=0 crossing of the bottom segment, so the
 *  front (widest band) lands centred on the top face, upright and unmirrored.
 *  Ring order runs forward from the seam toward −w first, matching the artMap
 *  girth direction, so the panels register without mirroring. */
function bodyRingUVs(rings, am, axisIsW, uPerRing){
  const CW = am.canvas.w, CH = am.canvas.h;
  // −L end reads u0, +L reads u1, and v runs DOWN the canvas as the girth walk
  // advances. Both axes are flipped from the first mapping, which rendered the
  // template rotated exactly 180°: quadrant-sampled at an elevated FRONT view,
  // every corner colour sat diagonally opposite its template position (the
  // "unmirrored" claim in the old comment had been verified from an angle
  // where a 180° turn looks plausible).
  const us = uPerRing || [am.faces[0].u0/CW, am.faces[0].u1/CW];
  const vLo = am.faces[0].v0/CH, vHi = am.faces[am.faces.length - 1].v1/CH;   // girth band region
  return rings.map((ring, ri) => {
    const n = ring.length;
    const cross = p => axisIsW ? [p.y, p.x] : [p.y, p.z];   // [h(height), w(cross)]
    // the ring ARRIVES open at the seam (seamOpenRing), so the walk simply
    // starts at index 0 and runs to the duplicate at the end — no seam search,
    // no modular wrap, and the two seam copies get vHi and vLo as they must
    const cum = [0];
    for(let k = 1; k < n; k++){
      const a = cross(ring[k - 1]), b = cross(ring[k]);
      cum.push(cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[n - 1] || 1;
    return ring.map((p, k) => [us[ri], vHi - cum[k]/total*(vHi - vLo)]);
  });
}

/**
 * The crimp ring's own [w -> v], per face of the flattened section, as a
 * lookup the crimp TAB continues. Reading the ring's own v is what makes the
 * print continuous across the crimp line: the tab is the same web, gathered
 * flat, so it must pick up exactly where the ramp's outer ring left off
 * rather than re-deriving a range of its own.
 *
 * Split into the walk's three monotonic-w runs (seam -> one edge across the
 * bottom, the full top, the other edge back to the seam), which is robust for
 * both the rounded-rectangle and the elliptical section; the top run is the
 * one whose points sit highest. w = 0 is the seam and genuinely two-valued —
 * each bottom run owns its own side of it.
 */
function crimpVLookup(ring, uvs, axisIsW){
  const cross = p => axisIsW ? [p.y, p.x] : [p.y, p.z];
  const runs = [];
  let cur = null, dir = 0;
  for(let k = 0; k < ring.length; k++){
    const [h, w] = cross(ring[k]);
    if(k > 0){
      const dw = w - cross(ring[k - 1])[1];
      if(Math.abs(dw) > 1e-9){
        const d = Math.sign(dw);
        if(dir && d !== dir){ cur = null; }                 // w reversed -> new run
        dir = d;
      }
    }
    if(!cur){ cur = {pts: [], h: 0}; runs.push(cur); }
    cur.pts.push([w, uvs[k][1]]); cur.h += h;
  }
  const usable = runs.filter(r => r.pts.length > 1);
  if(!usable.length) return () => 0;
  const topRun = usable.reduce((a, b) => (b.h/b.pts.length > a.h/a.pts.length ? b : a));
  const interp = pts => {
    const s = pts.slice().sort((a, b) => a[0] - b[0]);
    return w => {
      if(w <= s[0][0]) return s[0][1];
      const last = s[s.length - 1];
      if(w >= last[0]) return last[1];
      for(let i = 1; i < s.length; i++) if(w <= s[i][0]){
        const t = (w - s[i - 1][0])/((s[i][0] - s[i - 1][0]) || 1);
        return s[i - 1][1] + t*(s[i][1] - s[i - 1][1]);
      }
      return last[1];
    };
  };
  const shaped = usable.map(r => {
    const ws = r.pts.map(x => x[0]);
    return {top: r === topRun, min: Math.min(...ws), max: Math.max(...ws), f: interp(r.pts)};
  });
  return (w, isTop) => {
    const cands = shaped.filter(r => r.top === isTop);
    if(!cands.length) return 0;
    const hit = cands.find(r => w >= r.min - 1e-6 && w <= r.max + 1e-6) || cands[0];
    return hit.f(w);
  };
}

/** Opaque printed-wrap body material (the pillow surface carrying the girth
 *  art). Tracked in artResources so the texture is disposed on clear(). */
function wrapArtMat(canvas){
  const m = new THREE.MeshStandardMaterial({map: makeArtTexture(canvas), roughness: 0.55, metalness: 0, side: THREE.DoubleSide});
  artResources.push(m);
  return m;
}

/**
 * THE wrap material rule — one place, every site that draws a wrap.
 *
 * A wrap is drawn in exactly one of two states, and the state is what picks the
 * materials:
 *
 *   OPENED (cutaway)  translucent film, seal zones coloured, contents visible.
 *                     The look-INSIDE view: the film has to be see-through and
 *                     the ramps/crimps have to be legible AS seals.
 *   CLOSED (solid)    what a pack looks like as it ships: opaque, nothing
 *                     showing through, and NO seal colouring, because an
 *                     unprinted flow wrap is plain film from crimp to crimp.
 *                     The orange there was diagramming a closed pack.
 *
 * Artwork replaces the white wherever there IS artwork: white stands in for
 * UNPRINTED film, so hiding an upload would defeat the feature — and it
 * replaces it on EVERY part: printed film runs continuously through the ramp
 * and into the crimp, so the seal parts carry the same texture (their UVs land
 * in the template's RAMP/END SEAL columns), just never the teal/orange seal
 * DIAGRAM colours, which remain cutaway-only.
 *
 * Callers pass the STATE, never a material, so Solid cannot be white at wrap
 * depth and teal inside a case — the same discipline as filmEnv and
 * closedWrapParts, and for the same reason: the moment a second site picks its
 * own material, the two drift.
 *
 * @param {boolean} opened  true = the cutaway, false = a closed pack
 * @param {{am:object, canvas:HTMLCanvasElement}|null} [artInfo]
 * @returns {{body: THREE.Material, seal: THREE.Material}}
 */
function wrapMaterials(opened, artInfo){
  if(opened) return {body: filmMat, seal: sealMat};
  const printed = !!(artInfo && artInfo.canvas);
  if(!printed) return {body: wrapSolidMat, seal: wrapSolidMat};
  const art = wrapArtMat(artInfo.canvas);   // ONE texture, shared by every part
  return {body: art, seal: art};
}

/** The wrap's artwork for this bundle, or null — read from the bundle itself so
 *  every closed-wrap site gets the same answer without threading it through. */
function wrapArtOf(bundle){
  const geo = bundle && bundle.wrapGeo, canvas = bundle && bundle.art && bundle.art.wrap;
  const am = (geo && geo.meta.artMap && !geo.meta.artMap.flat) ? geo.meta.artMap : null;
  return (am && canvas) ? {am, canvas} : null;
}

/** Body (constant cross-section over the product span, along whichever true
 *  axis is the resolved machine direction) + two end tapers (shoulder at
 *  the pack's own end -> crimped fin tip endSealWidth further out — each
 *  taper spans EXACTLY endSealWidth, so body+tapers together span
 *  machineDim + 2*endSealWidth = the wrap's true outer dimension on that
 *  axis). envelope = the TRUE collation/product envelope (never permuted —
 *  the permutation lives in project.js, on the way into flowwrap.js only);
 *  wrapAxis ('L'|'W') says which of envelope.L/W is that machine direction,
 *  never H. The pillow rounding, the taper, and the crimp fin are
 *  cosmetic geometry INSIDE that envelope — nothing here invents or alters
 *  a dimension. */
function wrapPartsGeometry(envelope, seals, roundish, stackInfo, wrapAxis, artInfo, tray){
  const axisIsW = wrapAxis === 'W';
  // film over a rigid tray: the faceted taut-membrane section replaces both
  // the pillow's rounded rectangle AND the roundish ellipse (a 1x1 on-edge
  // slug collation is roundish on its own, but once it rides in a tray the
  // film wraps the TRAY — rectangular, faceted, never a tube)
  const trayProf = tray ? traySectionProfile(envelope, tray.params, axisIsW) : null;
  if(trayProf) roundish = false;
  const H = envelope.H;
  const lenDim = axisIsW ? envelope.W : envelope.L;      // machine direction — where the seals go
  const crossDim = axisIsW ? envelope.L : envelope.W;    // the OTHER horizontal axis
  // jaw clearance (ramp reach) and the crimp's flat length come from
  // flowwrap.js's meta.seal; fall back to the flush endSealWidth so a flexible
  // style that publishes no seal metadata still renders (older/other styles).
  const jaw  = Math.max(seals.jawClearance   != null ? seals.jawClearance   : (seals.endSealWidth || 0), 0.01);
  const flat = Math.max(seals.sealFlatLength != null ? seals.sealFlatLength : (seals.endSealWidth || 0), 0.01);
  const ea = seals.externalAngle != null ? seals.externalAngle : 90;   // default straight out
  const gaugeMM = Math.max((seals.gauge || 0)/1000, 0.01);
  const finThk = Math.max(gaugeMM*2, 0.15);        // ~2x film gauge, floored only for visibility
  const fillet = safeFillet(envelope, stackInfo.stackAxis, stackInfo.nx, stackInfo.ny, stackInfo.layers, axisIsW);

  const hH = H/2, hCross = crossDim/2;   // body half-dims — every ramp ring stays AT OR INSIDE these, never bulges past them
  // every section ring is OPENED AT THE SEAM (bottom-face centre) so the girth
  // walk has somewhere to be discontinuous — see seamOpenRing. Shape unchanged;
  // done printed or not, so printed and unprinted stay the same geometry.
  const section = (pos) => seamOpenRing(
    trayProf ? profileRing(trayProf, pos, axisIsW) : ringPoints(pos, hH, hCross, roundish, fillet, axisIsW),
    axisIsW);
  const r0 = section(-lenDim/2), r1 = section(lenDim/2);
  // printed wrap: map the artwork's girth panels onto the REAL pillow body
  // (solid + aligned with the pieces — unlike the old separate art tube, which
  // was hollow and axis-transposed). UVs only when artInfo is present.
  const bodyUVs = (artInfo && artInfo.am) ? bodyRingUVs([r0, r1], artInfo.am, axisIsW) : null;
  const bodyGeo = loftGeometry([r0, r1], bodyUVs, true);

  // the RAMP: the film descends in HEIGHT only — full cross-section at the pack
  // face -> a flat, FULL-WIDTH crimp line the jaw clearance further out. Only
  // the height collapses (hH -> finThk/2); the width stays hCross the whole way,
  // so top-down the wrap is a clean full-width rectangle to the crimp, never a
  // dart. (The internal angle is a side-profile change, constrained to the
  // vertical plane — it must not touch the width axis.) The crimp edge is a
  // clean full-width line, flush with the endTab fin — an earlier serrated tip
  // scalloped the width past the body and read as a glitch, so it was dropped.
  // printed film runs CONTINUOUSLY through the ramp and into the crimp — the
  // template paints those columns (RAMP, END SEAL) and the mapping has to
  // reach them, or a printed pack shows a bare white band before each crimp.
  // The ramp spans the canvas from the product-region edge (u0/u1, where the
  // body mapping ends) out to the end-seal column; the girth walk reuses the
  // body's own v computation on each ring, so the bands stay registered as
  // the section collapses. A style whose artMap has no end columns clamps to
  // the product edge (stretched edge pixels beat an unmapped default).
  const AM = artInfo && artInfo.am;
  let crimpV = null;                      // set by ramp(): the crimp ring's own [w -> v]
  const uEdge = AM && [AM.faces[0].u0/AM.canvas.w, AM.faces[0].u1/AM.canvas.w];
  const uCrimp = AM && (AM.ends
    ? [AM.ends[0].u1/AM.canvas.w, AM.ends[1].u0/AM.canvas.w]
    : uEdge);
  function ramp(sign){
    const shoulder = sign*(lenDim/2), crimp = sign*(lenDim/2 + jaw);
    // tray: the shoulder ring is the faceted section — collapsing it linearly
    // onto the full-width flat crimp line gathers the corner facets into the
    // triangular dog-ear folds real film makes there, with no extra geometry
    const rings = [
      section(shoulder),
      seamOpenRing(ringPoints(crimp, finThk/2, hCross, roundish, fillet, axisIsW), axisIsW)
    ];
    const ordered = sign > 0 ? rings : rings.slice().reverse();
    let uvs = null;
    if(AM){
      const uSh = uEdge[sign > 0 ? 1 : 0], uCr = uCrimp[sign > 0 ? 1 : 0];
      const uRing = sign > 0 ? [uSh, uCr] : [uCr, uSh];   // match the ring order
      uvs = bodyRingUVs(ordered, AM, axisIsW, uRing);
      // the tab continues THIS ring — remember its v so the print runs on
      // across the crimp line instead of restarting at a different density
      crimpV = crimpVLookup(rings[1], uvs[sign > 0 ? 1 : 0], axisIsW);
    }
    return loftGeometry(ordered, uvs, true);
  }
  // the finished CRIMP TAB: a flat sealed fin the FULL pack width (crossDim),
  // length = the crimp's flat length, hinged at the crimp line and LAID at the
  // external angle — 90° straight out along the length axis (adds its full
  // length), 0° folded flat up against the pack end (adds ~nothing). Built in a
  // canonical length=+X frame and, only if the machine dir is W, remapped X->Z.
  function endTab(sign){
    const geo = new THREE.BoxGeometry(flat, finThk, crossDim);   // long axis local X, FULL width
    geo.translate(flat/2, 0, 0);                             // hinge at origin, extends +X
    // the crimp tab carries its end-seal COLUMN: u runs hinge -> tip through the
    // column, and v is the CRIMP RING's own v continued (crimpV) rather than a
    // range of the tab's own. The tab used to stretch the whole canvas height
    // (0..1) across its width — the right region at the right u span, but 3.5x
    // the body's texel density, so a real graphic read as a blown-up crop at a
    // hard scale jump on the crimp line. Reading the ring makes the gather
    // CONTINUOUS: the web narrows progressively along the ramp and the tab
    // simply carries on. Assigned in the canonical frame, BEFORE the lay
    // rotation/remap, so the transforms carry the print with the geometry.
    if(AM && AM.ends && crimpV){
      const col = AM.ends[sign > 0 ? 1 : 0], CWc = AM.canvas.w;
      const uHinge = (sign > 0 ? col.u0 : col.u1)/CWc, uTip = (sign > 0 ? col.u1 : col.u0)/CWc;
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for(let i = 0; i < pos.count; i++){
        const t = Math.min(Math.max(pos.getX(i)/flat, 0), 1);
        // the tab is built length-along-local-X, width along local Z. The ring's
        // cross axis is world X when the machine dir is W, and the tab's later
        // rotateY(-90°) sends local +Z to world −X — so the width coordinate
        // flips sign in that case, or the print mirrors across the crimp.
        const w = axisIsW ? -pos.getZ(i) : pos.getZ(i);
        uv.setXY(i, uHinge + t*(uTip - uHinge), crimpV(w, pos.getY(i) >= 0));
      }
      uv.needsUpdate = true;
    }
    const lay = (90 - ea)*Math.PI/180;                       // 0 at ea=90 (out); 90° at ea=0 (folded up)
    geo.rotateZ(sign > 0 ? lay : Math.PI - lay);             // +end tilts up/out; -end mirrors
    geo.translate(sign*(lenDim/2 + jaw), 0, 0);              // hinge onto the crimp line
    if(axisIsW) geo.rotateY(-Math.PI/2);                     // machine dir = W: canonical +X -> +Z
    return geo;
  }
  return {bodyGeo, taperPos: ramp(1), taperNeg: ramp(-1), endTabPos: endTab(1), endTabNeg: endTab(-1)};
}

/** The fin seal: a solid tab lying FLUSH against the chosen face — bottom
 *  by default, or top — running the full pack length along the MACHINE
 *  direction (wrapAxis — true L or true W, never H), standing `finHeight`
 *  proud of that face when the treatment is standing, or lying flat (a
 *  thin visible sliver, floored for visibility) when folded. `finSealBand`
 *  is the tab's width across the OTHER horizontal axis, centred on it —
 *  never collapsed to a zero-thickness plane, so it can't read as a line
 *  from any angle, and it moves with the wrap under every orientation
 *  because it's baked into the geometry (render-local Y = true H, the SAME
 *  frame every orientation is applied to via orientQuat), not positioned
 *  post-hoc per orientation.
 *
 *  Only 'bottom'/'top' are real faces for a horizontal wrapper — a side
 *  face was never physically real (the seal can't land on the machine's
 *  own travel axis) and is no longer offered (Prompt 20, Part A). Both
 *  stand the fin off the Y axis; which SIDE of Y (proud stands out from
 *  the underside or the topside) is the only thing that changes. */
function wrapFinGeometry(envelope, seals, wrapAxis, artInfo){
  const axisIsW = wrapAxis === 'W';
  const H = envelope.H;
  const lenDim = axisIsW ? envelope.W : envelope.L;
  const crossDim = axisIsW ? envelope.L : envelope.W;
  const fh = seals.finHeight || 0;
  if(seals.sealType === 'lap' || fh <= 0) return null;
  const standing = seals.finTreatment === 'standing';
  const proud = standing ? fh : T_FLOOR;                     // how far it stands off the face
  const face = seals.finFace || 'bottom';
  const sign = face === 'top' ? 1 : -1;                       // top, or bottom (default)
  const band = Math.max(1, Math.min(seals.finSealBand || H*0.3, crossDim));
  // proud stands up/down in Y off the bottom/top face; length runs along
  // whichever local axis (X or Z) the machine direction maps to
  const geo = axisIsW ? new THREE.BoxGeometry(band, proud, lenDim) : new THREE.BoxGeometry(lenDim, proud, band);
  geo.translate(0, sign*(H/2 + proud/2), 0);
  // printed: the fin carries its own allowance band (the web edges below the
  // first girth band meet here), u along the product run like the body
  if(artInfo && artInfo.am){
    const am = artInfo.am, CW = am.canvas.w, CH = am.canvas.h;
    const u0 = am.faces[0].u0/CW, u1 = am.faces[0].u1/CW, vBand = am.faces[0].v0/CH;
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    let yMin = Infinity, yMax = -Infinity;
    for(let i = 0; i < pos.count; i++){ const y = pos.getY(i); if(y < yMin) yMin = y; if(y > yMax) yMax = y; }
    const ySpan = Math.max(yMax - yMin, 1e-6);
    for(let i = 0; i < pos.count; i++){
      const m = axisIsW ? pos.getZ(i) : pos.getX(i);           // machine coordinate
      uv.setXY(i, u0 + (m/lenDim + 0.5)*(u1 - u0), (pos.getY(i) - yMin)/ySpan*vBand);
    }
    uv.needsUpdate = true;
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

/**
 * The CLOSED wrap's drawable parts — body, both ramp tapers, both crimp tabs and
 * the fin — as [{geo, mat}], ready to instance. ONE builder for every place a
 * closed film pack is drawn: the hierarchy's wrap children and the retail
 * shelf's facings. The shelf used to draw its facings as plain BoxGeometry,
 * which is not the pack — a pillow with ramped, crimped ends reads nothing like
 * a rectangular box, and the shopper's view is exactly where that matters.
 *
 * With a tray in the chain the film wraps the TRAY, so the parts come from the
 * FILM envelope with the faceted tray section — `w.envelope` alone is one
 * cell's collation run and draws undersized round tubes inside tray-sized
 * slots. No tray: `w.envelope` and the tube profile, exactly as before.
 *
 * Built in the wrap's own canonical frame (x=L, y=H, z=W, centred), the same
 * frame buildWrapOpened uses, so a caller can orient/position them like any
 * other pack. Returns [] when the chain carries no filmed wrap.
 */
export function closedWrapParts(bundle){
  const w = bundle && bundle.wraps;
  if(!w || !w.seals) return [];
  const cEnv = bundle.tray ? (w.filmEnvelope || w.envelope) : w.envelope;
  const art = wrapArtOf(bundle);
  const parts = wrapPartsGeometry(cEnv, w.seals, bundle.tray ? false : isRoundishWrap(w),
                                  stackInfoOf(w), w.wrapAxis, art || undefined, bundle.tray);
  const finGeo = wrapFinGeometry(cEnv, w.seals, w.wrapAxis, art);
  // CLOSED — so plain unprinted film, or the artwork where there is artwork.
  // These are the non-hero packs: inside a carton or case, on a pallet, and
  // every shelf facing.
  const {body, seal} = wrapMaterials(false, art);
  const defs = [
    {geo: parts.bodyGeo, mat: body},
    {geo: parts.taperPos, mat: seal},
    {geo: parts.taperNeg, mat: seal},
    {geo: parts.endTabPos, mat: seal},
    {geo: parts.endTabNeg, mat: seal}
  ];
  if(finGeo) defs.push({geo: finGeo, mat: seal});
  return defs;
}

/** Assemble one wrap (body + 2 tapers + fin) as ordinary Meshes — used for
 *  the single opened wrap. Closed (repeated) wraps use the instanced path
 *  in buildContainer instead, sharing these same geometries. */
function buildWrapMeshes(envelope, seals, roundish, stackInfo, wrapAxis, opened, artInfo, tray){
  const parts = wrapPartsGeometry(envelope, seals, roundish, stackInfo, wrapAxis, artInfo, tray);
  const finGeo = wrapFinGeometry(envelope, seals, wrapAxis, artInfo);
  const g = new THREE.Group();
  const {body, seal} = wrapMaterials(opened, artInfo);
  g.add(new THREE.Mesh(parts.bodyGeo, body));
  g.add(new THREE.Mesh(parts.taperPos, seal));
  g.add(new THREE.Mesh(parts.taperNeg, seal));
  g.add(new THREE.Mesh(parts.endTabPos, seal));
  g.add(new THREE.Mesh(parts.endTabNeg, seal));
  if(finGeo) g.add(new THREE.Mesh(finGeo, seal));
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
function buildWrapOpened(bundle, artInfo, solid){
  // The wrap at wrap depth, in whichever of the two states the caller asks for.
  // SOLID: the closed pack — the real pillow body, opaque, no contents, plain
  // unprinted film unless there is artwork to carry (see wrapMaterials). That
  // is what the pack looks like as it ships, and it is what gives Solid a job
  // distinct from Cutaway; it used to fall through to the cutaway whenever
  // there was no artwork, so unprinted packs had two identical modes.
  // CUTAWAY: the translucent conforming film + all pieces inside (never
  // overlaid with the art, so it always aligns).
  const g = new THREE.Group();
  // no wrap/piece data on the row means the film tier is disabled (or the
  // content never collates into a wrap): there is nothing to open — return
  // the empty group rather than dereferencing a null bundle.wraps. The
  // parent container's own cutaway box still renders around it.
  if(!bundle.wraps) return g;
  // THE film envelope is the wrap's OWN inner envelope, which the chain
  // already solved — not the bare collation's. With a tray in the chain the
  // two diverge (the film wraps the TRAY, whose footprint is far wider than
  // one cell's product run), and reading the collation here drew a long thin
  // sleeve that contradicted the pack's own dims box. One source: whatever
  // the film was sized around is what the film is drawn around.
  const envelope = bundle.wraps.filmEnvelope || bundle.wraps.envelope;
  const {pieces, piece, stackAxis} = bundle.wraps;
  const o = 'LWH';                                         // pieces already in envelope frame
  const closed = !!solid;
  const art = (artInfo && artInfo.am && artInfo.canvas) ? artInfo : null;
  // the film is drawn only when a wrap is actually in the chain (seals present);
  // a wrapless pack shows the bare collation pieces alone (no conforming film).
  if(bundle.wraps.seals)
    g.add(buildWrapMeshes(envelope, bundle.wraps.seals, isRoundishWrap(bundle.wraps), stackInfoOf(bundle.wraps), bundle.wraps.wrapAxis, !closed, closed ? art : null, bundle.tray));
  if(closed) return g;                                     // a closed pack shows no contents
  // Contents: with a tray in the chain the film encloses the TRAY (loaded with
  // its product), not a loose run of pieces — draw that instead, so the
  // cutaway shows what is physically inside the film.
  if(bundle.tray){
    const t = buildTray3d(bundle.tray.params, {piece, stackAxis, perCell: bundle.tray.perCell,
                                               pieces: bundle.wraps.cellPieces || pieces});
    // buildTray3d centres the tray on its OWN rim height (overallH) — right at
    // tray depth, but here the tray rides INSIDE the film, which is centred on
    // the taller WRAP ENVELOPE (H = max(rim, floor+proud product)). Left as-is
    // the tray floats mid-film: the film hangs below the tray underside and the
    // proud product tops poke through the film top. Seat the tray on the film
    // floor by dropping it half the envelope-vs-rim difference — the SAME offset
    // simultaneously lands the underside on the film bottom and the proud tops at
    // the film top (envelope.H = floor+standingH makes the two coincide). Zero
    // when nothing stands proud (envelope.H === overallH), so the flush tray is
    // bit-identical.
    t.group.position.y -= (envelope.H - bundle.tray.params.overallH)/2;
    g.add(t.group);
    return g;
  }
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

// The real product pieces of many collations at once — each piece placed by
// (collation orientation × collation position in the carton) composed with the
// piece's own offset inside its collation, exactly the layout buildWrapOpened
// uses for one opened collation. One InstancedMesh sharing pieceMat, used ONLY
// for the wrapless opened carton so it shows its true contents (cans/boxes).
// `list` is [{pl, i}] closed-collation placements (never the opened one).
function collationPieces(bundle, list, parentInnerH){
  // THE film envelope is the wrap's OWN inner envelope, which the chain
  // already solved — not the bare collation's. With a tray in the chain the
  // two diverge (the film wraps the TRAY, whose footprint is far wider than
  // one cell's product run), and reading the collation here drew a long thin
  // sleeve that contradicted the pack's own dims box. One source: whatever
  // the film was sized around is what the film is drawn around.
  const envelope = bundle.wraps.filmEnvelope || bundle.wraps.envelope;
  const {pieces, piece, stackAxis} = bundle.wraps;
  const {geo, rot} = pieceGeo(piece, stackAxis, 'LWH');
  const inst = new THREE.InstancedMesh(geo, pieceMat, list.length * pieces.length);
  const M = new THREE.Matrix4(), C = new THREE.Matrix4(), P = new THREE.Matrix4();
  let k = 0;
  for(const {pl} of list){
    const c = childPos(pl, parentInnerH);
    C.makeRotationFromQuaternion(orientQuat(pl.orientation));
    C.setPosition(c.x, c.y, c.z);
    for(const p of pieces){
      if(rot) P.copy(rot); else P.identity();
      P.setPosition(p.x, -envelope.H/2 + p.z, p.y);
      inst.setMatrixAt(k++, M.multiplyMatrices(C, P));
    }
  }
  return inst;
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

/**
 * Textured closed instances of ONE rigid pack type (carton or case). Artwork is
 * a property of the pack (its level/style), not of one instance, so EVERY unit
 * in `list` carries the same art from ONE shared texture — the geometry is the
 * pack's canonical closed body (packArtGeometry), with orientation baked into
 * each instance matrix so the UVs never rotate off the print. Returns the
 * meshes to add (textured InstancedMesh + a flat-board overflow past the cap);
 * pushes pickables. `posOf(pl) -> {x,y,z}` in the parent's local frame.
 */
function artInstances(am, canvas, list, posOf, tierName){
  const out = [];
  const geo = packArtGeometry(am);                     // shared by textured + overflow
  const textured = list.slice(0, ART_INSTANCE_CAP);
  const overflow = list.slice(ART_INSTANCE_CAP);
  artCapped += overflow.length;
  const place = (mat, arr) => {
    const inst = new THREE.InstancedMesh(geo, mat, arr.length);
    const M = new THREE.Matrix4();
    arr.forEach(({pl}, k) => {
      M.makeRotationFromQuaternion(orientQuat(pl.orientation));
      const p = posOf(pl); M.setPosition(p.x, p.y, p.z);
      inst.setMatrixAt(k, M);
    });
    inst.userData = {pick: arr.map(x => x.i), tierName};
    pickables.push({mesh: inst, tier: tierName});
    out.push(inst);
  };
  if(textured.length){
    const mats = packArtMaterials(canvas, board);      // [new artMat(+texture), shared board]
    artResources.push(mats[0]);                        // dispose the per-build texture on clear
    place(mats, textured);
  }
  if(overflow.length) place([board, board], overflow); // flat board beyond the cap
  return out;
}

/** One CLOSED pack centred at the origin (Solid mode): the textured art body
 *  when the pack has artwork, else a plain board box at its outer dims. No
 *  contents, no cutaway — the "what it looks like" render. */
function soloClosed(geo, artInfo){
  // open-top style (e.g. the FEFCO 0300 tray): no lid — render base + 4 walls,
  // never a closed box. Checked first so it holds even if art were present
  // (the tray's art is flat-mapped, not a 3D tube, so there is no closed body).
  if(isOpenTop(geo)) return openTrayBox(geo.outer, geo.inner, board);
  const printed = artInfo && artInfo.am && artInfo.canvas;
  // DISPLAY STATE: everything above the tear is gone and the retained walls
  // carry the profile — built from the SAME path the dieline drew. Checked
  // before the closed bodies below, because a pack in display state is not a
  // closed pack at all.
  if(isDisplayGeo(geo)){
    let mats = board;
    if(printed){ mats = packArtMaterials(artInfo.canvas, board); artResources.push(mats[0]); }
    const body = perfDisplayBody(geo, mats);
    if(body) return body;
  }
  const g = new THREE.Group();
  if(printed){
    const mats = packArtMaterials(artInfo.canvas, board);
    artResources.push(mats[0]);
    g.add(new THREE.Mesh(packArtGeometry(artInfo.am), mats));
  }else{
    const o = geo.outer, rr = Math.min(o.L, o.W, o.H)*0.03;
    g.add(new THREE.Mesh(roundedBoxGeo(o.L, o.H, o.W, rr, 2), board));
  }
  // SHIPPING STATE with a perforation: the pack is intact and the tear is a
  // surface LINE on it — never a cut and never a gap.
  const line = geo.perf ? perfSurfaceLine(geo) : null;
  if(line) g.add(line);
  return g.children.length === 1 ? g.children[0] : g;
}

// generic: a container tier holding children, one opened, the rest closed.
// Both rigid children (cartons, cases) and wrap children instance — one
// InstancedMesh per PART (body/taperPos/taperNeg/fin) for wraps, since a
// wrap's shape doesn't vary by orientation the way a box's rendered
// geometry does; the rotation is baked into each instance's own matrix.
function buildContainer(tier, bundle, sel, path, opts = {}){
  const g = new THREE.Group();
  const {geo, children, childKind} = tier;
  const parentInnerH = geo.inner.H;

  // EXPLODED VIEW — a transform on the placements this tier already solved
  // (see explode.js), computed ONCE from the TRUE positions so every child
  // instance and the shell read the same rank set and factor. The offset is
  // then folded into a SHIFTED placement array, in the same {x,y,z} fields
  // `childPos` already reads (world y/vertical <-> pl.z, world x/z <-> pl.x/
  // pl.y) — so every existing consumer of a placement (childPos, the
  // wrapless-piece drawer, the textured-instance path) produces the
  // exploded position with NO changes of its own; only the ONE place that
  // builds this shifted array needs to know explosion exists at all.
  const ex = tierExplode(tier, geo, children, parentInnerH, opts.explode);
  const exploded = children.map((pl, i) => {
    const o = ex.offsets[i];
    return (o.x || o.y || o.z) ? {...pl, x: pl.x + o.x, y: pl.y + o.z, z: pl.z + o.y} : pl;
  });

  // Shell: a Shrink Bundle has none (film only). A SOLID open tray shows a
  // STATIC open box (walls stay put — you view it from outside, its contents
  // standing proud / seen through the open top), NOT a cutaway. Everything else
  // (a cutaway open tray, or any closed container being opened) gets the cutaway
  // box whose near walls hide as the camera orbits.
  // DISPLAY STATE first: a perforated container shown for display has no lid
  // and a profiled front, so neither a closed box nor a cutaway describes it —
  // it IS the opened shell. Its near walls are not hidden as the camera
  // orbits, and do not need to be: there is no top to see past.
  const displayShell = isDisplayGeo(geo) ? perfDisplayBody(geo, tier.mat) : null;
  let shellParts = [];                    // the shell body (+ its tear line, if any) — moves together
  if(isShrinkBundle(geo)){ /* no rigid shell */ }
  else if(displayShell){ g.add(displayShell); shellParts = [displayShell]; }
  else if(opts.solid && isOpenTop(geo)){
    const box = openTrayBox(geo.outer, geo.inner, tier.mat);
    g.add(box); shellParts = [box];
  }else {
    const box = cutawayBox(geo.outer, geo.inner, tier.mat);
    g.add(box); shellParts = [box];
    // SHIPPING state with a perforation: the tear is a surface line on an
    // intact container — drawn separately, but it rides the SAME shell and
    // must explode with it or the tear visually detaches from the body.
    const line = geo.perf ? perfSurfaceLine(geo) : null;
    if(line){ g.add(line); shellParts.push(line); }
  }
  if(ex.shell.x || ex.shell.y || ex.shell.z)
    for(const part of shellParts) part.position.set(ex.shell.x, ex.shell.y, ex.shell.z);

  // Solid mode FILLS the container — every child shown, none drilled to product
  // (drilling is the cutaway). openIdx -1 excludes nothing and skips the recurse.
  const openIdx = opts.solid ? -1 : clampIdx(sel[tier.name], children);

  // a 'wrap' childKind whose bundle.wraps is null means the film tier is
  // disabled (or the content never collates into a wrap): there are no wrap
  // instances to draw, so fall through to neither branch — the container's
  // own cutaway box (added above) is the whole render. A wrap child is NOT a
  // box, so it must never reach the rigid-box branch below.
  const w = childKind === 'wrap' ? bundle.wraps : null;
  if(childKind === 'wrap' && w){
    const closed = exploded.map((pl, i) => ({pl, i})).filter(x => x.i !== openIdx);
    if(w.seals && closed.length){
      // filmed wrap: instanced conforming-film parts per closed unit. With a
      // tray in the chain the film wraps the TRAY, so the closed instances
      // must be drawn from the film envelope with the faceted tray section —
      // the bare w.envelope here is ONE CELL's collation run, which drew the
      // closed packs as undersized round tubes inside their tray-sized slots.
      // No tray: w.envelope and the tube profile, exactly as before.
      const partDefs = closedWrapParts(bundle);
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
    }else if(!w.seals && closed.length){
      // wrapless pack (no film): the carton holds the bare product directly, so
      // render the REAL pieces (cylinders/boxes) of every closed collation — the
      // opened one is drawn by the recursion below — so this single opened carton
      // reads as its true contents (e.g. cans), not placeholder envelope boxes.
      // Only ever runs for the one opened carton; closed cartons elsewhere stay
      // solid board, and a filmed wrap (w.seals) never reaches this branch.
      g.add(collationPieces(bundle, closed, parentInnerH));
    }
  }else if(childKind !== 'wrap'){
    const closed = exploded.map((pl, i) => ({pl, i})).filter(x => x.i !== openIdx);
    const art = tier.childArt;
    if(art && art.am && art.canvas && closed.length){
      // textured: every closed child instance carries the pack's art from one
      // shared texture. Canonical geometry + per-instance orientation.
      for(const m of artInstances(art.am, art.canvas, closed, pl => childPos(pl, parentInnerH), tier.childKind)) g.add(m);
    }else{
      for(const [o, list] of groupByOrientation(exploded, openIdx)){
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
  }

  // the one opened child, recursed
  if(exploded[openIdx]){
    const pl = exploded[openIdx];
    const childGroup = tier.buildChild(bundle, sel, path.concat(openIdx), opts);
    childGroup.position.copy(childPos(pl, parentInnerH));
    childGroup.quaternion.copy(orientQuat(pl.orientation));
    g.add(childGroup);
  }
  // shrink film LAST, so the translucent skin draws over the visible contents —
  // a bundle skins to its own height; a shrink-wrapped tray skins up to the
  // proud loaded height the chain measured (meta.shrinkLoadedH). Moves with
  // the shell (an open tray's skin) when the shell does.
  if(isShrink(geo)){
    const skin = filmSkin(geo.outer, geo.meta.shrinkLoadedH);
    if(ex.shell.x || ex.shell.y || ex.shell.z) skin.position.add(new THREE.Vector3(ex.shell.x, ex.shell.y, ex.shell.z));
    g.add(skin);
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

// Tier descriptors (inner→outer wiring), shared by the hierarchy cascade AND
// the shelf's single-pack cutaway so both drill a pack the same way — one
// source for "what a carton/case contains and how it opens". childOuter is the
// child's OUTER dims. cartonTier only exists when the carton level is enabled;
// disabled, the case's children ARE the wraps and the carton tier collapses out.
function makeTiers(bundle, cartonArt, caseArt){
  const cartonTier = bundle.cartonGeo ? {
    name: 'carton', geo: bundle.cartonGeo, mat: board, childKind: 'wrap',
    children: bundle.wraps ? bundle.wraps.placements : [],
    childOuter: bundle.wrapGeo ? bundle.wrapGeo.outer : (bundle.wraps ? bundle.wraps.envelope : bundle.cartonGeo.outer), childMat: wrapSolidMat,
    art: cartonArt,               // clads the carton when it rides the pallet (case off)
    childArt: null,               // wrap children are conforming film, not textured here
    buildChild: (b, s, path) => buildWrapOpened(b)
  } : null;
  const caseTier = {
    name: 'case', geo: bundle.caseGeo, mat: board, art: caseArt,
    children: bundle.cartons.placements,
    ...(bundle.cartonGeo
      ? {childKind: 'carton', childOuter: bundle.cartonGeo.outer, childMat: board2, childArt: cartonArt,
         buildChild: (b, s, path, opts) => buildContainer(cartonTier, b, s, path, opts)}
      : {childKind: 'wrap', childOuter: bundle.wrapGeo ? bundle.wrapGeo.outer : (bundle.wraps ? bundle.wraps.envelope : bundle.caseGeo.inner), childMat: wrapSolidMat,
         buildChild: (b, s, path) => buildWrapOpened(b)})
  };
  return {cartonTier, caseTier};
}

/**
 * ONE sellable pack, opened as a cutaway (translucent-board shell with its near
 * walls hideable per-frame, plus the real contents drilled the same way the
 * hierarchy does). Built in the pack's canonical frame (x=L, y=H, z=W, centred,
 * floor at −H/2); the shelf caller orients/positions the returned group. Returns
 * {group, walls} — `walls` is [{mesh, n}] for the caller's own near-wall loop,
 * kept out of the hierarchy's own list. No art on the opened pack (board/film,
 * matching the hierarchy's Cutaway look); the solid facing packs keep their art.
 * @param {string} noun  'carton' or 'case' — which tier is the sellable pack
 */
export function buildSellableCutaway(bundle, noun){
  // the WRAP as the sellable unit (a tray -> wrap -> case chain): the pack IS
  // the film and its contents, with no rigid shell to cut away — so it opens
  // through the same buildWrapOpened every other depth uses, in the same
  // canonical frame the caller orients. Without this branch a 'wrap' noun fell
  // through to the case tier and the shelf drew the shipper.
  if(noun === 'wrap') return {group: buildWrapOpened(bundle), walls: []};
  const {cartonTier, caseTier} = makeTiers(bundle, {am: null}, {am: null});
  const tier = noun === 'carton' ? cartonTier : caseTier;
  if(!tier || !tier.geo) return {group: new THREE.Group(), walls: []};
  const walls = [], savedSink = wallSink, savedPick = pickables;
  wallSink = walls; pickables = [];                 // capture walls; don't touch hierarchy pickables
  let g;
  try { g = buildContainer(tier, bundle, {}, []); }
  finally { wallSink = savedSink; pickables = savedPick; }
  return {group: g, walls};
}

export function buildHierarchy(bundle, depth, sel, solid, explode){
  const pivot = getPivot();
  clear();
  group = new THREE.Group();
  sel = sel || {};
  artCapped = 0;

  // per-pack-type art {am, canvas}, prepared by app.js on the bundle. A tier's
  // OWN art clads it when it's the instanced unit (cases on the pallet); its
  // childArt clads the children it contains (cartons in a case).
  const A = bundle.art || {};
  const artOf = geo => (geo && geo.meta.artMap && !geo.meta.artMap.flat) ? geo.meta.artMap : null;
  const cartonArt = {am: artOf(bundle.cartonGeo), canvas: A.carton};
  const caseArt   = {am: artOf(bundle.caseGeo),   canvas: A.case};
  // the wrap clads too, at wrap depth: unlike the cartons/cases (which use the
  // packArtGeometry tube via soloClosed), the wrap textures its REAL pillow body
  // directly (buildWrapOpened → wrapArtMat + bodyRingUVs), reading the SAME
  // wrap-panel decomposition (front/sides/back-halves) the template and 2D view
  // share — so the print is solid and aligned with the pillow, never a tube.
  const wrapArt   = {am: artOf(bundle.wrapGeo),   canvas: A.wrap};

  const {cartonTier, caseTier} = makeTiers(bundle, cartonArt, caseArt);

  // default openings: outer-corner unit nearest the camera, per level, where
  // the user hasn't clicked an override. Recomputed each build (app rebuilds
  // on pointerup after an orbit, so the channel tracks the near corner).
  // `pallet` is a DISTINCT selection: which OUTER unit (case, or carton once the
  // case is off) is opened ON the pallet — indexed into the pallet layout
  // (bundle.cases.placements), NOT the inner-tier arrays. It must be its own key
  // because when the carton is the pallet's outer tier, S.carton already means
  // "which pack is opened INSIDE a carton" (bundle.cartons.placements); reusing
  // that here opened the wrong index (often out of range → no carton opened, the
  // bug this fixes).
  const S = {
    pallet: sel.pallet ?? nearestCameraCorner(bundle.cases.placements),
    case:   sel.case   ?? nearestCameraCorner(bundle.cases.placements),
    carton: sel.carton ?? nearestCameraCorner(bundle.cartons.placements),
    wrap:   sel.wrap   ?? (bundle.wraps ? nearestCameraCorner(bundle.wraps.placements) : 0)
  };

  // `outer` = the top-level subject's world x/y/z extent (L,W,H mm), centred on
  // the origin like every depth's render — the Dims overlay annotates exactly
  // this box, so it can never drift from what's drawn.
  let span = 100, opened = {}, outer = null;
  if(depth === 'product'){
    const p = bundle.wraps.piece;
    // ONE source for "which way the piece lies": the same pieceGeo(piece,
    // stackAxis) the wrap/carton depths use. It returns a `rot` that lays a
    // cylinder on its side in On Edge mode (stack axis X) and stands it in
    // Pile mode (stack axis Z) — the bare-piece view must apply that rot too,
    // or a Round piece reads as a standing coin in On Edge and makes the user
    // doubt the orientation is applied. The Dims box follows the rotated extent.
    const {geo, rot} = pieceGeo(p, bundle.wraps.stackAxis, 'LWH');
    const mesh = new THREE.Mesh(geo, pieceMat);
    if(rot) mesh.applyMatrix4(rot);
    group.add(mesh);
    span = p.kind === 'cylinder' ? p.diameter : Math.max(p.L, p.W, p.H);
    geo.computeBoundingBox();
    const s = (rot ? geo.boundingBox.clone().applyMatrix4(rot) : geo.boundingBox).getSize(new THREE.Vector3());
    outer = {L: s.x, W: s.z, H: s.y};
  }else if(depth === 'tray'){
    // the thermoformed tray: a sibling renderer, drawn from the ported
    // dimensions. `outer` is the PLACED envelope (trayOuter), so the Dims
    // overlay annotates exactly the box the chain hands to the wrap.
    const r = buildTray3d(bundle.tray.params, bundle.wraps ? {
      piece: bundle.wraps.piece, stackAxis: bundle.wraps.stackAxis,
      perCell: bundle.tray.perCell, pieces: bundle.wraps.cellPieces || bundle.wraps.pieces
    } : null);
    group.add(r.group);
    span = r.span; outer = r.outer;
  }else if(depth === 'wrap'){
    // Solid → the closed pack (white film, or the girth artwork on that same
    // real body when there is art); Cutaway → the film + pieces. The art rides
    // the same aligned pillow geometry the cutaway uses, so it can never be
    // hollow or misaligned.
    group.add(buildWrapOpened(bundle, wrapArt, solid));
    const e = bundle.wraps.envelope; span = Math.max(e.L, e.W, e.H);
    const o = bundle.wrapGeo.outer; outer = {L: o.L, W: o.W, H: o.H};
  }else if(depth === 'carton'){
    // an OPEN tray or a SHRINK pack reveals its contents in BOTH modes (Solid
    // fills it, Cutaway drills one to product); only a closed box hides them.
    const showContents = isOpenTop(bundle.cartonGeo) || isShrink(bundle.cartonGeo);
    if(solid && !showContents) group.add(soloClosed(bundle.cartonGeo, cartonArt));
    else { group.add(buildContainer(cartonTier, bundle, S, [], {solid, explode})); opened = {wrap: S.wrap}; }
    const o = bundle.cartonGeo.outer; span = Math.max(o.L, o.W, o.H);
    outer = {L: o.L, W: o.W, H: o.H};
  }else if(depth === 'case'){
    const showContents = isOpenTop(bundle.caseGeo) || isShrink(bundle.caseGeo);
    if(solid && !showContents) group.add(soloClosed(bundle.caseGeo, caseArt));
    else { group.add(buildContainer(caseTier, bundle, S, [], {solid, explode})); opened = {carton: S.carton, wrap: S.wrap}; }
    const o = bundle.caseGeo.outer; span = Math.max(o.L, o.W, o.H);
    outer = {L: o.L, W: o.W, H: o.H};
  }else if(depth === 'pallet'){
    // the case rides the pallet normally; once it's disabled the carton does
    // (its cutaway tier), so pass whichever tier is actually outermost
    const r = buildPallet(bundle, bundle.caseGeo ? caseTier : cartonTier, S, solid, explode);
    span = r.span; outer = r.outer;
    if(!solid) opened = {case: S.case, carton: S.carton, wrap: S.wrap};
  }

  pivot.add(group);
  // a wider frame so the live view doesn't clip exploded parts — the sheet
  // composer reframes from the actually-rendered geometry (visibleSpan) so
  // this margin is a live-view nicety only, never something a capture relies on.
  setCamSpan(explode && explode.factor ? span*(1 + explode.factor*0.8) : span);
  registerFrame();
  lastOuter = outer;
  return {opened: S, span, counts: bundle.counts, outer};
}

/** The oriented L/W/H extent of the last-built subject — a test hook: at
 *  product depth it reflects how the single piece actually lies (On Edge lays
 *  a Round piece on its side), so a regression can pin that the bare-piece
 *  view shares the deeper views' orientation source. */
let lastOuter = null;
export function renderedOuter(){ return lastOuter; }

// Every OPEN tray on the pallet, instanced: the open shell (base + 4 walls, no
// top) and — since an open tray reveals its contents — the cartons standing
// PROUD inside it. `placements` are the tray positions ([{pl, i}]); trayGeo is
// the open tray; cartonGeo/cartonPls are the child cartons (one tray's childFit),
// replicated into every tray. Cartons are ONE InstancedMesh across the whole
// pallet (tray matrix × carton local matrix); the shell's 5 board parts each
// instance across the trays. Everything picks as 'pallet'.
function openTrayInstances(placements, trayGeo, cartonGeo, cartonPls, deckH, opts = {}){
  const shell = opts.shell !== false;                    // draw the tray walls (a bundle has none)
  const co = trayGeo.outer, t = Math.max((co.L - trayGeo.inner.L) / 2, T_FLOOR);
  const trayM = pl => new THREE.Matrix4().compose(
    new THREE.Vector3(pl.x, deckH + pl.z, pl.y), orientQuat(pl.orientation), new THREE.Vector3(1, 1, 1));
  const local = new THREE.Matrix4(), world = new THREE.Matrix4();
  const instanceUnit = (geo, mat, place) => {          // one part instanced across every unit
    const inst = new THREE.InstancedMesh(geo, mat, placements.length);
    placements.forEach(({pl}, k) => { place(pl); inst.setMatrixAt(k, world.multiplyMatrices(trayM(pl), local)); });
    inst.userData = {pick: placements.map(x => x.i), tierName: 'pallet'};
    pickables.push({mesh: inst, tier: 'pallet'});
    group.add(inst);
  };
  // shell parts: floor + 4 upright walls (no top), each instanced across trays
  if(shell){
    const parts = [
      {g: [co.L, t, co.W], p: [0, -co.H/2 + t/2, 0]},
      {g: [t, co.H, co.W], p: [ co.L/2 - t/2, 0, 0]}, {g: [t, co.H, co.W], p: [-co.L/2 + t/2, 0, 0]},
      {g: [co.L, co.H, t], p: [0, 0,  co.W/2 - t/2]}, {g: [co.L, co.H, t], p: [0, 0, -co.W/2 + t/2]}
    ];
    for(const pr of parts)
      instanceUnit(new THREE.BoxGeometry(...pr.g), board, pl => local.makeTranslation(pr.p[0], pr.p[1], pr.p[2]));
  }
  // proud contents: canonical carton box, orientation + tray rotation baked per
  // instance — one draw call for every carton in every non-hero unit.
  if(cartonGeo && cartonPls.length){
    const o = cartonGeo.outer, rr = Math.min(o.L, o.W, o.H)*0.03;
    const inst = new THREE.InstancedMesh(roundedBoxGeo(o.L, o.H, o.W, rr, 2), board2, placements.length*cartonPls.length);
    let idx = 0;
    for(const {pl} of placements){
      const tm = trayM(pl);
      for(const cpl of cartonPls){
        const cp = childPos(cpl, trayGeo.inner.H);
        local.compose(new THREE.Vector3(cp.x, cp.y, cp.z), orientQuat(cpl.orientation), new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(idx++, world.multiplyMatrices(tm, local));
      }
    }
    group.add(inst);
  }
  // shrink skin: a clear film box per unit, inflated a hair past the contents
  // (SKIN_MARGIN) and rising to opts.skinH (the proud loaded height for a tray,
  // the bundle's own height otherwise). Drawn last so contents read through it.
  if(opts.skin){
    const H0 = opts.skinH != null ? opts.skinH : co.H;
    instanceUnit(new THREE.BoxGeometry(co.L + 2*SKIN_MARGIN, H0 + 2*SKIN_MARGIN, co.W + 2*SKIN_MARGIN), shrinkMat,
      () => local.makeTranslation(0, -co.H/2 + H0/2, 0));
  }
}

// `outerTier` is whichever tier actually rides the pallet — the case
// normally, or the carton once the case is disabled. bundle.cases carries
// that outermost tier's placements/deck regardless of which tier it is, so
// the geometry and the tier NAME (for picking/opening) come from outerTier,
// never a hardcoded 'case' that is null when the case is off.
function buildPallet(bundle, outerTier, S, solid, explode){
  const {cases} = bundle;
  const co = outerTier.geo.outer;
  const deckH = bundle.cases.deck.baseH;

  // EXPLODED VIEW — same transform-on-placements rule as buildContainer, but
  // there is no SHELL to lift at pallet depth: cases sit on an open deck,
  // never inside walls, so only the case positions separate (no cutawayBox,
  // no `ex.shell` to apply). Default axis is VERTICAL ('y'), not 'all' —
  // spreading cases sideways across a pallet just widens the footprint
  // without showing anything a plan view didn't already show; pulling
  // layers apart vertically is what an exploded PALLET is for.
  const palEx = (explode && explode.level === 'pallet' && explode.factor) ? explode : null;
  let palletOffsets = cases.placements.map(() => ({x: 0, y: 0, z: 0}));
  if(palEx){
    const positions = cases.placements.map(pl => ({x: pl.x, y: pl.z, z: pl.y}));
    const extents = cases.placements.map(pl => {
      const od = orient(co, pl.orientation);
      return {x: od.l, y: od.h, z: od.w};
    });
    palletOffsets = explodeTier(positions, extents, {x: 0, y: 0, z: 0}, palEx.axis || 'y', palEx.factor).offsets;
  }
  // shifted placements, same {x,y,z} fields every downstream reader already
  // takes — so `openTrayInstances`/`groupByOrientation`/`artInstances` and
  // the recursed opened case need no changes of their own, exactly as in
  // buildContainer. Kept SEPARATE from `cases.placements`: every measurement
  // below (contentTopLocal, load height) reads the TRUE placements, because
  // the Dims/HUD must report the real assembled load, not the exploded one.
  const explodedCases = cases.placements.map((pl, i) => {
    const o = palletOffsets[i];
    return (o.x || o.y || o.z) ? {...pl, x: pl.x + o.x, y: pl.y + o.z, z: pl.z + o.y} : pl;
  });
  // An OPEN tray never hides its contents: every tray on the pallet shows its
  // cartons standing PROUD of the low walls, so the load height is driven by the
  // proud carton top, not the tray wall (co.H).
  const openOuter = isOpenTop(outerTier.geo);
  const shrinkOuter = isShrink(outerTier.geo);           // Shrink Bundle, or a shrink-wrapped tray
  const contentTopLocal = (openOuter && bundle.cartonGeo && bundle.cartons.placements.length)
    ? Math.max(co.H/2, ...bundle.cartons.placements.map(pl =>
        childPos(pl, outerTier.geo.inner.H).y + orient(bundle.cartonGeo.outer, pl.orientation).h/2))
    : co.H/2;
  const maxTrayZ = cases.placements.length ? Math.max(...cases.placements.map(p => p.z)) : 0;
  const minTrayZ = cases.placements.length ? Math.min(...cases.placements.map(p => p.z)) : 0;
  // The pallet solve sizes each slot to the PROUD stack height and centres the
  // unit in it — so a low open tray with proud contents would FLOAT (its short
  // shell centred in a tall slot). Rest each unit on its slot floor instead:
  // the first layer's centre is at minTrayZ (= half the slot), so shifting every
  // unit by (co.H/2 − minTrayZ) puts that tray's floor on the deck. 0 for a
  // closed case or non-proud tray (slot already equals co.H). Fixes the float.
  const restOffset = openOuter ? co.H/2 - minTrayZ : 0;
  // THE load height is the CHAIN's — `row.loadH`, carried on the bundle. The
  // pallet fit reserved layers x unitStackH of column, so that IS the load's
  // height; project.js exposes it saying exactly this ("so the RENDER stacks
  // at the same pitch the fit used"), and nothing read it. Measuring instead
  // has been wrong twice: first as a recomputed layer COUNT (Math.round on a
  // centre, one layer too many, 114mm), and still by (unitStackH - outer.H)
  // whenever an open-top parent's contents stand proud of its walls, because
  // the measured extent sees where the children were DRAWN rather than the
  // pitch the fit budgeted.
  // The measured extent stays as a fallback for a caller that builds a bundle
  // by hand (test harnesses) and has placements but no chain row.
  const measured = openOuter
    ? maxTrayZ + contentTopLocal + restOffset
    : (cases.placements.length
        ? Math.max(...cases.placements.map(pl => pl.z + orient(co, pl.orientation).h/2)) : 0);
  const loadH = typeof cases.loadH === 'number' ? cases.loadH : measured;
  // Solid mode: no outer unit is opened — every one is a closed (textured) unit.
  // Otherwise open the pallet's own selected unit (S.pallet), indexed into the
  // pallet layout regardless of whether that outer tier is the case or carton.
  const openIdx = solid ? -1 : (S.pallet ?? nearestCameraCorner(cases.placements));

  // DOUBLE-STACK: two full unit loads high — pallet, load, PALLET, load. The
  // warehouse condition the BCT doubling models (bct.js boxesAboveBottom) is
  // drawn here too, in this ONE pallet render path (the deleted Palletize
  // renderer used to draw it; the consolidation, 5e103c6, dropped the drawing
  // while keeping the BCT math). Each unit load repeats deck + stack at its
  // own y offset, so the second load carries its own timber — never a load
  // floating deckless on the first. The cutaway opens a unit in the BOTTOM
  // load only; the upper load is all closed (there is one selection, and the
  // bottom load is the one whose slot it names).
  const nLoads = bundle.doubleStack ? 2 : 1;
  const oneLoadH = deckH + loadH;
  for(let u = 0; u < nLoads; u++){
    const yOff = u*oneLoadH;
    const uOpenIdx = u === 0 ? openIdx : -1;

    // the ONE shared GMA pallet (base at y=0, top-deck face at deckH == 127) —
    // the SAME asset the Palletize view built, so every load rides identical
    // timber instead of a bare slab. Named so tests can count decks.
    // built to the CHAIN's deck height, the same deckH the load is stacked
    // from — a fixed-height mesh floats the load above its own deck
    const timber = buildGmaPallet(bundle.cases.deck.L, bundle.cases.deck.W, deckH);
    timber.name = 'gmaPallet';
    timber.position.y = yOff;
    group.add(timber);

    // closed units — textured when the pallet's pack (the outer tier: case, or
    // carton once the case is off) has artwork, so a printed pallet shows the art
    // on every case; else bare board, instanced per orientation.
    //
    // openTrayInstances is NOT wired for pallet explosion (its shell+cartons+
    // skin are one combined instancing pass per tray, unlike the other two
    // branches' plain per-case positions) — an open-top/shrink pallet outer
    // tier stays assembled even with explode on. Documented gap, not silent.
    const casePlacements = (openOuter || shrinkOuter) ? cases.placements : explodedCases;
    const closed = casePlacements.map((pl, i) => ({pl, i})).filter(x => x.i !== uOpenIdx);
    const art = outerTier.art;
    // closed units pick as 'pallet' (open THIS pallet slot), never the inner tier
    // name — clicking a carton on the pallet must set the pallet's own selection,
    // not the "which pack inside a carton" one that shares the 'carton' key.
    if(openOuter || shrinkOuter){
      // Contents-visible units: an OPEN tray (shell + proud cartons), a SHRINK
      // BUNDLE (no shell, cartons + skin), or a shrink-wrapped tray (shell +
      // cartons + skin). One draw pass instances the parts across the pallet;
      // the shrink skin is a translucent box per unit rising to the loaded top.
      openTrayInstances(closed, outerTier.geo, bundle.cartonGeo, bundle.cartons.placements, yOff + deckH + restOffset,
        {shell: openOuter, skin: shrinkOuter, skinH: contentTopLocal + co.H/2});
    }else if(art && art.am && art.canvas && closed.length){
      for(const m of artInstances(art.am, art.canvas, closed, pl => ({x: pl.x, y: yOff + deckH + pl.z, z: pl.y}), 'pallet')) group.add(m);
    }else{
      for(const [o, list] of groupByOrientation(explodedCases, uOpenIdx)){
        const od = orient(co, o);
        const cgeo = roundedBoxGeo(Math.max(od.l - 2, 1), Math.max(od.h - 2, 1), Math.max(od.w - 2, 1), 3, 2);
        const inst = new THREE.InstancedMesh(cgeo, board, list.length);
        const M = new THREE.Matrix4();
        list.forEach(({pl}, k) => { M.identity(); M.setPosition(pl.x, yOff + deckH + pl.z, pl.y); inst.setMatrixAt(k, M); });
        inst.userData = {pick: list.map(x => x.i), tierName: 'pallet'};
        pickables.push({mesh: inst, tier: 'pallet'});
        group.add(inst);
      }
    }
    if(u === 0 && !solid && explodedCases[openIdx]){
      const pl = explodedCases[openIdx];
      const cg = buildContainer(outerTier, bundle, S, [openIdx], {explode});
      cg.position.set(pl.x, yOff + deckH + pl.z + restOffset, pl.y);   // rest on the slot floor, like the field
      cg.quaternion.copy(orientQuat(pl.orientation));
      group.add(cg);
    }
  }
  group.position.y = -(nLoads*oneLoadH)/2;
  return {
    // span drives camera framing: single-load framing is bit-identical to
    // before (loadH), a double stack frames the full two-load column
    span: Math.max(bundle.cases.deck.L, bundle.cases.deck.W, nLoads === 1 ? loadH : nLoads*oneLoadH),
    // loaded pallet: the deck footprint x the FULL stacked height — every
    // deck and every load (pallet+load, doubled when double-stacked), so the
    // Dims overlay total is the real floor-to-top height
    outer: {L: bundle.cases.deck.L, W: bundle.cases.deck.W, H: nLoads*oneLoadH}
  };
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
/** Count the rendered meshes in the current hierarchy group — a test hook for
 *  the "no enabled level with valid geometry ever blanks a view" invariant:
 *  a view that should show contents but rendered nothing reads as an empty
 *  (or container-only) group. Read-only. */
export function renderedMeshCount(){
  if(!group) return 0;
  let n = 0;
  group.traverse(o => { if(o.isMesh || o.isInstancedMesh) n++; });
  return n;
}

function clear(){
  const pivot = getPivot();
  if(group){ pivot.remove(group); group.traverse(o => { if(o.geometry) o.geometry.dispose(); }); }
  // per-build art materials own a CanvasTexture each — dispose them (the shared
  // board/film/piece materials are module-level and must NOT be disposed). The
  // hierarchy rebuilds on every orbit pointerup, so leaking here would grow the
  // GPU texture pool unbounded.
  artResources.forEach(m => { if(m.map) m.map.dispose(); m.dispose(); });
  artResources = [];
  group = null; cutawayWalls = []; pickables = [];
}

export function dispose(){ clear(); if(disposeFrame){ disposeFrame(); disposeFrame = null; } }
