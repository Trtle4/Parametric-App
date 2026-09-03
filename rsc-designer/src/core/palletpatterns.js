/**
 * Pallet pattern repertoire: enumerate every viable case-on-pallet layer
 * layout as ONE RANKED candidate list — aligned grids (both in-plane
 * orientations), two-block rotated strips (every viable split, not just the
 * best), sandwiched split bands with a central void (the same split, with
 * the short band re-centred instead of pushed to an edge), and perimeter
 * pinwheels with a central void — plus a per-layer interlock SCHEDULE (see
 * `layerFlips` below) each layout can be stacked with. Path B: the named
 * patterns EMERGE from enumerating these defined constructions; this is
 * NOT a general packing solver, and it must never grow into one.
 *
 * The list is the single source for the pallet: project.js chainMetrics
 * bakes list[0] into every candidate row (ranking / default), retains the
 * list on the row, and applyPatternSelection() re-reads list[patternIndex]
 * for the committed chain — the readout, the 3D render and the cycle
 * arrows all read that one selection. No consumer re-packs.
 *
 * DOM-free, mm-only. Layer→stack math delegates to core/pack.js stack()
 * with the same clearance normalization containment.js uses, so a
 * candidate's layers/total agree exactly with what fitInto reports for the
 * same layer. containment.js itself is untouched.
 *
 * Ranking: cases/pallet DESC (∝ cartons/pallet — the multiplier is the
 * same case), then packing DENSITY over the arrangement's own occupied
 * envelope DESC (equal-count layouts order by compactness — the deck-based
 * cube readout ties for equal counts, the envelope doesn't), then the
 * simpler construction (aligned < mixed < pinwheel, straight before
 * interlocked). Equal-count arrangements are all kept — six layouts that
 * each fit 60 cases are six physically different pallets; only GEOMETRIC
 * duplicates (identical placements) collapse.
 *
 * TWO PLACEMENT INVARIANTS, both enforced and both pinned by tests:
 *   1. CENTRED — every arrangement's footprint is centred on the deck, so
 *      the unused slack splits evenly on all four sides. Each construction
 *      is built centred (grids and strips on their own extent, pinwheels on
 *      the deck, whose bounds they meet by construction); nothing is placed
 *      from a corner origin.
 *   2. NO OVERHANG — see the deck-validity block below. A hard constraint,
 *      not a preference: invalid arrangements are rejected at generation.
 */
import {stack} from './pack.js';

const transpose = o => o[1] + o[0] + o[2];

/** Same normalization containment.js applies (private there): vertical
 *  clearances default to the legacy uniform shape when omitted. */
function normClearance(c){
  const wall = c.wall || 0, between = c.between || 0;
  return {
    wall, between,
    bottom:   c.bottom   !== undefined ? c.bottom   : wall,
    top:      c.top      !== undefined ? c.top      : wall,
    betweenZ: c.betweenZ !== undefined ? c.betweenZ : between
  };
}

/** Same pairing rule as containment.js: a transposed pair (LWH+WLH) shares a
 *  vertical axis with in-plane rotation allowed; a lone orientation forbids it. */
function orientationGroups(allowed){
  const groups = [], seen = new Set();
  for(const o of allowed){
    if(seen.has(o)) continue;
    seen.add(o);
    const t = transpose(o);
    const paired = allowed.includes(t);
    if(paired) seen.add(t);
    groups.push({base: o, allowRotate: paired});
  }
  return groups;
}

/* ---------------- layer constructions (deck-centred positions) ----------------
 * Cell/parent math matches pack.js exactly: effective parent PL/PW, cell
 * CL/CW, so N*case + (N-1)*between <= deck - 2*wall holds by construction.
 * positions: {x, y, rot} — rot flags the 90°-turned case, exactly as
 * packLayer emits, so downstream orientation mapping is identical. */

