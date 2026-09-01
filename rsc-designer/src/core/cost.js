/**
 * Material cost — RATES × the quantities the chain already solved.
 *
 * This is deliberately not a costing module. It owns no geometry, measures
 * nothing, and cannot: `materialCost` takes a plain bag of already-solved
 * quantities and a bag of rates, and multiplies. If a quantity is missing it
 * reports the term as unavailable rather than deriving one — a cost that
 * measured its own blank area would be a second computation of a solved
 * question, which is exactly how the pallet height, the cell length and the
 * film envelope each went wrong (CLAUDE.md, "one question, one computation").
 *
 * CANONICAL UNITS, always: $ per m² for board, $ per kg for film, $ each for
 * the tray, $ per trip for the pallet. The rail DISPLAYS $/ft² when the
 * project is in inches, but the stored value never changes — one source, the
 * display converts. Same idiom as every length in the app.
 *
 * AUTO-WITH-OVERRIDE, the same shape the tray rail uses: a rate absent from
 * `project.cost` means "use the default", and the presence of the key IS the
 * override state. No isAuto flag to fall out of sync.
 *
 * THE DEFAULTS ARE ORDER-OF-MAGNITUDE PLACEHOLDERS, not quotes. They are
 * there so the panel shows a working number the moment it opens; a real
 * project overrides all five. Folding carton board runs dearer per m² than
 * corrugated (more fibre refinement, coating, print), which is why the two
 * board grades are separate rates rather than one.
 *
 * DOM-free, side-effect-free, no dependency.
 *
 * FOUR of these rates (cartonBoardPerM2, uboardBoardPerM2, plus corner
 * post's two below) are now sourced from core/materials.js's MATERIAL_
 * REGISTRY rather than declared twice — the registry is the single place a
 * fifth material stream gets added. caseBoardPerM2/filmPerKg/trayEach/
 * palletPerTrip stay bespoke: they were never named as one of the three
 * streams this phase migrates, and folding them in unasked would be scope
 * creep on an already large change (see materials.js's own doc).
 */

import {MATERIAL_REGISTRY, costForBasis, cornerPostRateOf} from './materials.js';

/** $ per canonical unit. See the note above: placeholders, not quotes. */
export const COST_DEFAULTS = Object.freeze({
  cartonBoardPerM2: MATERIAL_REGISTRY.cartonBoard.defaultRate,   // folding carton board, converted + printed
  caseBoardPerM2:   0.45,     // corrugated case board
  filmPerKg:        3.20,     // BOPP / PE wrap film
  trayEach:         0.18,     // thermoformed tray, per part
  uboardBoardPerM2: MATERIAL_REGISTRY.uboardBoard.defaultRate,   // U-board paperboard — its own rate, never the carton/case board rate
  palletPerTrip:   12.00,     // one pallet, one trip
  cornerPostPerLengthM: MATERIAL_REGISTRY.cornerPost.defaultRates.perLength,   // $ per metre of angle-board post, all 4 posts x every position
  cornerPostPerPiece:   MATERIAL_REGISTRY.cornerPost.defaultRates.perPiece,   // $ per post, fixed cut-to-size piece
  capBoardPerM2:    MATERIAL_REGISTRY.capBoard.defaultRate   // top/bottom cap board — its own rate, never the carton/case/U-board/post rate
});

/** The rate vocabulary, in display order. `unit` is the DISPLAY kind, which
 *  is all that varies with the project's unit system; `key` is the canonical
 *  stored field. `needs` names the chain level a rate applies to, so a rail
 *  can omit rows for levels that are not in the chain. Corner post is NOT
 *  listed here — its basis-selectable pair of rates needs a selector this
 *  generic auto/override row can't express; see mountCornerPost in inputs.js. */
