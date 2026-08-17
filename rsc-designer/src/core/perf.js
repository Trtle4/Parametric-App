/**
 * Perforation — the tear line on a rigid tube container.
 *
 * A perforation is a CAPABILITY APPLIED TO A CONTAINER, not a style. Nothing
 * here knows what a reverse tuck end is or how an RSC slots; it reads the
 * girth decomposition the style already publishes (`meta.artMap`) and writes
 * a path. Any style that publishes that decomposition gets perf for free, and
 * a style that does not (the tray's flat cross-blank, the flexible wraps) is
 * reported as out of scope rather than approximated.
 *
 * THE SINGLE SOURCE IS `cornerH` — the retained height at each of the four
 * VERTICAL CORNERS. Every panel's tear line starts at its own corner's height
 * and ends at the next one's, so the loop is continuous BY CONSTRUCTION: two
 * panels meeting at a corner read the same number, and there is no second
 * place where a corner height could be stated and disagree. The per-panel
 * settings shape what happens BETWEEN the corners; they can never move one.
 *
 * PANEL AND CORNER INDEXING FOLLOWS THE EXISTING ARTWORK CONVENTION, not a
 * new one. Every rigid tube style (fefco201, a6120, sealend) publishes the
 * identical `meta.artMap.section`
 *      [-L/2,-W/2] → [L/2,-W/2] → [L/2,W/2] → [-L/2,W/2] → close
 * with FRONT at +Z and RIGHT at +X (the same frame render/folds/*.js builds
 * its walls in), and a matching `meta.artMap.faces` walk
 *      back(-Z) → side(+X) → front(+Z) → side(-X)
 * each face carrying its OWN blank x-range. That last part is what makes one
 * convention serve both levels: the carton panel run is
 * [glue | back | side | FRONT | side] and the case's is
 * [glue | FRONT | side | back | side] — half a girth apart — but both declare
 * `faces` in the same girth order, so the girth walk is shared and only the
 * u-ranges differ. Panels are therefore never indexed by blank position here.
 *
 *   corner i  =  section vertex i        panel i  =  corner i → corner i+1
 *   c0 back-left   c1 back-right   c2 front-right   c3 front-left
 *   p0 back        p1 right        p2 front         p3 left
 *
 * The girth walk is CONTIGUOUS ON THE BLANK for both levels apart from ONE
 * wrap at the manufacturer's joint (a6120 wraps x5→x1, fefco201 wraps x5→x1
 * between `right` and `front`), which is the same physical corner seen from
 * the two ends of the blank. So a path built once in folded panel space maps
 * to the blank without a per-style branch and without a discontinuity.
 *
 * THE PATH CROSSES THE JOINT FLAP TOO. The flap is glued behind the panel at
 * the far end of the girth; unperforated, that glued lap holds the two halves
 * of the pack together and nothing opens. Its run is found geometrically —
 * everything left of the first panel, clipped to the style's own cut outline
 * because every joint flap here is chamfered — never from a glue parameter.
 *
 * THE PATH IS BUILT IN FOLDED PANEL SPACE (s along the panel from its start
 * corner, h above the body's bottom crease) and mapped to the blank at the
 * end. Nothing here places a coordinate in blank space by hand.
 *
 * DXF R12 has no ARC in this exporter (export/dxf.js emits LINE entities
 * only), so fillets are POLYGONISED, to a sagitta of PERF_CHORD_TOL. The same
 * tolerance drives the s-curve/bow sampling, so one number governs how closely
 * every curve in the path is followed.
 *
 * DOM-free, mm-only, no dependency.
 */

/** Girth order — the order of `meta.artMap.faces`, which is the order of the
 *  section walk. `faces` names both sides 'side'; position disambiguates. */
export const PERF_PANELS = Object.freeze(['back', 'right', 'front', 'left']);

/** Corner i is section vertex i. Names are for the UI; the index is the key. */
export const PERF_CORNERS = Object.freeze(['back-left', 'back-right', 'front-right', 'front-left']);

/** What a panel does between its two corners.
 *  full     — retained whole: the line rides up to the top crease and back
 *  profiled — the flats/transition/bow profile (the general case)
 *  removed  — taken away whole: the line drops to the bottom crease and back */
export const PERF_MODES = Object.freeze(['full', 'profiled', 'removed']);

/** How a profiled panel gets from one corner height to the other. */
export const PERF_TRANSITIONS = Object.freeze(['straight', 'scurve', 'stepped']);

/** Which state the pack is shown/costed in. */
export const PERF_STATES = Object.freeze(['closed', 'display']);

/** Max sagitta, mm, when a curve or a fillet is polygonised. The DXF exporter
 *  writes LINE entities only — see export/dxf.js — so every arc in this module
 *  is chords, and this is how far a chord may sit from the true arc.
 *
 *  THE ONLY POLYGONISATION IN THE CODEBASE IS HERE. Consumers transcribe the
 *  points this module produces; none of them re-tolerances, and a pin asserts
 *  the DXF entity count moves with this number rather than being fixed by the
 *  exporter. `buildPerfPath` takes an override so a test can vary it without
 *  editing the module. */
export const PERF_CHORD_TOL = 0.1;

