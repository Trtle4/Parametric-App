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
 */

/** $ per canonical unit. See the note above: placeholders, not quotes. */
export const COST_DEFAULTS = Object.freeze({
  cartonBoardPerM2: 0.62,     // folding carton board, converted + printed
  caseBoardPerM2:   0.45,     // corrugated case board
  filmPerKg:        3.20,     // BOPP / PE wrap film
  trayEach:         0.18,     // thermoformed tray, per part
  palletPerTrip:   12.00      // one pallet, one trip
});

/** The rate vocabulary, in display order. `unit` is the DISPLAY kind, which
 *  is all that varies with the project's unit system; `key` is the canonical
 *  stored field. `needs` names the chain level a rate applies to, so a rail
 *  can omit rows for levels that are not in the chain. */
export const RATE_ROWS = Object.freeze([
  {key: 'cartonBoardPerM2', label: 'Carton board', unit: 'area', needs: 'carton'},
  {key: 'caseBoardPerM2',   label: 'Case board',   unit: 'area', needs: 'case'},
  {key: 'filmPerKg',        label: 'Film',         unit: 'mass', needs: 'film'},
  {key: 'trayEach',         label: 'Tray',         unit: 'each', needs: 'tray'},
  {key: 'palletPerTrip',    label: 'Pallet',       unit: 'trip', needs: 'pallet'}
]);

/** ft² in one m² — the ONE conversion factor the rate display uses. */
export const FT2_PER_M2 = 10.7639104167097;

/** The rate actually in force: the override if there is one, else the
 *  default. The single reader — the panel, the readouts and the Build column
 *  must never disagree about what a rate is. */
export function rateOf(cost, key){
  const v = cost ? cost[key] : undefined;
  return (typeof v === 'number' && isFinite(v)) ? v : COST_DEFAULTS[key];
}

/** A canonical rate in its DISPLAY unit. Board rates are per m² stored and
 *  per ft² shown in an inch project; mass and per-each rates have no unit
 *  system to follow. */
export const rateToDisplay = (v, kind, unit) =>
  (kind === 'area' && unit === 'in') ? v/FT2_PER_M2 : v;
/** The inverse, for reading a typed rate back into storage. */
export const rateFromDisplay = (v, kind, unit) =>
  (kind === 'area' && unit === 'in') ? v*FT2_PER_M2 : v;

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
 *   {cartonBoardM2, caseBoardM2, filmKgPerPack, traysPerPack,
 *    packsPerCarton, cartonsPerCase, packsPerPallet}
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

  if(perUnit.film != null) perPack.film = perUnit.film;
  else missing.push('film');

  if(perUnit.tray != null) perPack.tray = perUnit.tray;
  else missing.push('tray');

  if(perUnit.carton != null && packsPerCarton) perPack.carton = perUnit.carton/packsPerCarton;
  else missing.push('carton');

  if(perUnit.case != null && packsPerCase) perPack.case = perUnit.case/packsPerCase;
  else missing.push('case');

  if(num(q.packsPerPallet)) perPack.pallet = R('palletPerTrip')/q.packsPerPallet;
  else missing.push('pallet');

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
