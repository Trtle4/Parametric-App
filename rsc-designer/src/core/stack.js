/**
 * Pallet stack model — per-position bases (pallet or slipsheet), 1-4
 * positions, bottom first. Replaces the old project.pallet.stacking.
 * doubleStack boolean, which could say only "one or two identical pallets"
 * and had no way to express a slipsheet, or three or four positions.
 *
 * `resolveStack()` is the SOLE writer of the stack's composed facts —
 * per-position base height/weight, total stacked height, how many boxes'
 * weight bears on the bottom case, and the whole stack's weight. Every
 * reader (the BCT panel, the Dims overlay's Pallet/Load split, the pallet
 * summary PDF, the 3D hierarchy render) reads from its return value and
 * computes nothing of its own — the same "one question, one computation"
 * shape as project.js's chainMetrics/palletLoadH.
 *
 * DOM-free, mm-only, pure — a sibling to core/bct.js and core/uboard.js.
 */

import {cornerPostBasisOf} from './materials.js';
import {capConfig, capFootprintGrowthMM, capHeightGrowthMM, capWeightLb, capBlank} from './cap.js';

/** Every base a stack position can rest on. A single discriminant per
 *  position (not a per-kind boolean) so "unrepresentable" states — a
 *  position that is both, or neither — don't need a validation rule to
 *  rule out. resolveStack's own base-height/weight lookups are the ONE
 *  place allowed to branch on it (see baseHeightMM/baseWeightLb below); an
 *  enum member not in this list throws immediately rather than silently
 *  resolving to some other base's numbers. */
export const BASE_KINDS = ['pallet', 'slipsheet'];

/** The default stack: one position, resting on a pallet — bit-identical to
 *  the old doubleStack:false. */
export const STACK_DEFAULTS = Object.freeze({
  positions: [{base: 'pallet'}]
});

/** A 48x40 GMA 4-way stringer pallet's own empty weight. A placeholder
 *  order-of-magnitude, same idiom as cost.js's COST_DEFAULTS and uboard.js's
 *  caliper default — a real project overrides it (project.pallet.tareLb). */
export const PALLET_TARE_LB_DEFAULT = 45;

/** Slipsheet defaults. `weightLb: null` and `L`/`W: null` are auto — the
 *  same auto-with-override shape uboard.js's `f` uses: a number overrides,
 *  null/absent derives. Footprint auto = pallet footprint + 1in per side
 *  (handling clearance only — it never feeds a footprint any packing/fit
 *  reads). Density is a generic solid-fiberboard-slipsheet order of
 *  magnitude, not a specific board grade. */
export const SLIPSHEET_DEFAULTS = Object.freeze({
  caliper: 3,       // mm
  density: 950,     // kg/m^3
  weightLb: null,   // override; null = auto (footprint area x caliper x density)
  L: null, W: null   // override footprint; null = auto (pallet L/W + 1in/side)
});

const MM_PER_IN = 25.4;
const KG_PER_LB = 0.45359237;

const num = v => typeof v === 'number' && isFinite(v);

/** Corner posts: one config for the WHOLE stack, applied to every position
 *  uniformly — not a per-position override like `positions[i].base`. Two
 *  things force this shape rather than a per-position one: (1) `loadH` (the
 *  case-stack height a load carries) is already uniform across positions in
 *  this model, so a height default computed "per load" comes out identical
 *  at every position regardless of where the config lives; (2) the cost
 *  formula the task itself specifies is a flat `4 x positions x rate` — a
 *  single rate/height times a position COUNT, never a sum of N independently
 *  configured posts. `enabled` is a real toggle (not an absence-is-auto
 *  field): posts are an opt-in feature, not a value with a sensible zero.
 *  `caliper` has no auto concept per the task ("its own input") — a plain
 *  overridable default, same shape as project.pallet.baseH. */
export const CORNER_POST_DEFAULTS = Object.freeze({
  enabled: false,
  height: null,   // mm; null = auto = that load's case-stack height - 1in
  legL: null,     // mm; null = auto = 3in
  legW: null,     // mm; null = auto = 3in
  caliper: 3,     // mm
  density: 700,   // kg/m^3 — corrugated "post board" order of magnitude, a placeholder like every other density default in this file
  costBasis: 'perLength'
});

const CORNER_POST_HEIGHT_MARGIN_MM = MM_PER_IN;   // 1in short of the case stack, by design (see cornerPostHeightMM)
const CORNER_POST_LEG_DEFAULT_MM = 3*MM_PER_IN;   // 3in each side

