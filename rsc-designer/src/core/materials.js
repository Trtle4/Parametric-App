/**
 * The material registry — one entry per cost-bearing material stream.
 *
 * Corner posts are the FOURTH stream (carton board, U-board paperboard,
 * slipsheet, now post board). A stream is a registry ROW from here on, not
 * a copy-pasted branch in cost.js — the fifth stream this app ever adds
 * should be a new entry in MATERIAL_REGISTRY, not a new function.
 *
 * PRICING_BASES is exhaustive: costForBasis throws on anything else, so a
 * basis this module doesn't know about can never silently price as zero.
 * `perArea` is the shape every existing board stream already used (rate x
 * area, $/m²); `perLength` and `perPiece` are new, added because the corner
 * post is bought by the piece or by linear length, never by area — deciding
 * this BEFORE migrating the three existing streams is the whole point:
 * retrofitting a second basis after they're on the registry is the
 * expensive version (see the task's own "Cost" section).
 *
 * caseBoard, film, tray and the pallet-trip fee are NOT migrated here — they
 * were never named as one of "the three existing streams" this phase folds
 * in, and folding them in unasked would be scope creep on an already large
 * change. They stay on cost.js's original, un-registried path.
 *
 * DOM-free, side-effect-free, no dependency — a sibling to cost.js.
 */

export const PRICING_BASES = Object.freeze(['perArea', 'perLength', 'perPiece']);

/**
 * $ from a rate and the ONE quantity that basis actually prices against.
 * Exhaustive over PRICING_BASES: an unhandled basis throws rather than
 * silently resolving to null/zero, so a fifth basis added to the enum
 * without a matching case here is caught immediately, not shipped quiet.
 *
 * @param {string} basis one of PRICING_BASES
 * @param {number} rate  $ per the basis's own unit (canonical: $/m², $/m, $/piece)
 * @param {{areaM2?:number, lengthM?:number, count?:number}} q
 * @returns {number|null} null when the rate or the relevant quantity is absent/non-positive
 */
export function costForBasis(basis, rate, q){
  const okRate = typeof rate === 'number' && isFinite(rate) && rate > 0;
  const okQ = v => typeof v === 'number' && isFinite(v) && v > 0;
  switch(basis){
    case 'perArea':   return (okRate && okQ(q.areaM2))   ? rate*q.areaM2   : null;
    case 'perLength': return (okRate && okQ(q.lengthM))  ? rate*q.lengthM  : null;
    case 'perPiece':  return (okRate && okQ(q.count))    ? rate*q.count    : null;
    default: throw new Error(`costForBasis: unhandled pricing basis "${basis}"`);
  }
}

/**
 * One entry per stream. `rateKey` (single-basis streams) or `rateKeys`
 * (cornerPost, keyed by basis) names the field(s) on `project.cost` that
 * override `defaultRate`/`defaultRates` — the same auto-with-override shape
 * cost.js's COST_DEFAULTS always used: absence of the key IS the auto state.
 */
export const MATERIAL_REGISTRY = Object.freeze({
  cartonBoard: Object.freeze({
    label: 'Carton board', basis: 'perArea',
    rateKey: 'cartonBoardPerM2', defaultRate: 0.62
  }),
  uboardBoard: Object.freeze({
    label: 'U-board', basis: 'perArea',
    rateKey: 'uboardBoardPerM2', defaultRate: 0.50
  }),
  slipsheet: Object.freeze({
    label: 'Slipsheet', basis: 'perArea',
    rateKey: 'slipsheetBoardPerM2', defaultRate: null
    // No default rate: no slipsheet cost line exists anywhere in this app
    // today. Moving its WEIGHT formula onto the registry's shape (see
    // core/stack.js's cornerPost/slipsheet functions) is bit-identical,
    // since weight never depended on cost; the rate stays absent (never
    // priced, exactly like today) until someone actually enters one.
  }),
  capBoard: Object.freeze({
    label: 'Cap board', basis: 'perArea',
    // Its OWN stream and its OWN rate. Deliberately not aliased to
    // cartonBoard, uboardBoard or the post board: a cap is a different
    // grade bought on a different line, and sharing a rate key would mean a
    // user pricing their cases silently repriced every cap on the pallet.
    // The area it prices is the PLUS, never the bounding rectangle — see
    // core/cap.js's capPlusAreaMM2 and the scrap assumption stated there.
    rateKey: 'capBoardPerM2', defaultRate: 0.45
  }),
  cornerPost: Object.freeze({
    label: 'Corner post',
    // The ONE stream whose basis is a per-PROJECT choice, not fixed on the
    // registry entry: angle board is bought by length or by the piece, and
    // raising post height must move a per-length cost, never a per-piece
    // one (a flat per-post price wouldn't respond to a height the user just
    // changed — see the task's "Cost" section). allowedBases/defaultBasis
    // still make the registry the one place that says what a "cornerPost"
    // price can even mean.
    allowedBases: Object.freeze(['perLength', 'perPiece']),
    defaultBasis: 'perLength',
    rateKeys: Object.freeze({perLength: 'cornerPostPerLengthM', perPiece: 'cornerPostPerPiece'}),
    defaultRates: Object.freeze({perLength: 0, perPiece: 0})
  })
});

/** The rate actually in force for a single-basis registry entry: the
 *  project override if there is one, else the entry's own default. Mirrors
 *  cost.js's rateOf exactly (the two must never diverge in shape). */
export function registryRateOf(cost, entry){
  const v = cost ? cost[entry.rateKey] : undefined;
  return (typeof v === 'number' && isFinite(v)) ? v : entry.defaultRate;
}

/** The corner post's active basis: a project override (must be one of
 *  allowedBases) else the registry's defaultBasis. An unrecognized override
 *  falls back to the default rather than adopting an unknown basis — the
 *  same "never silently resolve an undeclared value" rule the exhaustive
 *  switch above enforces at the pricing step. */
export function cornerPostBasisOf(project){
  const entry = MATERIAL_REGISTRY.cornerPost;
  const chosen = project && project.pallet && project.pallet.stack &&
    project.pallet.stack.cornerPost && project.pallet.stack.cornerPost.costBasis;
  return entry.allowedBases.includes(chosen) ? chosen : entry.defaultBasis;
}

/** The corner post's active rate for whichever basis is in force. */
export function cornerPostRateOf(cost, basis){
  const entry = MATERIAL_REGISTRY.cornerPost;
  const v = cost ? cost[entry.rateKeys[basis]] : undefined;
  return (typeof v === 'number' && isFinite(v)) ? v : entry.defaultRates[basis];
}
