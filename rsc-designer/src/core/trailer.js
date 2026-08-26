/**
 * Trailer fit — a CONSTRAINT LAYER, not a chain level. Nothing is packed
 * inside a trailer the way a carton is packed inside a case: the trailer
 * consumes the finished stack (core/stack.js resolveStack) and reports
 * whether/how many of it fit, and what binds. No dieline, no exploded rank,
 * no material cost — those all belong to actual chain tiers, and the trailer
 * is not one.
 *
 * `resolveTrailer()` is the sole resolver of every trailer-fit fact, the
 * same "one question, one computation" shape as core/stack.js's
 * resolveStack() and project.js's chainMetrics. It computes NO stack
 * geometry of its own — floor count feeds off the pallet's own L/W and the
 * stack's own totalHeightMM/totalWeightLb, read, never re-derived.
 *
 * FLOOR PACKING REUSES core/palletpatterns.js — the same machinery that
 * places cases on a pallet places pallets on a trailer floor; only the
 * rectangle sizes change (the "child" is the pallet footprint, the "cavity"
 * is the trailer floor). No new packing math, and the existing NO-OVERHANG
 * rule applies unmodified: a floor plan that would overhang the trailer is
 * rejected by palletPatternList itself, never clamped.
 *
 * The floor is always exactly ONE layer of stacks — vertical stacking is
 * already resolveStack()'s job (project.pallet.stack.positions), so the
 * cavity height handed to palletPatternList is pinned to the child's own
 * height, forcing floor.build()'s own layers to 1 by construction (see
 * FLOOR_FAMILY_DEFAULT below); this is not a second stacking mechanism.
 *
 * SLIPSHEET LIP EXCLUDED, EXPLICITLY: trailer fit reads the load
 * FOOTPRINT — project.pallet.L/W — never a position's own (possibly
 * lip-inflated) footprint from resolveStack().footprintMM. The lip is
 * handling clearance only; widening it must change no trailer-fit number.
 * See the `child` construction below for the one place this is enforced.
 *
 * DOM-free, mm-native (weight in lb, matching the app's existing BCT
 * convention throughout core/bct.js and core/stack.js).
 */
import {palletPatternList, emptyArrangement} from './palletpatterns.js';

/** 53' dry van, CPG default — a proposal confirmed with the user, not pulled
 *  from a spec sheet. All lengths in mm (the app's internal unit); the
 *  display-unit toggle handles presentation, same as every other length. */
export const TRAILER_DEFAULTS = Object.freeze({
  L: 16002,          // 630 in — interior length
  W: 2502,           // 98.5 in — interior width
  H: 2794,           // 110 in — interior height
  doorH: 2667,       // 105 in — door opening height (a SEPARATE, often tighter, constraint)
  doorW: 2489,       // 98 in — door opening width
  maxPayloadLb: 45000,
  floorPattern: 'column'   // see FLOOR_FAMILY_DEFAULT below
});

/** The floor-packing STRATEGY is a parameter, not hardcoded, so a richer
 *  solver (mixed/pinwheel floor layouts) can be swapped in later without
 *  touching resolveTrailer's caller — only the family string threaded to
 *  palletPatternList changes. 'column' (aligned grids, straight-stacked
 *  only) is the "at minimum, both homogeneous orientations, take the max"
 *  baseline the task calls for: for a 48x40 pallet in the default trailer
 *  it yields 26 one way and 30 the other, matching the well-known real
 *  figures for this exact pallet/trailer pair — 'optimal' would additionally
 *  consider mixed/pinwheel floor layouts, which real trailer loading
 *  practice does not do, so it is available but not the default. */
export const FLOOR_FAMILY_DEFAULT = 'column';

const MM_PER_IN = 25.4;
const num = v => typeof v === 'number' && isFinite(v);

/** Fill a partial project.trailer against TRAILER_DEFAULTS — the same
 *  auto-with-override idiom every other project settings bag in this app
 *  uses (cost.js's COST_DEFAULTS, uboard.js's UBOARD_DEFAULTS). */
export function trailerParams(overrides){
  const ov = overrides || {};
  const out = {};
  for(const k of Object.keys(TRAILER_DEFAULTS))
    out[k] = num(ov[k]) ? ov[k] : (typeof ov[k] === 'string' && k === 'floorPattern' ? ov[k] : TRAILER_DEFAULTS[k]);
  return out;
}

/**
 * How many pallet footprints fit the trailer floor, in ONE layer — the
 * pallet-loading problem again, at trailer scale. Reuses
 * palletPatternList() unmodified: the "child" is the pallet's own L/W (never
 * a slipsheet-lipped footprint — see the module doc), given BOTH in-plane
 * orientations (a transposed pair, so palletPatternList's own orientation
 * pairing enumerates the grid both ways) and ranked so list[0] is the
 * better of the two, exactly "evaluate both homogeneous orientations and
 * take the max".
 *
 * The NO-OVERHANG rule is inherited, not reimplemented: a pallet that does
 * not fit the trailer floor at all comes back as an empty list here, the
 * same "does not fit" palletPatternList already reports for a case that
 * does not fit a pallet.
 *
 * @param {{L:number,W:number}} palletLW  the pallet's own footprint (mm)
 * @param {{L:number,W:number}} floorLW   the trailer's own interior floor (mm)
 * @param {string} [family=FLOOR_FAMILY_DEFAULT]  the floor-packing STRATEGY,
 *   threaded straight to palletPatternList's own `family` param — swappable
 *   without touching this function's callers.
 * @returns the winning palletPatternList candidate, or emptyArrangement()
 */