/** The resolved corner-post config: every field either the project's own
 *  override or CORNER_POST_DEFAULTS — never a mix of the two per field left
 *  to callers to sort out (the same fully-resolved shape slipsheetFootprintMM
 *  etc. hand back). `height` is deliberately NOT resolved here — its auto
 *  value depends on `loadH`, which this function doesn't have; see
 *  cornerPostHeightMM. */
function cornerPostRaw(project){
  return (project.pallet.stack && project.pallet.stack.cornerPost) || {};
}
export function cornerPostConfig(project){
  const cp = cornerPostRaw(project);
  return {
    enabled: !!cp.enabled,
    legL: num(cp.legL) ? cp.legL : CORNER_POST_LEG_DEFAULT_MM,
    legW: num(cp.legW) ? cp.legW : CORNER_POST_LEG_DEFAULT_MM,
    caliper: num(cp.caliper) ? cp.caliper : CORNER_POST_DEFAULTS.caliper,
    density: num(cp.density) ? cp.density : CORNER_POST_DEFAULTS.density,
    costBasis: cp.costBasis === 'perPiece' ? 'perPiece' : 'perLength'
  };
}

/** This stack's corner-post HEIGHT, mm — an override if given, else that
 *  load's own case-stack height minus 1in. Short of the top BY DESIGN: at
 *  the default height nothing above can bear on the post, which is why the
 *  model gives posts zero compression credit unconditionally (see
 *  tareAboveLb below and bct.js) rather than only when they happen to be
 *  short. `loadH` is the chain's own solved case-stack height (project.js),
 *  read here, never re-derived. */
export function cornerPostHeightMM(project, loadH){
  const cp = cornerPostRaw(project);
  return num(cp.height) ? cp.height : Math.max(0, (loadH || 0) - CORNER_POST_HEIGHT_MARGIN_MM);
}

/** True once the post's CURRENT height reaches the case stack — the model
 *  never credits posts structurally either way, but a UI note explaining
 *  why only matters once a user has actually raised height to meet the
 *  stack (see the "non-structural" note in app.js). */
export function cornerPostReachesCaseStack(project, loadH){
  return cornerPostHeightMM(project, loadH) >= (loadH || 0) - 1e-6;
}

/** One post's own cross-section area, mm² — an L-profile: two rectangular
 *  legs sharing one caliper x caliper corner square once, not twice. */
export function cornerPostSectionAreaMM2(cfg){
  return cfg.legL*cfg.caliper + cfg.legW*cfg.caliper - cfg.caliper*cfg.caliper;
}

/** One post's own weight, lb — section area x height x density, the exact
 *  volume-x-density shape slipsheetWeightLb already uses. Zero when posts
 *  are off, so every caller can add this in unconditionally. */
export function cornerPostWeightLb(project, loadH){
  const cfg = cornerPostConfig(project);
  if(!cfg.enabled) return 0;
  const h = cornerPostHeightMM(project, loadH);
  const volM3 = (cornerPostSectionAreaMM2(cfg)/1e6)*(h/1000);
  return (volM3*cfg.density)/KG_PER_LB;
}

/** The load footprint growth from corner posts, mm — 2 x caliper in EACH of
 *  L and W (one post at each end of a face, each caliper thick, standing
 *  outboard of the case corner). Zero when posts are off. */
export function cornerPostFootprintGrowthMM(project){
  const cfg = cornerPostConfig(project);
  return cfg.enabled ? 2*cfg.caliper : 0;
}

/** The corner-post COST quantities materialCost needs, in the ONE unit each
 *  pricing basis actually prices against — a total post LENGTH in metres, or
 *  a flat post COUNT. 4 posts per position (see cornerPostWeightLb's own
 *  doc for why this is one shared config times a position count, not N
 *  independent posts). Computed here once so project.js's decorateRow never
 *  re-derives "4 x positions" itself — the exact `4 x positions x rate`
 *  shape the cost spec calls for falls out of costForBasis(basis, rate,
 *  {lengthM, count}) unchanged. `basis` is null when posts are off, so the
 *  caller can tell "no cost to compute" apart from "compute it as zero". */
export function cornerPostCostQuantities(project, loadH, positionsCount){
  const cfg = cornerPostConfig(project);
  if(!cfg.enabled) return {basis: null, lengthM: null, count: null};
  const totalPosts = 4*Math.max(1, positionsCount);
  const heightM = cornerPostHeightMM(project, loadH)/1000;
  return {basis: cornerPostBasisOf(project), lengthM: totalPosts*heightM, count: totalPosts};
}