export const RATE_ROWS = Object.freeze([
  {key: 'cartonBoardPerM2', label: 'Carton board', unit: 'area', needs: 'carton'},
  {key: 'caseBoardPerM2',   label: 'Case board',   unit: 'area', needs: 'case'},
  {key: 'filmPerKg',        label: 'Film',         unit: 'mass', needs: 'film'},
  {key: 'trayEach',         label: 'Tray',         unit: 'each', needs: 'tray'},
  {key: 'uboardBoardPerM2', label: 'U-board',      unit: 'area', needs: 'uboard'},
  {key: 'palletPerTrip',    label: 'Pallet',       unit: 'trip', needs: 'pallet'},
  {key: 'capBoardPerM2',    label: 'Cap board',    unit: 'area', needs: 'cap'}
]);

/** ft² in one m² — the ONE conversion factor the rate display uses. */
export const FT2_PER_M2 = 10.7639104167097;
/** ft in one metre — the length-basis analogue of FT2_PER_M2, for corner
 *  post's $/m stored rate shown as $/ft in an inch project. */
export const FT_PER_M = 3.280839895013123;

/** The rate actually in force: the override if there is one, else the
 *  default. The single reader — the panel, the readouts and the Build column
 *  must never disagree about what a rate is. */
export function rateOf(cost, key){
  const v = cost ? cost[key] : undefined;
  return (typeof v === 'number' && isFinite(v)) ? v : COST_DEFAULTS[key];
}

/** A canonical rate in its DISPLAY unit. Board rates are per m² stored and
 *  per ft² shown in an inch project; corner post's perLength rate is per m
 *  stored and per ft shown; mass and per-each rates have no unit system to
 *  follow. */
export const rateToDisplay = (v, kind, unit) =>
  (kind === 'area' && unit === 'in') ? v/FT2_PER_M2 :
  (kind === 'length' && unit === 'in') ? v/FT_PER_M : v;
/** The inverse, for reading a typed rate back into storage. */
export const rateFromDisplay = (v, kind, unit) =>
  (kind === 'area' && unit === 'in') ? v*FT2_PER_M2 :
  (kind === 'length' && unit === 'in') ? v*FT_PER_M : v;

/**
 * Material cost per sellable pack, and the roll-ups.
 *
 * ONE computation: the per-pack breakdown. Every roll-up is that same
 * breakdown multiplied by a count, so a case cost and a pallet cost cannot
 * drift from the pack cost they are made of — and the pallet trip lands
 * exactly once per pallet by construction (its per-pack share is
 * `palletPerTrip / packsPerPallet`).
 *
 * A term whose quantity is absent is simply absent from the breakdown, and
 * `missing` names it. A chain with no carton contributes no carton cost, and
 * says so, rather than quietly costing zero board.
 *
 * @param {Object} q  quantities, all already solved by the chain:
 *   {cartonBoardM2, caseBoardM2, filmKgPerPack, traysPerPack, uboardAreaM2,
 *    packsPerCarton, cartonsPerCase, packsPerPallet,
 *    cornerPostBasis, cornerPostLengthM, cornerPostCount}
 * @param {Object} [cost]  project.cost — the overrides, absent = default
 * @returns {{perPack: Object, terms: Array, packCost: number|null,
 *            perCase: number|null, perPallet: number|null,
 *            per1000Packs: number|null, missing: string[]}}
 */