/** Aligned grid; rot=true lays the case 90° turned (cell CW×CL). */
function gridLayout(CL, CW, PL, PW, rot, square){
  const a = rot ? CW : CL, b = rot ? CL : CW;
  const nx = Math.floor(PL/a), ny = Math.floor(PW/b);
  if(nx < 1 || ny < 1) return null;
  const positions = [];
  for(let i = 0; i < nx; i++) for(let j = 0; j < ny; j++)
    positions.push({x: (i + 0.5)*a - nx*a/2, y: (j + 0.5)*b - ny*b/2, rot: rot && !square});
  return {positions, label: `${nx} × ${ny}${rot && !square ? ' rotated' : ''} grid`, family: 'aligned'};
}

/** Two-block guillotine strips — the same four families pack.js mixed()
 *  scans, but EMITTING every split with both blocks non-empty instead of
 *  keeping only the count-best (pure single-block splits are the aligned
 *  grids, which the aligned family already owns). */
function stripLayouts(CL, CW, PL, PW){
  const out = [];
  const fam = (U, V, a, b, swap) => {
    const rows = Math.floor(V/b), n2v = Math.floor(V/a);
    for(let k = 1; k <= Math.floor(U/a); k++){
      const n2u = Math.floor((U - k*a)/b);
      const n1 = k*rows, n2 = n2u*n2v;
      if(n1 <= 0 || n2 <= 0) continue;
      const maxU = k*a + n2u*b, positions = [];
      const rotA = a !== CL;                 // block-1 orientation
      for(let i = 0; i < k; i++) for(let j = 0; j < rows; j++){
        const u = (i + 0.5)*a - maxU/2, v = (j + 0.5)*b - rows*b/2;
        positions.push(swap ? {x: v, y: u, rot: !rotA} : {x: u, y: v, rot: rotA});
      }
      for(let i = 0; i < n2u; i++) for(let j = 0; j < n2v; j++){
        const u = k*a + (i + 0.5)*b - maxU/2, v = (j + 0.5)*a - n2v*a/2;
        positions.push(swap ? {x: v, y: u, rot: rotA} : {x: u, y: v, rot: !rotA});
      }
      out.push({positions, label: `${n1}+${n2} mixed`, family: 'mixed'});
    }
  };
  fam(PL, PW, CL, CW, false); fam(PL, PW, CW, CL, false);
  fam(PW, PL, CL, CW, true);  fam(PW, PL, CW, CL, true);
  return out;
}

/** A layer has slack in TWO INDEPENDENT directions, and they must never be
 *  conflated (that conflation was this construction's own bug — see the
 *  CORRECTION note below): band-normal (u) slack is a margin AROUND the
 *  group, and band-parallel (v) slack is a void INSIDE whichever band falls
 *  short of its neighbours' length. `bandRowsV` builds the v-positions for
 *  ONE band and is the single place either kind of v-layout happens: an
 *  ordinary centred block when this band's own extent already equals
 *  `bandLength` (the longer of the two — no shortfall, no void), or —
 *  when it falls short — `count` split into two EQUAL groups flush to the
 *  two ends of `bandLength`, the shortfall consolidated into ONE void
 *  between them. `count` must be even for that split to land EXACTLY
 *  centred (an odd count has no exact split — `null`, "not a candidate for
 *  this construction", the same rule `fam` already applies to an odd k). */
function bandRowsV(count, p, bandLength){
  const span = count*p;
  if(Math.abs(span - bandLength) < 1e-6)
    return Array.from({length: count}, (_, j) => (j + 0.5)*p - span/2);
  if(count % 2 !== 0) return null;
  const half = count/2, vs = [];
  for(let j = 0; j < half; j++) vs.push(-bandLength/2 + (j + 0.5)*p);   // flush to the − end
  for(let j = 0; j < half; j++) vs.push(bandLength/2 - (j + 0.5)*p);    // flush to the + end (exact mirror of the above)
  return vs;
}