export function trailerFloorPattern(palletLW, floorLW, family = FLOOR_FAMILY_DEFAULT){
  // cavity.H pinned to the child's own H forces palletPatternList's internal
  // stack() to exactly ONE layer (budget == childH), regardless of the
  // trailer's real interior height -- vertical stacking is resolveStack's
  // job, not this floor pattern's. childH itself is otherwise unused (a
  // floor pattern has no vertical extent of its own to report).
  const childH = 1;
  const child = {outer: {L: palletLW.L, W: palletLW.W, H: childH}, allowedOrientations: ['LWH', 'WLH']};
  const cavity = {L: floorLW.L, W: floorLW.W, H: childH};
  const list = palletPatternList(child, cavity, {wall: 0, between: 0}, family);
  return list.length ? list[0] : emptyArrangement();
}

/**
 * The whole trailer-fit resolution, once. `stack` is core/stack.js's
 * resolveStack() result for the CURRENT chain; `casesPerLoad` is the
 * chain's own cases-in-one-unit-load (project.js chainMetrics'
 * casesPerPallet) — read here, never recomputed.
 *
 * @param {Object} project  needs project.pallet.{L,W} and project.trailer
 * @param {Object} stack    resolveStack() result
 * @param {number} casesPerLoad
 * @returns {Object} see the field-by-field comments below
 */
export function resolveTrailer(project, stack, casesPerLoad = 0){
  const t = trailerParams(project.trailer);
  const pallet = project.pallet;

  // FLOOR: the pallet's own footprint only -- see the module doc for why a
  // slipsheet position's lipped footprint never reaches this call.
  const floor = trailerFloorPattern({L: pallet.L, W: pallet.W}, {L: t.L, W: t.W}, t.floorPattern);
  const stacksPerTrailer = floor.total;
  const floorOrientation = floor.orientation || null;       // e.g. 'LWH'/'WLH', null when nothing fits

  const positionsCount = stack.positions.length;
  const unitLoadsPerTrailer = stacksPerTrailer*positionsCount;
  const casesPerTrailer = unitLoadsPerTrailer*casesPerLoad;

  // WEIGHT: total payload = one stack's own weight (core/stack.js
  // resolveStack().totalWeightLb, already the whole N-position column,
  // bases included) x how many stacks fit the floor -- never a second,
  // independently-derived per-case weight sum.
  const totalWeightLb = stack.totalWeightLb*stacksPerTrailer;
  const weightUtilPct = t.maxPayloadLb > 0 ? (totalWeightLb/t.maxPayloadLb)*100 : 0;

  // CUBE: load volume from the pallet's own footprint x the stack's own
  // total height (again, never the lipped footprint) x how many stacks fit,
  // over the trailer's own interior volume (its usable cube, not the door
  // opening -- the door is a clearance gate, not a capacity number).
  const loadVolumeMM3 = stacksPerTrailer*pallet.L*pallet.W*stack.totalHeightMM;
  const trailerVolumeMM3 = t.L*t.W*t.H;
  const cubeUtilPct = trailerVolumeMM3 > 0 ? (loadVolumeMM3/trailerVolumeMM3)*100 : 0;

  const bindingConstraint = weightUtilPct >= cubeUtilPct ? 'weight' : 'cube';

  // HEIGHT: interior and door are two DISTINCT, separately reported checks
  // -- a stack that clears the interior but not the door does not load, and
  // showing only one verdict would hide that. Both read the stack's own
  // totalHeightMM, never a second height computed here.
  const interiorHeightOk = stack.totalHeightMM <= t.H;
  const doorHeightOk = stack.totalHeightMM <= t.doorH;
  // Door WIDTH: whatever a pallet's own footprint is, it can always be
  // presented to the door in its NARROWER orientation while being loaded
  // (independent of which orientation the floor plan uses once inside) --
  // so the real gate is the pallet's own shorter side against the door
  // opening, not the floor pattern's chosen orientation.
  const doorWidthOk = Math.min(pallet.L, pallet.W) <= t.doorW;
  const doorOk = doorHeightOk && doorWidthOk;

  const remainingFloorAreaMM2 = Math.max(0, t.L*t.W - stacksPerTrailer*pallet.L*pallet.W);
  const remainingHeightMM = t.H - stack.totalHeightMM;   // signed: negative means it doesn't fit (see interiorHeightOk)

  return {
    stacksPerTrailer, unitLoadsPerTrailer, casesPerTrailer,
    floorOrientation, floorPattern: floor,
    totalWeightLb, weightUtilPct, cubeUtilPct, bindingConstraint,
    interiorHeightOk, doorHeightOk, doorWidthOk, doorOk,
    remainingFloorAreaMM2, remainingHeightMM,
    provenance: {palletL: pallet.L, palletW: pallet.W, casesPerLoad, trailer: t}
  };
}