/* ---------------- the load's OUTER FOOTPRINT, in one place ----------------
 * Before caps there was no such place. Five independent `2 x caliper`
 * additions were spread over three different starting rectangles:
 * trailer.js grew the PALLET DECK, palletpatterns.js's overhang check grew
 * the CASE-STACK ENVELOPE, and palletmesh.js and hierarchy3d.js each grew
 * the case envelope again with their own verbatim copy of the arithmetic.
 * Adding a fourth contributor to four call sites is how they drift, so the
 * nesting lives here now and every caller reads a stage off it.
 *
 * WHICH RECTANGLE a caller starts from is a SEPARATE question, and this
 * function deliberately does not answer it — it takes the base as an
 * argument. The deck-vs-envelope disagreement above predates caps and is
 * not resolved here; consolidating the arithmetic without changing anyone's
 * base keeps this change to what it claims to be.
 */

/**
 * The load's footprint at each stage of nesting OUTWARD, in physical order:
 * cases, then corner posts around them, then the cap over the posts. Each
 * stage is the previous one grown — never a fresh derivation from the
 * cases, which is exactly the mistake that lets a later contributor land
 * inboard of an earlier one.
 *
 * Returns all three stages rather than just the outermost because different
 * consumers legitimately want different ones, and naming them is what keeps
 * a consumer from picking the wrong rectangle silently:
 *   `.cases` — the bare footprint handed in
 *   `.posts` — cases + post caliper. THE CAP'S CENTRE PANEL: a cap goes
 *              OVER the posts, so its centre panel must clear them.
 *   `.cap`   — posts + cap caliper. The load's true outer footprint.
 *
 * @param {{L:number,W:number}} cases  the rectangle to nest outward from
 * @param {Object} project
 * @returns {{cases:{L,W}, posts:{L,W}, cap:{L,W}}}
 */
export function loadFootprintStagesMM(cases, project){
  const grow = (r, d) => ({L: r.L + d, W: r.W + d});
  const base = {L: cases.L, W: cases.W};
  const posts = grow(base, cornerPostFootprintGrowthMM(project));
  return {cases: base, posts, cap: grow(posts, capFootprintGrowthMM(project))};
}

/** The load's OUTER footprint — the outermost stage of the nesting above.
 *  The function to call when the question is "how much floor does this load
 *  occupy"; use loadFootprintStagesMM directly when you need an inner
 *  stage by name. */
export function loadFootprintMM(cases, project){
  return loadFootprintStagesMM(cases, project).cap;
}

/** The TOTAL outboard growth per axis, mm — every contributor summed. The
 *  scalar form, for a consumer that already has its own rectangle and only
 *  needs the delta (core/palletpatterns.js's overhang check takes this
 *  shape, since it is a pure module with no `project` to read). */
export function outboardGrowthMM(project){
  return cornerPostFootprintGrowthMM(project) + capFootprintGrowthMM(project);
}

/* ---------------- caps: the load's own resolved cap geometry -------------
 * core/cap.js owns the blank and every formula; this is where a cap meets
 * the STACK — the centre panel it is built on, and the weight/height terms
 * resolveStack folds in. */

/**
 * The resolved caps for a load whose CASES occupy `caseFootprint`: the
 * shared centre panel (the post stage of the nesting above) and one blank
 * per enabled cap. `top`/`bottom` are null when that cap is off, so a
 * consumer can tell "no cap" from "a cap weighing zero".
 *
 * Both caps share ONE centre panel and therefore one blank shape — the
 * brief's "one skirt depth for all four sides" extended by the same
 * reasoning to the two caps: they cover the same load face.
 */
export function resolveCaps(caseFootprint, project){
  const cfg = capConfig(project);
  const centre = loadFootprintStagesMM(caseFootprint, project).posts;
  const one = which => capBlank(centre, cfg, which);
  return {
    cfg, centre,
    top: cfg.top ? one('top') : null,
    bottom: cfg.bottom ? one('bottom') : null,
    // ONE weight, shared: the two blanks are identical, so a second
    // computation could only ever disagree with the first
    weightEachLb: (cfg.top || cfg.bottom) ? capWeightLb(centre, cfg) : 0
  };
}

/** The slipsheet's own footprint — pallet footprint + 1in per side unless
 *  explicitly overridden. The 1in lip is handling clearance only: it is
 *  never fed to a fit/trailer computation, which reads the pallet's own
 *  L/W (Phase D reads the load footprint, not the lip). */