/** Sandwiched split band with a central void — a DEFINED construction, not
 *  discovered: stripLayouts always puts its short (rotated) block at ONE
 *  end, so a "3+3+2" layer puts the short band at an edge. This splits the
 *  MAJORITY band's k columns into two EQUAL halves (k must be even — an odd
 *  k has no exact split, so that k is simply not a candidate for this
 *  construction, the same "doesn't apply here" the module already uses for
 *  a square footprint or a lone orientation) and puts the short (rotated)
 *  band between them.
 *
 *  CORRECTION — bands must be FLUSH. A layer has band-normal (u) slack and
 *  band-parallel (v) slack, and an earlier version of this construction
 *  sent both to the same place: the two majority halves were pushed flush
 *  to the layer's own OUTER edges (u = ±U/2), leaving the band-normal
 *  leftover as a gap BETWEEN each majority half and the short band —
 *  visually, a full-depth channel down each side of the middle band, not a
 *  "central void" at all. The two kinds of slack now go to the two places
 *  the physical picture actually has room for them:
 *    - band-normal (u): the THREE bands sit adjacent, sharing edges (zero
 *      gap), and the whole GROUP — not the layer's own bands individually —
 *      is centred on the deck, `(i + 0.5)*a - maxU/2` exactly like
 *      stripLayouts/pinwheelLayouts already centre their own footprints.
 *      Any leftover this leaves (U - maxU) is a margin OUTSIDE the group,
 *      split evenly on both sides by that same centring — never a gap
 *      between bands.
 *    - band-parallel (v): a band whose own v-extent falls short of its
 *      neighbours' does not silently absorb that shortfall as its own
 *      (smaller) centred block, which would just move the "channel"
 *      problem onto a different axis (splitting the shortfall into two
 *      end-margins instead of one). `bandRowsV` (above) is the fix: the
 *      short band's cases push to both v-ends of the LONGER reference
 *      length, and the shortfall becomes the ONE central void this
 *      construction is actually named for.
 *
 *  COUNT INVARIANCE: this only REARRANGES the exact same k*rows + n2u*n2v
 *  cells stripLayouts' own search would find for the matching k — it adds
 *  or removes none, so the total for a given k is identical either way, and
 *  this correction only MOVES positions, never changes counts.
 *
 *  Only the MAXIMAL (highest-total) even k is emitted per axis/orientation
 *  combo — the same pinwheel rule ("a variant that could grow is pure
 *  noise in the cycle list") — and only when the short band is non-empty
 *  (n2 >= 1) AND the two neighbouring lengths actually differ: with
 *  nothing to sandwich, or nothing to sandwich AROUND (rows*b === n2v*a —
 *  no shortfall, hence no void), this degenerates to a plain aligned grid
 *  split apart for no reason, which is strictly worse than the real aligned
 *  candidate at the same count and adds nothing the ranked list doesn't
 *  already have. */
function sandwichLayouts(CL, CW, PL, PW){
  const out = [];
  const fam = (U, V, a, b, swap) => {
    const rows = Math.floor(V/b), n2v = Math.floor(V/a);
    if(rows < 1 || n2v < 1) return;
    const majLen = rows*b, midLen = n2v*a;
    if(Math.abs(majLen - midLen) < 1e-6) return;      // no shortfall -> no void -> not a candidate (rule: bands must differ)
    const bandLength = Math.max(majLen, midLen);
    const majV = bandRowsV(rows, b, bandLength);
    const midV = bandRowsV(n2v, a, bandLength);
    if(!majV || !midV) return;                        // an odd short-band row count has no exact centred split
    let best = null;
    for(let k = 2; k <= Math.floor(U/a); k += 2){
      const n2u = Math.floor((U - k*a)/b), n2 = n2u*n2v;
      if(n2 < 1) continue;                          // nothing to sandwich
      const total = k*rows + n2;
      if(!best || total > best.total) best = {k, n2u, total};
    }
    if(!best) return;
    const {k, n2u} = best;
    const k1 = k/2, n2 = n2u*n2v;
    const positions = [];
    const rotA = a !== CL;                          // majority-band orientation
    // the two majority halves, flush to the SHORT BAND'S OWN edges (not the
    // deck) -- adjacent, zero gap. Built as an exact mirror pair (same k1 on
    // each side), which is what makes the whole layer symmetric regardless
    // of how the band-normal leftover (U - maxU) splits outside the group.
    for(const side of [-1, 1]) for(let i = 0; i < k1; i++){
      const u = side*(n2u*b/2 + (i + 0.5)*a);
      for(let vi = 0; vi < rows; vi++){
        const v = majV[vi];
        positions.push(swap ? {x: v, y: u, rot: !rotA} : {x: u, y: v, rot: rotA});
      }
    }
    // the short band, centred at u=0 (unchanged -- the u leftover this used
    // to absorb as a side gap is now outside the group entirely, per the
    // doc comment above); its OWN v-positions come from bandRowsV, which is
    // where this correction's actual void now lives.
    for(let i = 0; i < n2u; i++){
      const u = (i + 0.5)*b - n2u*b/2;
      for(let vi = 0; vi < n2v; vi++){
        const v = midV[vi];
        positions.push(swap ? {x: v, y: u, rot: rotA} : {x: u, y: v, rot: !rotA});
      }
    }
    out.push({positions, label: `${k1*rows}+${n2}+${k1*rows} sandwich`, family: 'sandwich'});
  };
  fam(PL, PW, CL, CW, false); fam(PL, PW, CW, CL, false);
  fam(PW, PL, CL, CW, true);  fam(PW, PL, CW, CL, true);
  return out;
}