/** Chords per arc, floor. A radius small enough that one chord would meet the
 *  tolerance still has to LOOK round: three chords across a right angle reads
 *  as a chamfer, not a fillet. */
export const PERF_MIN_ARC_SEGMENTS = 4;

/** Stepped transitions: at least two treads, and a cap so a typo cannot emit
 *  a thousand risers. */
export const PERF_STEP_RANGE = Object.freeze({min: 2, max: 24});

/** The lip a tear leaves above the panel's base crease, mm.
 *
 *  A tear ON that crease would need the edge to FOLD during erection and
 *  SEPARATE at point of sale. It cannot do both, and a diemaker handed a
 *  crease and a perf at one coordinate has to guess which to set — ambiguous
 *  output is the defect, not the overlap. So the tear is forbidden from
 *  reaching either body crease by a clamp, not by a render-time nudge:
 *  `cornerH` is held inside [minRetainedH, H - minRetainedH], and `removed`
 *  means the tear runs at `minRetainedH`, leaving a lip. That is what real
 *  packs do anyway — a zero-height wall gives the tear no material to run in. */
export const PERF_MIN_RETAINED_DEFAULT = 3;

/** Perforation specification — the cut/tie pattern of the rule itself. It is
 *  metadata (the line is drawn as a line; the DXF PERF layer carries the
 *  DASHED linetype), carried here so one number reaches the spec sheet. */
export const PERF_SPEC_DEFAULT = Object.freeze({cut: 8, tie: 1.5});

const EPS = 1e-9;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const num = (v, fb) => (typeof v === 'number' && isFinite(v)) ? v : fb;

/* ---------------------------------------------------------------- frame --- */

/**
 * The girth decomposition perforation needs, read off the style's own artwork
 * map. Returns null — never a guess — for anything that does not publish one:
 * the flexible wraps (no panels), the FEFCO 0300 tray (`artMap.flat`, an open
 * cross-blank whose four walls run four different ways in the flat).
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {null|{H:number, panels:Array, minWidth:number}}
 */
export function perfFrame(geo){
  if(!geo || geo.structure !== 'rigid') return null;
  const am = geo.meta && geo.meta.artMap;
  if(!am || am.flat) return null;
  if(!Array.isArray(am.faces) || am.faces.length !== 4) return null;
  if(!Array.isArray(am.section) || am.section.length !== 5) return null;
  // the convention this module indexes by, asserted rather than assumed: a
  // style that declared its faces in another order would silently perforate
  // the wrong walls.
  if(am.faces[0].panel !== 'back' || am.faces[2].panel !== 'front') return null;

  const H = am.faces[0].v1 - am.faces[0].v0;
  if(!(H > 0)) return null;

  const panels = am.faces.map((f, i) => ({
    name: PERF_PANELS[i],
    index: i,
    face: f.panel,
    u0: Math.min(f.u0, f.u1),
    u1: Math.max(f.u0, f.u1),
    v0: Math.min(f.v0, f.v1),
    width: Math.abs(f.u1 - f.u0),
    fromCorner: i,
    toCorner: (i + 1) % 4
  }));
  if(panels.some(p => !(p.width > 0) || Math.abs((am.faces[p.index].v1 - am.faces[p.index].v0) - H) > 1e-6)) return null;
  return {H, panels, minWidth: Math.min(...panels.map(p => p.width))};
}

/** Whether this geometry can carry a perforation at all. */
export const canPerforate = geo => perfFrame(geo) != null;

/** Why not, in the words the readout uses. */
export function perfUnavailableReason(geo){
  if(!geo) return 'no geometry';
  if(geo.structure !== 'rigid') return 'not applicable — flexible film has no panels to perforate';
  const am = geo.meta && geo.meta.artMap;
  if(!am || am.flat) return 'not applicable — open cross-blank, no continuous girth';
  return 'not applicable — this style publishes no panel girth';
}

/* -------------------------------------------------------------- defaults --- */

const defaultPanel = () => ({
  mode: 'profiled',
  flatA: 0,
  flatB: 0,
  transition: 'straight',
  bow: 0,
  steps: 3
});

/** A perf object for a geometry: disabled, with a level tear all round at
 *  0.40 H, which is what the first preset draws. */
export function defaultPerf(geo){
  const f = perfFrame(geo);
  const h = f ? f.H*0.40 : 0;
  return normalizePerf({
    enabled: false,
    state: 'closed',
    cornerH: [h, h, h, h],
    radius: 0,
    panels: {back: defaultPanel(), right: defaultPanel(), front: defaultPanel(), left: defaultPanel()},
    spec: {...PERF_SPEC_DEFAULT}
  }, geo);
}

/* --------------------------------------------------------------- clamps --- */

/**
 * THE WRITE-TIME CLAMP. Every path into `project.perf` goes through this, so
 * the stored object is always already legal and the render, the exporters and
 * the readouts all see the same numbers. Clamping at render time instead would
 * put a second, silent opinion about a value next to the stored one — the
 * two-writer failure this codebase has been bitten by before.
 *
 * Pure: takes a (possibly partial, possibly absent) perf and a geometry,
 * returns a complete new one. Never mutates its input.
 */