export function slipsheetFootprintMM(project){
  const ss = project.pallet.slipsheet || {};
  const pal = project.pallet;
  const L = num(ss.L) ? ss.L : pal.L + 2*MM_PER_IN;
  const W = num(ss.W) ? ss.W : pal.W + 2*MM_PER_IN;
  return {L, W};
}

export function slipsheetCaliperMM(project){
  const ss = project.pallet.slipsheet || {};
  return num(ss.caliper) ? ss.caliper : SLIPSHEET_DEFAULTS.caliper;
}

/** The slipsheet's own tare weight — a direct override when given, else
 *  derived from its footprint x caliper x density. ONE of the two is the
 *  source for any given slipsheet, never both (an override present takes
 *  over entirely rather than blending with the derived figure). */
export function slipsheetWeightLb(project){
  const ss = project.pallet.slipsheet || {};
  if(num(ss.weightLb)) return ss.weightLb;
  const {L, W} = slipsheetFootprintMM(project);
  const caliper = slipsheetCaliperMM(project);
  const density = num(ss.density) ? ss.density : SLIPSHEET_DEFAULTS.density;
  const volM3 = (L/1000)*(W/1000)*(caliper/1000);
  return (volM3*density)/KG_PER_LB;
}

/** This position's own height contribution to the stack, mm. The ONE place
 *  allowed to branch on `position.base` for height. */
export function baseHeightMM(position, project){
  switch(position.base){
    case 'pallet': return project.pallet.baseH ?? 127;
    case 'slipsheet': return slipsheetCaliperMM(project);
    default: throw new Error(`resolveStack: unhandled base "${position.base}"`);
  }
}

/** This position's own footprint, mm — the pallet's own L/W for a pallet
 *  base, the slipsheet's (lipped) footprint for a slipsheet base. Render
 *  consumers (the 3D hierarchy) read this instead of assuming every
 *  position is deck-sized, which a slipsheet position is not. */
export function baseFootprintMM(position, project){
  switch(position.base){
    case 'pallet': return {L: project.pallet.L, W: project.pallet.W};
    case 'slipsheet': return slipsheetFootprintMM(project);
    default: throw new Error(`resolveStack: unhandled base "${position.base}"`);
  }
}

/** This position's own tare weight, lb. The ONE place allowed to branch on
 *  `position.base` for weight. */
export function baseWeightLb(position, project){
  switch(position.base){
    case 'pallet': return project.pallet.tareLb ?? PALLET_TARE_LB_DEFAULT;
    case 'slipsheet': return slipsheetWeightLb(project);
    default: throw new Error(`resolveStack: unhandled base "${position.base}"`);
  }
}

/**
 * Boxes bearing on the bottom box of the load's own column. The bottom case
 * carries the rest of its own column (layers-1) PLUS every case of every
 * load stacked above it (N-1 further loads, `layers` cases each):
 *     boxesAboveBottom = N*layers - 1
 * At N=1 (a single stack, the only case that existed before this model) this
 * is layers-1, identical to the pre-Phase-C formula — the single-stack
 * golden set is unaffected by construction. Never negative.
 */
export function boxesAboveBottom(layers, positionsCount = 1){
  const n = Math.max(1, positionsCount);
  return Math.max(0, n*Math.max(0, layers) - 1);
}

/**
 * The whole stack, resolved once. `layers`/`casesPerLayer`/`loadH` are the
 * CHAIN's own pallet-fit numbers (project.js chainMetrics: caseLayers,
 * casesPerLayer, loadH) — read here, never recomputed.
 *
 * @param {Object} project
 * @param {{layers?:number, casesPerLayer?:number, loadH?:number,
 *          caseFootprint?:{L:number,W:number}}} fit
 *   `caseFootprint` is the case stack's own occupied envelope
 *   (row.casesFit.envelope) — the rectangle caps are built on. Absent, caps
 *   contribute no weight, which is the honest answer for a chain that has
 *   not resolved a footprint yet rather than a guessed one.
 * @returns {{
 *   positions: Array<{base:string}>,
 *   totalHeightMM: number,
 *   baseHeightMM: number[],
 *   footprintMM: Array<{L:number,W:number}>,
 *   boxesAboveBottom: number,
 *   tareAboveLb: number,
 *   totalWeightLb: number,
 *   cornerPostWeightLb: number,
 *   capWeightEachLb: number,
 *   capsPerPosition: number,
 *   provenance: Object
 * }}
 */
