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
 * @param {{layers?:number, casesPerLayer?:number, loadH?:number}} fit
 * @returns {{
 *   positions: Array<{base:string}>,
 *   totalHeightMM: number,
 *   baseHeightMM: number[],
 *   footprintMM: Array<{L:number,W:number}>,
 *   boxesAboveBottom: number,
 *   tareAboveLb: number,
 *   totalWeightLb: number,
 *   provenance: Object
 * }}
 */
export function resolveStack(project, fit = {}){
  const layers = fit.layers || 0;
  const casesPerLayer = fit.casesPerLayer || 0;
  const loadH = fit.loadH || 0;
  const stackCfg = project.pallet.stack;
  const positions = (stackCfg && Array.isArray(stackCfg.positions) && stackCfg.positions.length)
    ? stackCfg.positions : STACK_DEFAULTS.positions;
  const n = positions.length;
  const heights = positions.map(p => baseHeightMM(p, project));
  const weights = positions.map(p => baseWeightLb(p, project));
  const footprints = positions.map(p => baseFootprintMM(p, project));
  const totalHeightMM = heights.reduce((s, h) => s + h, 0) + n*loadH;
  // Each base ABOVE the bottom case bears down on it through the column
  // below; the bottom position's own base is underneath the whole stack and
  // carries nothing onto the case riding on it.
  const tareAboveLb = weights.slice(1).reduce((s, w) => s + w, 0);
  const unitWeightLb = (project.pallet.stacking && project.pallet.stacking.unitWeightLb) || 0;
  const casesPerLoad = casesPerLayer*layers;
  const totalWeightLb = weights.reduce((s, w) => s + w, 0) + n*casesPerLoad*unitWeightLb;
  return {
    positions,
    totalHeightMM,
    baseHeightMM: heights,
    footprintMM: footprints,
    boxesAboveBottom: boxesAboveBottom(layers, n),
    tareAboveLb,
    totalWeightLb,
    provenance: {layers, casesPerLayer, loadH, unitWeightLb, positionsCount: n}
  };
}