export function normalizePerf(perfIn, geo){
  const p = perfIn || {};
  const f = perfFrame(geo);
  const H = f ? f.H : 0;

  // the lip, first: it bounds every other height. Capped at 0.4 H so the two
  // bounds it creates can never cross on a shallow container.
  const minRetainedH = f ? clamp(num(p.minRetainedH, PERF_MIN_RETAINED_DEFAULT), 0, H*0.4) : 0;
  const loH = minRetainedH, hiH = H - minRetainedH;

  const cornerIn = Array.isArray(p.cornerH) ? p.cornerH : [];
  const cornerH = [0, 1, 2, 3].map(i => clamp(num(cornerIn[i], H*0.40), loH, hiH));

  // a fillet can be no larger than half the shortest thing it has to sit in
  const radius = f ? clamp(num(p.radius, 0), 0, Math.min(H, f.minWidth)/2) : 0;

  const panels = {};
  for(const name of PERF_PANELS){
    const src = (p.panels && p.panels[name]) || {};
    const fp = f ? f.panels.find(x => x.name === name) : null;
    const width = fp ? fp.width : 0;
    const i = fp ? fp.fromCorner : 0, j = fp ? fp.toCorner : 0;
    const hA = cornerH[i], hB = cornerH[j];

    const mode = PERF_MODES.includes(src.mode) ? src.mode : 'profiled';
    const transition = PERF_TRANSITIONS.includes(src.transition) ? src.transition : 'straight';
    // flats are measured along the panel and cannot together outrun it; a
    // sum of exactly the width is legal and means "no transition span", a
    // vertical step where the two flats meet.
    const flatA = clamp(num(src.flatA, 0), 0, width);
    const flatB = clamp(num(src.flatB, 0), 0, Math.max(0, width - flatA));
    // the profile is base + bow·4t(1−t); base never leaves [min(hA,hB),
    // max(hA,hB)] and 4t(1−t) never exceeds 1, so this bound keeps the whole
    // curve inside the panel without having to evaluate it.
    const bow = clamp(num(src.bow, 0), loH - Math.min(hA, hB), hiH - Math.max(hA, hB));
    const steps = clamp(Math.round(num(src.steps, 3)), PERF_STEP_RANGE.min, PERF_STEP_RANGE.max);
    panels[name] = {mode, flatA, flatB, transition, bow, steps};
  }

  const specIn = p.spec || {};
  const spec = {
    cut: clamp(num(specIn.cut, PERF_SPEC_DEFAULT.cut), 0.5, 50),
    tie: clamp(num(specIn.tie, PERF_SPEC_DEFAULT.tie), 0.1, 20)
  };

  return {
    enabled: !!p.enabled,
    state: PERF_STATES.includes(p.state) ? p.state : 'closed',
    minRetainedH, cornerH, radius, panels, spec
  };
}

/** The cut/tie pattern, as the readout and the spec sheet state it. */
export const perfSpecLabel = spec =>
  `${(+spec.cut).toFixed(1)} mm cut / ${(+spec.tie).toFixed(1)} mm tie`;

/** A perforated pack SHOWN OPEN is not a closed box: it has no top, and the
 *  compression number for a closed box does not describe it. One reader, so
 *  the BCT panel and the readout cannot disagree about when that applies. */
export const isDisplayState = perf => !!(perf && perf.enabled && perf.state === 'display');

/* --------------------------------------------------------------- curves --- */

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Chords needed to hold an arc of `sweep` radians at radius `r` within
 *  `tol` of the true curve. sagitta = r(1 − cos(Δ/2)). */
function arcSegments(r, sweep, tol){
  if(!(r > 0) || !(sweep > 0)) return PERF_MIN_ARC_SEGMENTS;
  if(tol >= r) return PERF_MIN_ARC_SEGMENTS;
  const dMax = 2*Math.acos(1 - tol/r);
  return Math.max(PERF_MIN_ARC_SEGMENTS, Math.ceil(sweep/dMax));
}

/** Samples needed to hold a curve of bounded second derivative within `tol`.
 *  For a chord of run Δs the sagitta is |h''|Δs²/8. */
function curveSamples(span, d2, tol){
  if(!(span > 0)) return 1;
  if(!(d2 > 0)) return 1;
  const ds = Math.sqrt(8*tol/d2);
  return clamp(Math.ceil(span/ds), 1, 512);
}

function dedupe(pts){
  const out = [];
  for(const p of pts){
    const q = out[out.length - 1];
    if(!q || Math.abs(q[0] - p[0]) > EPS || Math.abs(q[1] - p[1]) > EPS) out.push(p);
  }
  return out;
}

/** Drop points that lie on the straight line between their neighbours. Keeps
 *  the emitted path minimal, so a straight ramp is two points and a DXF of a
 *  simple tear is a handful of LINEs. */
