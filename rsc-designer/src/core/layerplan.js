/**
 * Layer-plan geometry — the ONE place that turns a pallet-pattern
 * candidate's build() result into a flat, format-agnostic top-down layout
 * (deck-mm, centred at (0,0), matching palletpatterns.js's own "deck-
 * centred positions" convention). Every consumer that draws a layer plan —
 * the 3D render inset, the pattern-table thumbnail grid, and the Pallet
 * PDF's vector section — calls this SAME function and renders whatever it
 * returns; none of them re-derive case footprints or orientation mapping
 * on their own, so the three can never show different geometry for "the
 * same" candidate. DOM-free, mm-only, per core/'s own rule.
 */
import {orientDims} from './containment.js';

/**
 * @param {Object} built       a palletpatterns.js candidate's build() result
 *                              — {placements: [{x,y,z,orientation}], envelope: {L,W}, ...}
 * @param {{L:number,W:number,H:number}} caseOuter  the case/tertiary style's
 *                              outer dims — orientDims maps it per placement
 * @param {number} [layerIndex=0]  which stacked layer to draw, bottom-first
 *                              (layers can differ under an interlock
 *                              schedule — this draws exactly ONE of them,
 *                              never a composite)
 * @returns {{cases: Array<{x:number,y:number,w:number,h:number}>, envelope:{L:number,W:number}, layerIndex:number, layerCount:number}}
 *          case rects centred at (x,y), full width/height w/h, in the same
 *          deck-centred mm frame `placements` already use
 */
export function layerPlanGeometry(built, caseOuter, layerIndex = 0){
  const zs = [...new Set(built.placements.map(p => p.z))].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(layerIndex, zs.length - 1));
  const z = zs[idx];
  const cases = built.placements
    .filter(p => p.z === z)
    .map(p => {
      const d = orientDims(caseOuter, p.orientation);
      return {x: p.x, y: p.y, w: d.l, h: d.w};
    });
  return {cases, envelope: built.envelope, layerIndex: idx, layerCount: zs.length};
}