export function materialCost(q, cost){
  const R = k => rateOf(cost, k);
  const num = v => typeof v === 'number' && isFinite(v) && v > 0;

  const perPack = {}, missing = [];
  // packs under one carton, and packs under one case. A chain without a
  // carton puts the packs straight into the case, so the case divides by the
  // packs it holds directly — the counts come from the row either way, never
  // from a re-solve here.
  const packsPerCarton = num(q.packsPerCarton) ? q.packsPerCarton : null;
  const packsPerCase = num(q.cartonsPerCase)
    ? q.cartonsPerCase*(packsPerCarton || 1) : null;

  // ONE unit of each thing, first — this is the number the per-level readout
  // shows beside that level's own area/mass. The per-pack share below divides
  // it by the packs that unit carries, so the rail and the roll-up are the
  // same multiplication seen at two scales.
  const perUnit = {};
  if(num(q.cartonBoardM2)) perUnit.carton = q.cartonBoardM2*R('cartonBoardPerM2');
  if(num(q.caseBoardM2))   perUnit.case   = q.caseBoardM2*R('caseBoardPerM2');
  if(num(q.filmKgPerPack)) perUnit.film   = q.filmKgPerPack*R('filmPerKg');
  if(num(q.traysPerPack))  perUnit.tray   = q.traysPerPack*R('trayEach');
  // U-board is one per pack, same cardinality as film/tray (it wraps ONE
  // collation's worth of product) — added directly per-pack below, never
  // divided by a carton/case count the way board is.
  if(num(q.uboardAreaM2))  perUnit.uboard = q.uboardAreaM2*R('uboardBoardPerM2');

  if(perUnit.film != null) perPack.film = perUnit.film;
  else missing.push('film');

  if(perUnit.tray != null) perPack.tray = perUnit.tray;
  else missing.push('tray');

  if(perUnit.uboard != null) perPack.uboard = perUnit.uboard;
  else missing.push('uboard');

  if(perUnit.carton != null && packsPerCarton) perPack.carton = perUnit.carton/packsPerCarton;
  else missing.push('carton');

  if(perUnit.case != null && packsPerCase) perPack.case = perUnit.case/packsPerCase;
  else missing.push('case');

  if(num(q.packsPerPallet)) perPack.pallet = R('palletPerTrip')/q.packsPerPallet;
  else missing.push('pallet');

  // Corner post: a PER-PALLET quantity like the pallet trip fee above, not a
  // per-pack one like film/tray/uboard — 4 posts x every stack position,
  // spread across the packs that pallet carries. Priced by LENGTH or by
  // PIECE, never by area; `q.cornerPostBasis` names which (resolved once by
  // the caller via core/materials.js's cornerPostBasisOf, never re-derived
  // here), and costForBasis is exhaustive over PRICING_BASES so an
  // unrecognized basis throws instead of silently pricing as zero.
  if(q.cornerPostBasis && num(q.packsPerPallet)){
    const rate = cornerPostRateOf(cost, q.cornerPostBasis);
    const total = costForBasis(q.cornerPostBasis, rate, {lengthM: q.cornerPostLengthM, count: q.cornerPostCount});
    if(total != null) perUnit.cornerPost = total;
  }
  if(perUnit.cornerPost != null && num(q.packsPerPallet)) perPack.cornerPost = perUnit.cornerPost/q.packsPerPallet;
  else missing.push('cornerPost');

  // Caps: a PER-PALLET quantity like the posts and the pallet trip above --
  // `capAreaM2` is already the WHOLE stack's cap area (plus area x caps per
  // position x positions), summed once by the caller in stack/cap terms, so
  // this multiplies a rate and divides by the pack count and does nothing
  // else. The area is the PLUS, not the bounding rectangle: the four corner
  // squares are cut away and are not part of the blank being charged (see
  // core/cap.js capPlusAreaMM2, which also states the scrap assumption).
  if(num(q.capAreaM2) && num(q.packsPerPallet)){
    const total = costForBasis('perArea', R('capBoardPerM2'), {areaM2: q.capAreaM2});
    if(total != null) perUnit.cap = total;
  }
  if(perUnit.cap != null && num(q.packsPerPallet)) perPack.cap = perUnit.cap/q.packsPerPallet;
  else missing.push('cap');

  const terms = Object.keys(perPack);
  const packCost = terms.length ? terms.reduce((s, k) => s + perPack[k], 0) : null;

  return {
    perPack, perUnit, terms, packCost, missing,
    packsPerCarton, packsPerCase,
    perCase:      packCost != null && packsPerCase   ? packCost*packsPerCase   : null,
    perPallet:    packCost != null && num(q.packsPerPallet) ? packCost*q.packsPerPallet : null,
    per1000Packs: packCost != null ? packCost*1000 : null
  };
}

/** Money, formatted. Sub-cent values are where a per-pack material cost
 *  actually lives (a carton is fractions of a cent per pack), so the
 *  precision follows the magnitude rather than rounding the number away. */
export function fmtMoney(v){
  if(v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  return '$' + (a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : v.toFixed(5));
}
