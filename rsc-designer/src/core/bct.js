/**
 * Box compression (BCT) — McKee ECT short-form estimate.
 *
 * ENGINEERING GUIDANCE, NOT A GUARANTEE. McKee predicts SHORT-TERM lab
 * top-to-bottom compression of a regular RSC. Real field stacking strength is
 * substantially lower; the safety factor is what absorbs that gap (see
 * DERATINGS below). Callers must present it caveated, never as a promise.
 *
 * McKee, ECT short form (imperial — the 5.87 constant is imperial):
 *     BCT [lb] = 5.87 * ECT[lb/in] * sqrt( caliper[in] * perimeter[in] )
 *   where perimeter = 2*(L + W).
 *
 * This module is mm-native like the rest of core/: it takes mm and converts to
 * inches ONLY at the McKee boundary (the constant demands imperial). Getting
 * that conversion wrong yields a plausible-but-wrong safety number — the worst
 * failure mode for a safety calc — so it is isolated here and tested explicitly.
 * DOM-free, pure.
 */

const MM_PER_IN = 25.4;

/** McKee's 5.87 assumes a REGULAR RSC. For other constructions the estimate is
 *  rougher; callers surface `approximate` so a tray is never shown with an
 *  RSC's confidence. */
export const MCKEE_K = 5.87;

/** Field deratings the safety factor is there to cover — surfaced verbatim by
 *  the UI so the number is never a bare ratio the user is asked to trust. */
export const DERATINGS = [
  'Sustained load / creep: ~35–40% loss over time',
  'Humidity: up to ~50% loss at high RH',
  'Pallet overhang & misalignment',
  'Cutouts, hand-holds, and print'
];

/**
 * McKee BCT from mm inputs.
 * @param {{ectLbPerIn:number, caliperMm:number, perimeterMm:number}} p
 * @returns {{bctLb:number, caliperIn:number, perimeterIn:number}}
 */
export function estimateBCT({ectLbPerIn, caliperMm, perimeterMm}){
  const caliperIn = caliperMm / MM_PER_IN;
  const perimeterIn = perimeterMm / MM_PER_IN;
  const arg = caliperIn * perimeterIn;
  const bctLb = arg > 0 && ectLbPerIn > 0 ? MCKEE_K * ectLbPerIn * Math.sqrt(arg) : 0;
  return {bctLb, caliperIn, perimeterIn};
}

/**
 * Full stacking analysis for the load-bearing bottom box.
 * @param {Object} p
 *   ectLbPerIn, caliperMm, L_mm, W_mm  — the CASE (bottom box) board + footprint
 *   boxesAbove                          — core/stack.js resolveStack().boxesAboveBottom
 *   tareAboveLb                         — core/stack.js resolveStack().tareAboveLb (default 0)
 *   casesPerLayer                       — the chain's own pallet fit (project.js), read not
 *                                          recomputed; used only to spread tareAboveLb per column
 *   unitWeightLb                        — gross weight per box (tare + contents), user input
 *   targetRatio                         — required safety factor (default 3.0)
 *   isRSC                               — true only for a regular RSC (fefco201)
 * @returns {Object} bctLb, loadLb, boxLoadLb, tarePerColumnLb, ratio (Infinity if
 *                   no load), meetsTarget, perimeterMm/In, caliperIn, approximate
 */
export function stackAnalysis({ectLbPerIn, caliperMm, L_mm, W_mm, boxesAbove, tareAboveLb = 0, casesPerLayer = 0, unitWeightLb, targetRatio, isRSC}){
  const perimeterMm = 2*(L_mm + W_mm);
  const {bctLb, caliperIn, perimeterIn} = estimateBCT({ectLbPerIn, caliperMm, perimeterMm});
  const boxLoadLb = Math.max(0, boxesAbove) * Math.max(0, unitWeightLb);
  // Tare (pallet/slipsheet weight bearing on the bottom case) is carried by
  // the whole deck, so it is spread evenly across the columns the deck's
  // own pattern actually placed — casesPerLayer, the chain's own number.
  const tarePerColumnLb = casesPerLayer > 0 ? Math.max(0, tareAboveLb)/casesPerLayer : 0;
  const loadLb = boxLoadLb + tarePerColumnLb;
  const ratio = loadLb > 0 ? bctLb / loadLb : Infinity;
  return {
    bctLb, loadLb, boxLoadLb, tarePerColumnLb, ratio,
    meetsTarget: ratio >= targetRatio,
    perimeterMm, perimeterIn, caliperIn,
    approximate: !isRSC   // non-RSC: the 5.87 constant is a rougher fit
  };
}