function dropCollinear(pts){
  if(pts.length < 3) return pts;
  const out = [pts[0]];
  for(let i = 1; i < pts.length - 1; i++){
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b[0] - a[0])*(c[1] - a[1]) - (b[1] - a[1])*(c[0] - a[0]);
    const scale = Math.max(dist(a, b), dist(b, c), 1);
    if(Math.abs(cross)/scale > 1e-7) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * One panel's tear line in FOLDED PANEL SPACE: s from 0 at the panel's start
 * corner to `width` at its end corner, h above the body's bottom crease.
 * The two corner heights are inputs, never derived here.
 */
function profilePoints(spec, hA, hB, width, H, tol, minH){
  // `full` rides the TOP crease and `removed` the lip: both are the boundary
  // of the retained region, which is what the 3D reads. Whether either run is
  // a RULE the diemaker sets is a separate question, answered where the edges
  // are emitted — a full panel's top run is the existing crease, not a perf.
  if(spec.mode === 'full')    return dedupe([[0, hA], [0, H], [width, H], [width, hB]]);
  if(spec.mode === 'removed') return dedupe([[0, hA], [0, minH], [width, minH], [width, hB]]);

  const s0 = spec.flatA, s1 = width - spec.flatB, span = s1 - s0;
  const pts = [[0, hA]];
  if(s0 > EPS) pts.push([s0, hA]);

  if(span <= EPS){
    pts.push([s1, hB]);                                   // flats meet: a vertical step
  }else if(spec.transition === 'stepped'){
    const n = spec.steps;
    for(let k = 0; k < n; k++){
      const h = hA + (hB - hA)*(k/(n - 1));
      pts.push([s0 + span*(k/n), h], [s0 + span*((k + 1)/n), h]);
    }
  }else if(spec.transition === 'straight' && Math.abs(spec.bow) <= EPS){
    pts.push([s1, hB]);                                   // a straight ramp is two points
  }else{
    // scurve base is t²(3−2t): |base''| ≤ 6. bow is 4t(1−t): |''| = 8.
    const dh = Math.abs(hB - hA);
    const d2 = ((spec.transition === 'scurve' ? 6*dh : 0) + 8*Math.abs(spec.bow))/(span*span);
    const n = curveSamples(span, d2, tol);
    for(let k = 0; k <= n; k++){
      const t = k/n;
      const base = spec.transition === 'scurve' ? t*t*(3 - 2*t) : t;
      pts.push([s0 + span*t, hA + (hB - hA)*base + spec.bow*4*t*(1 - t)]);
    }
  }

  if(spec.flatB > EPS) pts.push([width, hB]);
  return dedupe(pts);
}

/**
 * Round the interior corners of a polyline to `r`, polygonised to `tol`.
 *
 * Only INTERIOR vertices are filleted: the two ends of a panel's line sit on
 * a vertical crease, where the board folds — a radius there is not a rounded
 * corner, it is a gap in the tear.
 */
export function filletPolyline(pts, r, tol = PERF_CHORD_TOL){
  if(!(r > 0) || pts.length < 3) return pts;
  const out = [pts[0]];
  for(let i = 1; i < pts.length - 1; i++){
    const A = out[out.length - 1], P = pts[i], B = pts[i + 1];
    const lA = dist(A, P), lB = dist(P, B);
    if(lA <= EPS || lB <= EPS){ out.push(P); continue; }
    const d1 = [(P[0] - A[0])/lA, (P[1] - A[1])/lA];
    const d2 = [(B[0] - P[0])/lB, (B[1] - P[1])/lB];
    const cross = d1[0]*d2[1] - d1[1]*d2[0];
    const dot = d1[0]*d2[0] + d1[1]*d2[1];
    const phi = Math.atan2(Math.abs(cross), dot);         // turn angle, 0..π
    if(phi < 1e-6 || Math.PI - phi < 1e-6){ out.push(P); continue; }

    // never eat more than half of either neighbour, so two adjacent fillets
    // cannot overlap and swallow the vertex between them
    const tanLen = Math.min(r*Math.tan(phi/2), lA*0.5, lB*0.5);
    const rr = tanLen/Math.tan(phi/2);
    if(rr < 1e-6){ out.push(P); continue; }

    const S = [P[0] - d1[0]*tanLen, P[1] - d1[1]*tanLen];
    const E = [P[0] + d2[0]*tanLen, P[1] + d2[1]*tanLen];
    const sgn = cross > 0 ? 1 : -1;                       // centre is to the inside of the turn
    const C = [S[0] - sgn*d1[1]*rr, S[1] + sgn*d1[0]*rr];
    const a0 = Math.atan2(S[1] - C[1], S[0] - C[0]);
    const a1 = Math.atan2(E[1] - C[1], E[0] - C[0]);
    let sweep = a1 - a0;
    while(sweep > Math.PI) sweep -= 2*Math.PI;
    while(sweep < -Math.PI) sweep += 2*Math.PI;

    const n = arcSegments(rr, Math.abs(sweep), tol);
    out.push(S);
    for(let k = 1; k < n; k++){
      const a = a0 + sweep*(k/n);
      out.push([C[0] + rr*Math.cos(a), C[1] + rr*Math.sin(a)]);
    }
    out.push(E);
  }
  out.push(pts[pts.length - 1]);
  return dedupe(out);
}

/* ------------------------------------------------------- the joint flap --- */

/**
 * Where the blank's cut outline sits at a given height, to the LEFT of `xMax`.
 *
 * The manufacturer's joint flap is a tongue on one end of the blank, and it is
 * CHAMFERED on every style here — so "the flap runs to x = 0" is true at
 * mid-height and wrong near the top and bottom creases. Rather than assume a
 * width, scan the cut polygon the style already published. Returns null when
 * the outline has no crossing there (no flap, or a height outside it).
 */
function outlineLeftOf(cut, y, xMax){
  let best = null;
  for(let i = 0; i < cut.length; i++){
    const a = cut[i], b = cut[(i + 1) % cut.length];
    if((a[1] > y) === (b[1] > y)) continue;               // no crossing at this y
    const x = a[0] + (b[0] - a[0])*((y - a[1])/(b[1] - a[1]));
    if(x < xMax - EPS && (best === null || x < best)) best = x;
  }
  return best;
}

/**
 * The tear line's continuation across the manufacturer's joint flap.
 *
 * The flap is glued BEHIND the panel at the far end of the girth, so the two
 * layers sit face to face at the same corner. If the flap were not perforated
 * the glued lap would hold the two halves of the pack together and nothing
 * would open. Its height is the wrap corner's retained height — the same
 * `cornerH` entry the two panels meeting there read, so there is still exactly
 * one number for that corner.
 *
 * The flap is found geometrically (everything on the blank to the left of the
 * first panel), never by style id and never from a glue parameter.
 */
function jointFlapRun(geo, frame, cornerH){
  const minU = Math.min(...frame.panels.map(p => p.u0));
  if(minU - geo.bbox.minX <= EPS) return null;            // no flap on this blank
  const start = frame.panels.find(p => p.u0 === minU);
  const h = cornerH[start.fromCorner];
  const y = start.v0 + h;
  const xL = outlineLeftOf(geo.cut, y, minU);
  if(xL === null || minU - xL <= EPS) return null;
  return {corner: start.fromCorner, h, y, x0: xL, x1: minU, width: minU - xL};
}

/* ----------------------------------------------------------------- path --- */

/**
 * The tear line, folded panel space AND blank space, from one build.
 *
 * `onFold` marks an edge that lies along an existing rule — a vertical panel
 * crease, or the body's top/bottom crease. Those edges are real perforation
 * (a panel that tears away has to be perforated where it meets its
 * neighbour, not creased there), but a die already carries a line at that
 * position, so the consumer has to decide whether to REPLACE the crease or
 * draw over it. This module reports the fact and leaves the policy to the
 * consumer rather than silently dropping geometry.
 *
 * @param {import('./types.js').Geometry} geo
 * @param {Object} perfIn  project.perf (normalized here regardless)
 * @returns {null|Object}  null when perf is off or the style cannot carry it
 */
export function buildPerfPath(geo, perfIn, opts){
  const f = perfFrame(geo);
  if(!f) return null;
  const perf = normalizePerf(perfIn, geo);
  if(!perf.enabled) return null;
  const tol = (opts && opts.chordTol > 0) ? opts.chordTol : PERF_CHORD_TOL;

  const H = f.H;
  const panels = f.panels.map(fp => {
    const spec = perf.panels[fp.name];
    const hA = perf.cornerH[fp.fromCorner], hB = perf.cornerH[fp.toCorner];
    const raw = profilePoints(spec, hA, hB, fp.width, H, tol, perf.minRetainedH);
    const pts = dropCollinear(filletPolyline(raw, perf.radius, tol));
    return {
      name: fp.name, index: fp.index, face: fp.face, mode: spec.mode,
      width: fp.width, u0: fp.u0, u1: fp.u1, v0: fp.v0,
      fromCorner: fp.fromCorner, toCorner: fp.toCorner, hA, hB,
      pts,                                                // folded panel space
      blank: pts.map(([s, h]) => [fp.u0 + s, fp.v0 + h])  // the ONE mapping
    };
  });

  const edges = [];
  let tearLength = 0;
  // the joint flap first, so the path reads left to right across the blank
  const flap = jointFlapRun(geo, f, perf.cornerH);
  if(flap){
    const onFold = Math.abs(flap.h) <= EPS || Math.abs(flap.h - H) <= EPS;
    edges.push({panel: 'joint', a: [flap.x0, flap.y], b: [flap.x1, flap.y], onFold});
    tearLength += flap.width;
  }
  // EDGES ARE EMITTED IN BLANK ORDER, not girth order. The two differ on the
  // case (its girth walk starts mid-blank), and a consumer that strokes the
  // path — the dieline joins contiguous segments into one run so the dash
  // pattern survives a curve — would see it broken into pieces for no reason
  // other than the order they arrived in. The girth order stays on `panels`,
  // which is where the geometry is read from.
  for(const p of [...panels].sort((a, b) => a.u0 - b.u0)){
    for(let i = 0; i < p.blank.length - 1; i++){
      const a = p.blank[i], b = p.blank[i + 1];
      const s0 = p.pts[i], s1 = p.pts[i + 1];
      const vertical = Math.abs(a[0] - b[0]) <= EPS;
      const horizontal = Math.abs(a[1] - b[1]) <= EPS;
      // A HORIZONTAL RUN ON A BODY CREASE IS NOT A PERFORATION. A `full`
      // panel's top run IS the top crease, where the closure flaps fold: the
      // panel is retained whole, so nothing tears across it and the only real
      // rules it contributes are the two risers that release its neighbours.
      // Emitting a perf there would hand the diemaker two rules at one
      // coordinate — the defect this whole resolution exists to prevent. The
      // point stays on `panels[].pts`, which is the retained region's
      // BOUNDARY and what the 3D reads; only the RULE is withheld.
      const onBodyCrease = horizontal && (Math.abs(s0[1]) <= EPS || Math.abs(s0[1] - H) <= EPS);
      if(onBodyCrease) continue;
      // a vertical run rides a panel fold. That one is resolved the other
      // way — the crease is SHORTENED (see trimCreases) — because above it
      // the two panels genuinely have to separate.
      const onFold = vertical && (Math.abs(s0[0]) <= EPS || Math.abs(s0[0] - p.width) <= EPS);
      edges.push({panel: p.name, a, b, onFold});
      tearLength += dist(a, b);
    }
  }

  return {
    H, radius: perf.radius, state: perf.state, spec: perf.spec,
    minRetainedH: perf.minRetainedH,
    chordTol: tol,
    cornerH: perf.cornerH.slice(),
    panels, flap, edges,
    segments: edges.map(e => [e.a[0], e.a[1], e.b[0], e.b[1]]),
    tearLength
  };
}

/* ------------------------------------------------- crease resolution --- */

/** Subtract a set of 1D cut spans from a 1D span, returning what survives. */
function subtractSpans(a, b, cuts, eps){
  let spans = [[Math.min(a, b), Math.max(a, b)]];
  for(const [c0, c1] of cuts){
    const next = [];
    for(const [lo, hi] of spans){
      if(c1 <= lo + eps || c0 >= hi - eps){ next.push([lo, hi]); continue; }
      if(c0 > lo + eps) next.push([lo, c0]);
      if(c1 < hi - eps) next.push([c1, hi]);
    }
    spans = next;
  }
  return spans.filter(([lo, hi]) => hi - lo > eps);
}

/**
 * THE RULING: never two rules at one coordinate.
 *
 * A diemaker handed a CREASE and a PERF at the same place has to guess which
 * to set, and ambiguous output is the defect — the overlap is only how it
 * shows up. Two cases, two resolutions, and this is the second one.
 *
 * Where the tear runs VERTICALLY along a girth corner, the crease is
 * SHORTENED to the span the perf does not occupy. That is not a drawing
 * convenience: over that span the two panels genuinely have to separate (a
 * full side beside a profiled front is retained on one side of the fold and
 * removed on the other), and a creasing rule there would be wrong. Below it —
 * or above it, when a panel is removed and its lip stays — both sides are
 * retained together and the fold is required, so the crease stays.
 *
 * The rule is read off the PATH, never off the mode: whatever vertical run
 * the path contains is what the crease gives up. `full` beside `profiled`
 * yields crease-below/perf-above, `removed` yields crease/perf/crease, and a
 * plain profiled girth yields no vertical run at all and no trimming — which
 * is right, because there the tear passes straight through the corner and the
 * lid above it is still a tube that had to fold.
 *
 * Horizontal creases are handled too, for completeness; the write-time
 * `minRetainedH` clamp means a tear can no longer reach one.
 */
export function trimCreases(crease, edges, eps = 1e-6){
  if(!Array.isArray(crease) || !crease.length || !edges || !edges.length) return crease;
  const vert = [], horz = [];
  for(const e of edges){
    if(Math.abs(e.a[0] - e.b[0]) <= eps) vert.push(e);
    else if(Math.abs(e.a[1] - e.b[1]) <= eps) horz.push(e);
  }
  const out = [];
  let changed = false;
  for(const c of crease){
    const isVert = Math.abs(c[0] - c[2]) <= eps;
    const isHorz = Math.abs(c[1] - c[3]) <= eps;
    // an oblique crease has no oblique perf to collide with in this model
    if(!isVert && !isHorz){ out.push(c); continue; }
    const along = isVert ? 1 : 0;                    // the axis the crease runs on
    const across = isVert ? 0 : 1;                   // the axis it sits at
    const cuts = (isVert ? vert : horz)
      .filter(e => Math.abs(e.a[across] - c[across]) <= eps)
      .map(e => [Math.min(e.a[along], e.b[along]), Math.max(e.a[along], e.b[along])]);
    if(!cuts.length){ out.push(c); continue; }
    const spans = subtractSpans(c[along], c[along + 2], cuts, eps);
    if(spans.length === 1 && Math.abs(spans[0][0] - Math.min(c[along], c[along + 2])) <= eps
       && Math.abs(spans[0][1] - Math.max(c[along], c[along + 2])) <= eps){ out.push(c); continue; }
    changed = true;
    for(const [lo, hi] of spans)
      out.push(isVert ? [c[0], lo, c[0], hi] : [lo, c[1], hi, c[1]]);
  }
  return changed ? out : crease;
}

/** The `geo.aux` contribution — the hook export/dxf.js already consumes and
 *  render/dieline2d.js will. Null when there is nothing to add, so a geometry
 *  with perf off carries no `aux` key at all and its DXF is byte-identical to
 *  the one it produced before this module existed. */
export function perfAux(geo, perf, opts){
  const path = buildPerfPath(geo, perf, opts);
  return path && path.segments.length ? {PERF: path.segments} : null;
}

/**
 * A geometry with its level's perforation RESOLVED onto it: the PERF layer in
 * `aux`, the coincident crease spans given up, and the path itself on
 * `geo.perf` so the 3D reads the same points the 2D drew rather than deriving
 * its own. The SAME object back when there is no perforation, so a geometry
 * that has never been perforated is untouched — not a copy that compares equal.
 */
export function withPerforation(geo, perf, opts){
  const path = geo ? buildPerfPath(geo, perf, opts) : null;
  if(!path || !path.segments.length) return geo;
  return {
    ...geo,
    crease: trimCreases(geo.crease, path.edges),
    aux: {...(geo.aux || {}), PERF: path.segments},
    perf: {state: path.state, spec: path.spec, minRetainedH: path.minRetainedH, path}
  };
}

/** True when this geometry should RENDER as opened for display. */
export const isDisplayGeo = geo => !!(geo && geo.perf && geo.perf.state === 'display');

/* ---------------------------------------------------------- spec sheet --- */

/**
 * The perforation block for the spec sheet: rows of [label, value], and
 * nothing else. TEXT ONLY — no consumer of this feeds a calculation, and the
 * values are formatted here rather than by the sheet so the sheet cannot
 * round one of them differently from the readout.
 *
 * Returns a "not perforated" row rather than nothing, because a spec sheet
 * that is silent about perforation reads the same whether the pack has none
 * or the sheet forgot to say.
 *
 * @param {Function} [fmt]  length formatter (mm -> display string)
 */
export function perfSpecRows(geo, perfIn, fmt = v => `${(+v).toFixed(1)} mm`){
  const path = geo ? buildPerfPath(geo, perfIn) : null;
  if(!path) return [['Perforated', 'No']];
  const modeOf = p => p.mode === 'profiled'
    ? `${fmt(p.hA)} → ${fmt(p.hB)}`
    : `${p.mode}, ${fmt(Math.max(...p.pts.map(v => v[1])))} retained`;
  const rows = [
    ['Perforated', `Yes — ${path.state === 'display' ? 'shown in display state' : 'shown as shipped'}`],
    ['Rule', perfSpecLabel(path.spec)],
    ['Minimum retained height', fmt(path.minRetainedH)],
    ['Retained corner heights', PERF_CORNERS.map((n, i) => `${n} ${fmt(path.cornerH[i])}`).join(' · ')],
    // ONE row for the panels, not four. "Panels affected" is one fact; four
    // rows of it pushed the sheet's section column into the image below it.
    ['Panels', path.panels.map(p => `${p.name} ${modeOf(p)}`).join(' · ')],
    ['Tear length', fmt(path.tearLength)]
  ];
  // rides along: a spec sheet that reads clean for a pack that will not
  // open is worse than no spec sheet at all.
  const warn = openabilityWarning(geo, perfIn);
  if(warn) rows.push(['⚠ ' + warn.title, warn.detail]);
  return rows;
}

/* --------------------------------------------------------- openability --- */

/**
 * WILL THE LID ACTUALLY COME OFF?
 *
 * A tear that runs all the way round still leaves the pack shut if part of
 * the CLOSURE stays behind. Retain a panel to its full height and its top
 * flap stays on the base — and on most closures that flap is bonded to the
 * flaps going with the lid, so the lid is tethered to the thing it is
 * supposed to leave.
 *
 * WHICH flap holds and which merely rests is a fact about the CLOSURE, not
 * about perforation, so each style declares it (`meta.closure.top`) and this
 * function only reads. The three shipped closures genuinely differ, and
 * generalising from any one of them gives the wrong answer for the others:
 *
 *   FEFCO 201  minors in, majors over, taped across the centre seam. A
 *              retained MAJOR is taped to the one leaving; a retained MINOR
 *              is only lain on, and the majors lift straight off it.
 *   A6120      the lid IS the front panel's tuck; the back has no top flap
 *              at all. Only a retained tuck panel blocks.
 *   Seal end   the seal flap is GLUED over the major and both dust flaps, so
 *              all four are one bonded piece and any of them holds.
 *
 * WARN, NEVER BLOCK. Asymmetric and unusual builds are legitimate; a pack
 * that will not open is a design error to show the user, not a state to
 * forbid. Nothing here is called from a write path.
 *
 * The BOTTOM closure is not at risk: `minRetainedH` keeps every tear above
 * the base crease, so a bottom flap always stays with the base, which is
 * where it belongs.
 *
 * `meta.closure.top` is DERIVED, inside each style's own `geometry()`, from
 * whatever build options that style actually has (fefco201's `outerFlaps`
 * swaps which pair is major) — so it is already correct for the LIVE build
 * by the time it gets here. This function only reads it; it never asks the
 * caller to confirm anything.
 * @returns {null|{panels:string[], parts:string[], title:string, detail:string}}
 */
export function openabilityWarning(geo, perfIn){
  const path = geo ? buildPerfPath(geo, perfIn) : null;
  if(!path) return null;
  const cl = geo.meta && geo.meta.closure;
  // a style that declares no closure gets no opinion — silence beats a guess
  if(!cl || !Array.isArray(cl.top)) return null;

  const held = [];
  for(const fl of cl.top){
    if(!fl.holdsLid) continue;
    const pan = path.panels[fl.panel];
    if(!pan) continue;
    if(Math.max(...pan.pts.map(p => p[1])) >= path.H - EPS)
      held.push({panel: pan.name, part: fl.part});
  }
  if(!held.length) return null;

  const list = held.map(h => `the ${h.panel} panel's ${h.part}`);
  const joined = list.length === 1 ? list[0]
    : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  return {
    panels: held.map(h => h.panel),
    parts: held.map(h => h.part),
    title: 'The lid will not separate',
    detail: `${held.length === 1 ? 'Panel' : 'Panels'} ${held.map(h => h.panel).join(', ')} ` +
      `${held.length === 1 ? 'is' : 'are'} retained to full height, so ${joined} ` +
      `${held.length === 1 ? 'stays' : 'stay'} on the base while the rest of the closure leaves with the lid. ` +
      `${cl.lidJoin.charAt(0).toUpperCase()}${cl.lidJoin.slice(1)} still joins them, so the lid is held. ` +
      `Tear the panel a few millimetres below its top crease instead of retaining it whole — ` +
      `the crease still folds during erection and the flap leaves with the lid.`
  };
}

/* -------------------------------------------------------------- presets --- */

/**
 * The five preset openings, as FRACTIONS of the container's own height and
 * width so one entry serves a carton and a case alike. `apply` returns a
 * complete, clamped perf — presets go through the same write-time clamp as a
 * typed number, never around it.
 */
export const PERF_PRESETS = Object.freeze([
  {
    id: 'tray', name: 'Shelf tray',
    hint: 'A level tear all round — tray below, lid above.',
    build: (H) => ({
      cornerH: [0.40*H, 0.40*H, 0.40*H, 0.40*H], radius: 0,
      panels: {back: {}, right: {}, front: {}, left: {}}
    })
  },
  {
    id: 'angled', name: 'Angled sides',
    hint: 'Back stays tall, front drops away, the sides ramp between them.',
    build: (H) => ({
      cornerH: [0.85*H, 0.85*H, 0.32*H, 0.32*H], radius: 0.10*H,
      panels: {back: {}, right: {}, front: {}, left: {}}
    })
  },
  {
    id: 'angled-flat', name: 'Angled, then flat',
    hint: 'The side ramp runs part-way, then levels off before the front.',
    build: (H, widths) => ({
      cornerH: [0.85*H, 0.85*H, 0.32*H, 0.32*H], radius: 0.10*H,
      panels: {
        back:  {},
        right: {flatA: 0.35*widths.right, flatB: 0.15*widths.right},
        front: {},
        left:  {flatA: 0.15*widths.left,  flatB: 0.35*widths.left}
      }
    })
  },
  {
    id: 'bowed', name: 'Bowed front',
    hint: 'Level corners with the front dished down in a smooth curve.',
    build: (H) => ({
      cornerH: [0.55*H, 0.55*H, 0.55*H, 0.55*H], radius: 0,
      panels: {back: {}, right: {}, front: {bow: -0.22*H}, left: {}}
    })
  },
  {
    id: 'open-front', name: 'Front removed',
    hint: 'The whole front panel comes away; the back stays at full height.',
    // THE BACK IS PROFILED, NOT `full`. Retaining it whole keeps its top flap
    // on the base, and on two of the three shipped closures that flap is
    // taped or glued to the ones leaving with the lid — so the pack tears all
    // the way round and still does not open. Asking for the very top instead
    // lets the write-time clamp put the tear at H - minRetainedH: the crease
    // still folds during erection, the flap leaves with the lid, and the
    // retained back is 3 mm shorter than a passer-by could measure. `full`
    // stays available to anyone who wants it, with the warning attached.
    build: (H) => ({
      cornerH: [H, H, 0, 0], radius: 0.08*H,
      panels: {back: {}, right: {transition: 'scurve'},
               front: {mode: 'removed'}, left: {transition: 'scurve'}}
    })
  }
]);

/**
 * Apply a preset to a geometry, keeping the perf's own enabled/state/spec.
 * @returns {Object|null} a normalized perf, or null if the style cannot perf
 */
export function applyPerfPreset(id, geo, current){
  const f = perfFrame(geo);
  const preset = PERF_PRESETS.find(p => p.id === id);
  if(!f || !preset) return null;
  const widths = {};
  for(const p of f.panels) widths[p.name] = p.width;
  const spec = preset.build(f.H, widths);
  const panels = {};
  for(const name of PERF_PANELS) panels[name] = {...defaultPanel(), ...(spec.panels[name] || {})};
  return normalizePerf({
    enabled: current ? !!current.enabled : true,
    state: current ? current.state : 'closed',
    spec: current ? current.spec : {...PERF_SPEC_DEFAULT},
    cornerH: spec.cornerH, radius: spec.radius, panels
  }, geo);
}
