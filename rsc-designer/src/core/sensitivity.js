/**
 * Dimensional sensitivity: which case dimension is binding on the pallet,
 * and what would the smallest change buy or cost?
 *
 * For each of the outermost tier's OUTER L / W / H, independently (never
 * combinations), find the nearest BREAKPOINT in both directions:
 *   · decrease — the smallest reduction where cartons/pallet INCREASES
 *   · increase — the smallest growth where cartons/pallet DECREASES; one
 *     less than that is the HEADROOM (how far it can grow for free)
 *
 * READ-ONLY. Nothing here mutates the project, the selected candidate, or
 * the pattern pick — every probe is a hypothetical evaluated in isolation
 * and thrown away. The perturbed configurations are NOT selectable: a
 * smaller case physically holds less, so a reduction is only achievable if
 * the carton/product give the space back. This is a sensitivity diagnostic,
 * not a configuration (the UI must say so).
 *
 * BINARY SEARCH, not a sweep. Cartons/pallet is monotonically non-increasing
 * in each case dimension — a smaller case fits anywhere a larger one did — so
 * each "smallest step that changes the count" predicate is monotone in the
 * step, and ~6 probes replace ~60. Six directions ≈ 40 pallet solves total.
 *
 * ONE SOLVER. Every probe calls the SAME palletPatternList the chain uses,
 * with the same deck, clearance, orientations and family filter — only the
 * child's outer dims differ. There is no second packing model here, so the
 * analysis can never disagree with the pallet it is analysing. Probes run
 * with memoisation off: their dimensions never recur, and caching
 * hypotheticals would evict the real chain's entries.
 *
 * DOM-free, mm-only (the UI formats into the display unit).
 */
import {palletPatternList} from './palletpatterns.js';
import {describeChain} from './project.js';

/** Search bound per direction, as a fraction of the current dimension.
 *  Beyond this we report "no gain" / "headroom >" rather than searching on —
 *  a 15%-plus dimensional change is a different package, not a tweak. */
export const SEARCH_FRACTION = 0.15;

const AXES = [
  {axis: 'L', label: 'Length', span: 'nx'},
  {axis: 'W', label: 'Width',  span: 'ny'},
  {axis: 'H', label: 'Height', span: 'nz'}
];

/**
 * Smallest step in [1, maxStep] whose probe satisfies the monotone
 * predicate, or null if none does. Checks the bound first (one probe), so a
 * "no breakpoint" answer costs 1 probe instead of log2(maxStep).
 */
function firstStep(probe, pred, maxStep){
  if(maxStep < 1 || !pred(probe(maxStep))) return null;
  let lo = 1, hi = maxStep;
  while(lo < hi){
    const mid = (lo + hi) >> 1;                 // floor
    if(pred(probe(mid))) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * @param {Object} project  read only — never mutated
 * @param {Object} row      the active decorated candidate row (resolveActiveRow)
 * @returns {{baseline, axes, probes, ms, outerNoun, childNoun}|null}
 *   null when the row carries no pallet-bearing geometry to analyse.
 *   Each axis entry:
 *     {axis, label, current,
 *      gain:     {found, step, cases, cartons, perCarton}|{found: false, bound},
 *      headroom: {found, mm, cases, cartons}|{found: false, bound}}
 *   `cases`/`cartons` are DELTAS against the baseline (gain positive, loss
 *   negative). `perCarton` is the approximate per-carton reduction implied
 *   by the case reduction (step ÷ cartons spanning that axis) — a preview of
 *   the upstream cascade, ignoring caliper and clearances; null when the
 *   grid span isn't known (a locked tier reports no nx/ny/nz).
 */
export function analyzeSensitivity(project, row){
  if(!row || !row.outer) return null;
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const {outerKey, outerNoun, childNoun} = describeChain(project);
  const level = project[outerKey];
  if(!level) return null;

  const p = project.pallet;
  const cavity = {L: p.L, W: p.W, H: p.maxH - p.baseH};
  const mult = row.perPalletMultiplier != null ? row.perPalletMultiplier : 1;
  // An open-top tier stacks at whichever is taller: its own outer height or
  // its contents standing proud of the walls (chainMetrics' stackH). Below
  // that floor, shaving the walls buys nothing on the pallet — so the H
  // probes must respect it or they would report a gain that isn't real.
  const proudFloor = row.unitStackH > row.outer.H ? row.unitStackH : 0;

  let probes = 0;
  /** Best cases/pallet with ONE outer axis moved by `delta` mm. */
  const solve = (axis, delta) => {
    probes++;
    const outer = {...row.outer, [axis]: row.outer[axis] + delta};
    const stackH = axis === 'H' ? Math.max(outer.H, proudFloor) : row.unitStackH;
    const list = palletPatternList(
      {outer: {...outer, H: stackH}, allowedOrientations: level.allowedOrientations},
      cavity, level.clearance, p.pattern, {noMemo: true});
    return list.length ? list[0].total : 0;
  };

  // Baseline through the IDENTICAL path as every probe (delta 0), so the
  // comparison can't be skewed by a different code path. This is the
  // best-achievable count at the current size within the current family —
  // which is what a perturbed probe also reports, so the two are comparable
  // even when the user has cycled to a non-optimal pattern.
  const baseCases = solve('L', 0);
  const baseline = {cases: baseCases, cartons: baseCases*mult};

  const axes = AXES.map(({axis, label, span}) => {
    const current = row.outer[axis];
    // never probe below 1mm, and never past the 15% bound
    const bound = Math.max(0, Math.floor(SEARCH_FRACTION*current));
    const downMax = Math.min(bound, Math.max(0, Math.ceil(current) - 1));

    const down = firstStep(s => solve(axis, -s), c => c > baseCases, downMax);
    const up   = firstStep(s => solve(axis,  s), c => c < baseCases, bound);

    const nSpan = typeof row[span] === 'number' && row[span] > 0 ? row[span] : null;
    const gain = down === null
      ? {found: false, bound: downMax}
      : (() => { const c = solve(axis, -down);
                 return {found: true, step: down, cases: c - baseCases,
                         cartons: (c - baseCases)*mult,
                         perCarton: nSpan ? down/nSpan : null}; })();
    // the first LOSING step is `up`; headroom is everything below it
    const headroom = up === null
      ? {found: false, bound}
      : (() => { const c = solve(axis, up);
                 return {found: true, mm: up - 1, atStep: up,
                         cases: c - baseCases, cartons: (c - baseCases)*mult}; })();
    return {axis, label, current, gain, headroom};
  });

  const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
  return {baseline, axes, probes, ms: t1 - t0, outerNoun, childNoun,
          searchFraction: SEARCH_FRACTION};
}