/** Perimeter pinwheel/windmill — a DEFINED construction, not discovered:
 *  four i×j blocks around the deck edge, each turned 90° from its
 *  neighbour, C2-symmetric, with the central void/chimney left visibly
 *  empty when the footprint doesn't divide out. Non-overlap needs
 *  a + b <= min(PL, PW) where a = i·CL, b = j·CW (blocks meet corner to
 *  corner). Only MAXIMAL (i, j) pairs are emitted — a pinwheel whose arm
 *  could grow is strictly dominated by the grown one and is pure noise in
 *  the cycle list. */
function pinwheelLayouts(CL, CW, PL, PW){
  const out = [], lim = Math.min(PL, PW);
  for(let i = 1; i*CL + CW <= lim; i++){
    const j = Math.floor((lim - i*CL)/CW);
    if(j < 1) continue;
    if((i + 1)*CL + j*CW <= lim) continue;   // i could grow — dominated
    const a = i*CL, b = j*CW, positions = [];
    // corner-anchored in [0,PL]×[0,PW], then deck-centred
    const cx = PL/2, cy = PW/2;
    for(let ci = 0; ci < i; ci++) for(let rj = 0; rj < j; rj++){
      positions.push({x: (ci + 0.5)*CL - cx,            y: (rj + 0.5)*CW - cy,            rot: false}); // bottom-left, in-line
      positions.push({x: PL - a + (ci + 0.5)*CL - cx,   y: PW - b + (rj + 0.5)*CW - cy,   rot: false}); // top-right (180° twin)
      positions.push({x: PL - b + (rj + 0.5)*CW - cx,   y: (ci + 0.5)*CL - cy,            rot: true});  // bottom-right, turned
      positions.push({x: (rj + 0.5)*CW - cx,            y: PW - a + (ci + 0.5)*CL - cy,   rot: true});  // top-left, turned
    }
    out.push({positions, label: `pinwheel ${i}×${j}`, family: 'pinwheel'});
  }
  return out;
}

/* ---------------- dedupe + symmetry ---------------- */

// injective numeric key per position: |x|,|y| < 5e6 (0.01mm quanta) keeps the
// packed value inside 2^53; the y term (< 5e8) can never bleed into the x band
const sig = positions => positions
  .map(p => Math.round(p.x*100)*1e9 + Math.round(p.y*100)*10 + (p.rot ? 1 : 0))
  .sort((a, b) => a - b).join(',');

/** Is the layer its own 180° turn? (Then the interlock flip is a no-op.) */
const sym180 = positions =>
  sig(positions) === sig(positions.map(p => ({x: -p.x, y: -p.y, rot: p.rot})));