export function resolveStack(project, fit = {}){
  const layers = fit.layers || 0;
  const casesPerLayer = fit.casesPerLayer || 0;
  const loadH = fit.loadH || 0;
  const caseFootprint = fit.caseFootprint || null;
  const stackCfg = project.pallet.stack;
  const positions = (stackCfg && Array.isArray(stackCfg.positions) && stackCfg.positions.length)
    ? stackCfg.positions : STACK_DEFAULTS.positions;
  const n = positions.length;
  const heights = positions.map(p => baseHeightMM(p, project));
  const weights = positions.map(p => baseWeightLb(p, project));
  const footprints = positions.map(p => baseFootprintMM(p, project));
  // CAPS. One config for the whole stack (same reasoning as the posts', see
  // capConfig), so every position carries the same cap or caps. Weight needs
  // the centre panel, which needs a case footprint; without one there is
  // nothing to size a cap against and every cap term below stays zero.
  const capCfg = capConfig(project);
  const nCaps = (capCfg.top ? 1 : 0) + (capCfg.bottom ? 1 : 0);
  const capEachLb = (nCaps && caseFootprint)
    ? resolveCaps(caseFootprint, project).weightEachLb : 0;
  // A cap adds ONE CALIPER per enabled cap to each position's height — the
  // top cap above its cases, the bottom cap below them. The SKIRT adds none:
  // it hangs alongside the load, inside the height the cases already have.
  const capHeightPerPositionMM = capHeightGrowthMM(project);
  const totalHeightMM = heights.reduce((s, h) => s + h, 0) + n*loadH + n*capHeightPerPositionMM;
  // 4 posts per position, uniform across positions (ONE cornerPost config
  // for the whole stack — see cornerPostConfig's own doc for why). Zero when
  // posts are off, so every term below stays bit-identical to before posts
  // existed.
  const postsPerPositionLb = 4*cornerPostWeightLb(project, loadH);
  // Each base ABOVE the bottom case bears down on it through the column
  // below; the bottom position's own base is underneath the whole stack and
  // carries nothing onto the case riding on it. A position's OWN corner
  // posts stand BESIDE its cases, not on them, so they never enter that
  // position's own compression column — but a post on position 2..N stands
  // on THAT position's base, which rests on the load below, so its weight
  // transmits down exactly like the base's own tare does. Bottom-position
  // posts are excluded from this sum for the same reason the bottom base is.
  //
  // CAPS ARE ASYMMETRIC HERE, and that asymmetry is the whole point of
  // routing them through this path rather than adding a flat 2*capEachLb.
  // A TOP cap sits ON its own load's cases, so its weight bears on that
  // load's own bottom case — including the BOTTOM position's top cap, which
  // is why top caps count n times while the bases above count n-1. A BOTTOM
  // cap sits UNDER its load's cases and bears on nothing within that load,
  // so the bottom position's bottom cap is excluded for exactly the reason
  // its base is; the bottom caps of positions 2..N still transmit down
  // through the column below them, so those count n-1 times.
  const tareAboveLb = weights.slice(1).reduce((s, w) => s + w, 0) + (n - 1)*postsPerPositionLb
    + (capCfg.top ? n*capEachLb : 0)
    + (capCfg.bottom ? (n - 1)*capEachLb : 0);
  const unitWeightLb = (project.pallet.stacking && project.pallet.stacking.unitWeightLb) || 0;
  const casesPerLoad = casesPerLayer*layers;
  // Post weight joins EVERY position's contribution to the load's total
  // weight (trailer payload reads this) — including the bottom position,
  // whose posts are excluded from tareAboveLb above but still physically
  // ride on the trailer. Cap weight rides for the same reason, and here BOTH
  // caps count at every position: the compression asymmetry above is about
  // what bears on the bottom CASE, while this is simply what the trailer
  // carries, and a bottom cap weighs the same whatever it rests on.
  const totalWeightLb = weights.reduce((s, w) => s + w, 0) + n*casesPerLoad*unitWeightLb
    + n*postsPerPositionLb + n*nCaps*capEachLb;
  return {
    positions,
    totalHeightMM,
    baseHeightMM: heights,
    footprintMM: footprints,
    cornerPostWeightLb: postsPerPositionLb,
    capWeightEachLb: capEachLb,
    capsPerPosition: nCaps,
    boxesAboveBottom: boxesAboveBottom(layers, n),
    tareAboveLb,
    totalWeightLb,
    provenance: {layers, casesPerLayer, loadH, unitWeightLb, positionsCount: n,
                 caseFootprint, capHeightPerPositionMM}
  };
}