/* ---------------- interlock SCHEDULE ----------------
 * A per-layer boolean array, bottom first — `layerFlips[ly]` is whether
 * layer `ly` gets the 180° turn. This replaced a single `interlock`
 * boolean per candidate: "flip every odd layer" and "flip nothing" are just
 * two values the array can hold, not two separate code paths, and the
 * array is forward-compatible with editing an arbitrary layer's flip once
 * per-layer editing UI exists (a `columnUpTo`+mode-enum pair would have to
 * be thrown away the moment that lands). Every candidate still carries a
 * derived `interlock` boolean (`layerFlips.some(Boolean)`) for the existing
 * ranking tie-break and any caller that only needs "is anything flipped". */
const straightSchedule    = layers => new Array(layers).fill(false);
const alternatingSchedule = layers => Array.from({length: layers}, (_, ly) => !!(ly & 1));

/* ---------------- deck validity: NO OVERHANG, EVER ----------------
 * A hard constraint on the generator, not a preference. Overhang removes
 * corner support and materially weakens the bottom box — and the app's own
 * BCT readout already lists pallet overhang among the deratings it warns
 * about, so emitting an overhanging layout while reporting a BCT that does
 * not account for it would be internally contradictory. The simplest
 * correct behaviour is to never generate one.
 *
 * Every construction is validated against the deck rectangle BEFORE it can
 * enter the ranked list. An arrangement that leaves the deck in either
 * dimension is REJECTED — never clamped, never truncated, never emitted as
 * a fallback. If that rejects everything, the list comes back empty and the
 * chain reports an honest "does not fit" (total 0), exactly as a
 * carton-doesn't-fit-the-case is surfaced today.
 *
 * The check measures the real CHILD footprint (positions are cell-centred;
 * cells carry `between`, the child does not) against the centred deck
 * [-L/2, L/2] × [-W/2, W/2] — the true physical condition, not a proxy for
 * it, so it stays correct for a construction that isn't self-centred.
 *
 * FUTURE OPT-IN: overhang may one day become a deliberate choice, with the
 * BCT overhang derating applied so the strength number stays honest. That
 * needs no rework here — `opts.allowOverhang` already threads through
 * (memo key included); flipping it skips the rejection and nothing else.
 */

/** mm slack for FP residue (cell math accumulates ~1e-12 at pallet scale). */
const DECK_EPS = 1e-6;

/**
 * The child footprint this layer occupies, or null if any case leaves the
 * deck. `l`/`w` are the child's in-plane dims for the un-rotated case.
 * @returns {{minX,maxX,minY,maxY}|null}
 */
function deckFootprint(positions, l, w, deckL, deckW, allowOverhang){
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for(const p of positions){
    const fx = p.rot ? w : l, fy = p.rot ? l : w;
    if(p.x - fx/2 < minX) minX = p.x - fx/2;
    if(p.x + fx/2 > maxX) maxX = p.x + fx/2;
    if(p.y - fy/2 < minY) minY = p.y - fy/2;
    if(p.y + fy/2 > maxY) maxY = p.y + fy/2;
  }
  if(!allowOverhang && (minX < -deckL/2 - DECK_EPS || maxX > deckL/2 + DECK_EPS ||
                        minY < -deckW/2 - DECK_EPS || maxY > deckW/2 + DECK_EPS))
    return null;                       // overhangs — reject, do not clamp
  return {minX, maxX, minY, maxY};
}

/* ---------------- the ranked list ---------------- */

const FAMILY_RANK = {aligned: 0, mixed: 1, sandwich: 2, pinwheel: 3};

/** Guard absurd inputs, like containment's PLACEMENT_CAP. */
const PER_LAYER_CAP = 20000;

const memo = new Map();

/**
 * @param {{outer: {L,W,H}, allowedOrientations: string[]}} child  the tier riding the pallet
 * @param {{L, W, H}} cavity   usable deck L×W and the load height budget (maxH − baseH)
 * @param {{wall, between, bottom?, top?, betweenZ?}} [clearance]
 * @param {'optimal'|'column'|'interlock'} [family='optimal']
 *   optimal  — every construction, straight-stacked, plus interlocked
 *              variants where the flip is physically distinct
 *   column   — aligned grids, straight-stacked only
 *   interlock — every construction stacked with odd layers turned 180°
 *              (the flip is an identity on a symmetric layer — the same
 *              stacking instruction today's app honours — so the filter is
 *              never artificially empty)
 * @param {Object} [opts]
 * @param {boolean} [opts.allowOverhang=false]  RESERVED for a future opt-in.
 *   Left false, no generated arrangement may extend past the deck (see the
 *   deck-validity block above). Set true and the rejection is skipped —
 *   the caller then owes the BCT an overhang derating.
 * @param {number} [opts.outboardMM=0]  TOTAL per-side thickness standing
 *   outboard of the cases, mm — corner-post caliper plus cap caliper, summed
 *   ONCE by core/stack.js's outboardGrowthMM and handed in as a scalar (this
 *   module is pure and has no `project` to read). It was `postCaliperMM`
 *   while posts were the only contributor; a second contributor is exactly
 *   when a name that only fits the first one starts to lie. NOT the same
 *   condition as case overhang above (which REJECTS): this only attaches
 *   `loadOverhang` to a candidate that otherwise passed the deck gate, when
 *   its case envelope plus this growth would stand proud of the deck. Never
 *   rejects, never touches which candidates are returned — see this module's
 *   own doc and the "Overhang" section of the corner-post task for why this
 *   must stay a different code path from case overhang at a different
 *   severity.
 * @param {boolean} [opts.noMemo=false]  skip the result cache. For
 *   hypothetical probes (core/sensitivity.js) whose dimensions never recur:
 *   caching them would only evict the real chain's entries.
 * @returns ranked candidates: {family, layerFlips, interlock, orientation,
 *   perLayer, layers, total, label, envelope, density, utilization,
 *   loadOverhang, warnings, build(), withSchedule()}. `layerFlips` is a
 *   frozen per-layer boolean array, bottom first (`interlock` is just
 *   `layerFlips.some(Boolean)`, kept for callers that only need "is
 *   anything flipped"); `withSchedule(schedule)` returns a NEW candidate —
 *   same layout/orientation, a different flip schedule — for a caller that
 *   wants a specific per-layer arrangement rather than one of the two
 *   auto-generated schedules (straight, or every odd layer). `warnings` is
 *   populated only via `withSchedule`, when the requested schedule flips a
 *   layer that is its own 180° turn (a no-op flip) — never on the two
 *   auto-generated candidates, whose odd-layer default is expected, not a
 *   user request. build() expands the fitInto-compatible Arrangement
 *   (placements included) on demand and caches it. Empty when nothing fits
 *   the deck: an honest "does not fit", never an overhanging fallback.
 *   `loadOverhang` is `{L, W}` (mm proud in each dimension, 0 if not proud
 *   in that dimension) when what stands outboard of the cases — posts, cap,
 *   or both — would stand proud of the deck, else `null` — a WARNING
 *   annotation, never a rejection.
 */
export function palletPatternList(child, cavity, clearance = {wall: 0, between: 0}, family = 'optimal', opts = {}){
  const allowOverhang = !!opts.allowOverhang, noMemo = !!opts.noMemo;
  const outboardMM = typeof opts.outboardMM === 'number' && opts.outboardMM > 0 ? opts.outboardMM : 0;
  const key = noMemo ? null
    : [child.outer.L, child.outer.W, child.outer.H, child.allowedOrientations.join(','),
       cavity.L, cavity.W, cavity.H,
       clearance.wall || 0, clearance.between || 0, clearance.bottom, clearance.top, clearance.betweenZ,
       family, allowOverhang ? 'oh' : '', outboardMM].join('|');
  if(key !== null){
    const hit = memo.get(key);
    if(hit) return hit;
  }

  const {wall, between, bottom, top, betweenZ} = normClearance(clearance);
  const PL = cavity.L - 2*wall + between, PW = cavity.W - 2*wall + between;
  const childVol = child.outer.L*child.outer.W*child.outer.H;
  const cavityVol = cavity.L*cavity.W*cavity.H;

  const cands = [];
  for(const grp of orientationGroups(child.allowedOrientations)){
    const o = grp.base;
    const l = child.outer[o[0]], w = child.outer[o[1]], h = child.outer[o[2]];
    const CL = l + between, CW = w + between;
    const square = CL === CW;

    // the construction set this group is allowed: a lone orientation forbids
    // in-plane rotation, so only its own aligned grid exists; a square
    // footprint makes rotation an identity, so the turned constructions
    // degenerate to the grid and are skipped (pack.js does the same)
    const layouts = [];
    const gA = gridLayout(CL, CW, PL, PW, false, square);
    if(gA) layouts.push(gA);
    if(grp.allowRotate && !square){
      const gB = gridLayout(CL, CW, PL, PW, true, square);
      if(gB) layouts.push(gB);
      layouts.push(...stripLayouts(CL, CW, PL, PW));
      layouts.push(...sandwichLayouts(CL, CW, PL, PW));
      layouts.push(...pinwheelLayouts(CL, CW, PL, PW));
    }

    // geometric dedupe only — equal-COUNT layouts all stay (they are
    // physically different pallets); identical placements collapse
    const seen = new Set();
    for(const lay of layouts){
      const perLayer = lay.positions.length;
      if(perLayer < 1 || perLayer > PER_LAYER_CAP) continue;
      const s = sig(lay.positions);
      if(seen.has(s)) continue;
      seen.add(s);

      // DECK VALIDITY GATE — before anything else this layout could become.
      // A rejected arrangement never reaches the ranked list at all, so no
      // consumer can ever read an overhanging layout.
      const fp = deckFootprint(lay.positions, l, w, cavity.L, cavity.W, allowOverhang);
      if(!fp) continue;

      const st = stack({perLayer, childH: h, parentMaxH: cavity.H, baseH: 0,
                        between: betweenZ, gapBelow: bottom, gapAbove: top});
      if(st.total < 1) continue;

      // occupied envelope (validated footprint + the stack height)
      const {minX, maxX, minY, maxY} = fp;
      const envelope = {L: maxX - minX, W: maxY - minY, H: st.layers*h + (st.layers - 1)*betweenZ};
      const envVol = envelope.L*envelope.W*envelope.H;
      const symmetric = sym180(lay.positions);

      // LOAD OVERHANG — a DIFFERENT condition from the deck-validity gate
      // above, checked on a candidate that already passed it. Corner posts
      // and a cap stand outboard of the CASE envelope, so the inflated
      // footprint can stand proud of the deck by a few mm even though the
      // cases themselves fit cleanly — normal practice, not a fault. Never
      // rejects (the gate above already ran); never derates BCT (nothing
      // here touches it). `outboardMM` is already the TOTAL per-side growth
      // (posts + cap), summed by core/stack.js, so this must NOT double it:
      // it was `2*postCaliperMM` when the argument was one contributor's
      // half-thickness, and the doubling moved to the summing side along
      // with the name. core/trailer.js does NOT read this — it nests its own
      // footprint through the same stack.js function; this module only
      // reports the geometric fact against the deck.
      const ohL = Math.max(0, (envelope.L + outboardMM) - cavity.L);
      const ohW = Math.max(0, (envelope.W + outboardMM) - cavity.W);
      const loadOverhang = (ohL > DECK_EPS || ohW > DECK_EPS) ? {L: ohL, W: ohW} : null;

      const mk = layerFlips => {
        const flips = Object.freeze(layerFlips.slice());
        const interlock = flips.some(Boolean);
        const cand = {
          family: lay.family, layerFlips: flips, interlock, orientation: o,
          perLayer, layers: st.layers, total: st.total,
          label: lay.label + (interlock ? ' · interlocked' : ''),
          envelope, loadOverhang,
          density: envVol > 0 ? st.total*childVol/envVol : 0,
          utilization: cavityVol > 0 ? st.total*childVol/cavityVol : 0,
          // is this layer its own 180deg turn? Then an interlock flip on it
          // is a no-op -- the SAME check withSchedule() already runs
          // internally to decide whether to warn, exposed here so a
          // candidate-comparison view can show it directly rather than
          // re-deriving the symmetry test a second time.
          interlockable: !symmetric,
          // populated only by withSchedule() below — the auto-generated
          // straight/alternating candidates never warn (their flip, if any,
          // is the app's own long-standing "flip every odd layer" default,
          // not something a user explicitly asked for on THIS layer)
          warnings: [],
          build(){
            if(this._arr) return this._arr;
            const placements = [];
            for(let ly = 0; ly < st.layers; ly++){
              const flip = this.layerFlips[ly];
              const z = bottom + h/2 + ly*(h + betweenZ);
              for(const p of lay.positions)
                placements.push({x: flip ? -p.x : p.x, y: flip ? -p.y : p.y, z,
                                 orientation: p.rot ? transpose(o) : o});
            }
            return (this._arr = {placements, perLayer, layers: st.layers, total: st.total,
                                 envelope, utilization: cand.utilization, label: cand.label,
                                 layerFlips: this.layerFlips, warnings: this.warnings});
          },
          /** Rebuild this SAME layout/orientation/envelope with a DIFFERENT
           *  per-layer flip schedule (bottom-first) — the entry point a
           *  user's explicit schedule (or the UI's columnar-through-k rule)
           *  goes through, distinct from the two auto-generated candidates
           *  above. A schedule shorter or longer than this candidate's own
           *  `layers` degrades safely: missing entries read false
           *  (columnar), extra entries are ignored — the same forgiving-
           *  clamp philosophy patternIndex already uses for a stale
           *  selection, rather than throwing when the layer count moves
           *  under a held schedule. Returns a NEW candidate; this one, and
           *  its own `warnings`, are untouched. */
          withSchedule(schedule){
            const next = mk(Array.from({length: st.layers}, (_, ly) => !!(schedule && schedule[ly])));
            if(symmetric && next.interlock)
              next.warnings = ['Interlock requested on a layer that is its own 180° turn — the flip has no effect; this arrangement is identical to a straight stack.'];
            return next;
          }
        };
        return cand;
      };

      // family membership:
      //   optimal  — straight always; the interlocked twin only when the
      //              flip is physically distinct (no duplicate pallets)
      //   column   — straight aligned grids
      //   interlock — the flipped stacking of EVERY layout (identity flip
      //              included, matching the legacy interlock behaviour)
      // Both non-'optimal' presets are just a fixed SCHEDULE now — a value
      // the array holds, not a second branch of candidate-building logic;
      // mk() itself no longer knows or cares which preset asked for it.
      if(family === 'optimal'){
        cands.push(mk(straightSchedule(st.layers)));
        if(!symmetric) cands.push(mk(alternatingSchedule(st.layers)));
      }else if(family === 'column'){
        if(lay.family === 'aligned') cands.push(mk(straightSchedule(st.layers)));
      }else{ // 'interlock'
        cands.push(mk(alternatingSchedule(st.layers)));
      }
    }
  }

  // rank: count, then compactness, then the simpler construction. Stable
  // beyond that (generation order) — further ties are physically equivalent
  // in every ranked metric, so the order is deliberately arbitrary.
  cands.sort((a, b) =>
    b.total - a.total ||
    b.density - a.density ||
    FAMILY_RANK[a.family] - FAMILY_RANK[b.family] ||
    (a.interlock ? 1 : 0) - (b.interlock ? 1 : 0));

  if(memo.size > 400) memo.clear();
  memo.set(key, cands);
  return cands;
}

/** The zero arrangement chainMetrics falls back to when nothing fits —
 *  shape-compatible with fitInto's return. */
export function emptyArrangement(){
  return {placements: [], perLayer: 0, layers: 0, total: 0,
          envelope: {L: 0, W: 0, H: 0}, utilization: 0, label: '',
          layerFlips: [], interlock: false, warnings: []};
}
