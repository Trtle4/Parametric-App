/**
 * Exploded-view offsets.
 *
 * A TRANSFORM ON SOLVED PLACEMENTS, never a second layout: `core/containment.js`
 * and `core/collation.js` are never touched or re-invoked. This module only
 * computes, per placement, an offset vector to add to the position the chain
 * already solved — nothing here decides where anything WAS, only how far
 * apart to draw it. DOM-free, no THREE dependency: everything here is plain
 * numbers and {x,y,z} objects, so it is usable and testable without a scene.
 *
 * RANK-BASED, NOT PROPORTIONAL FROM THE CENTROID. Proportional scaling gives
 * factor-zero identity for free, but its gaps grow with distance from
 * centre — outer units fly apart while inner ones barely separate, which
 * defeats the point of a drawing meant to be COUNTED (a 4×3×2 arrangement
 * should show four, three and two EVEN gaps, not a gradient). So positions
 * are clustered into RANKS along an axis — equal coordinate within a
 * tolerance is one rank, and every placement in it moves together — the
 * ranks are numbered out from the centre, and each rank steps by a FIXED
 * multiple of the axis's own UNIT dimension (the instance's own size, never
 * the container's), so a case of cartons and a pallet of cases look right
 * at the same factor. The SHELL steps out by one ADDITIVE gap beyond the
 * outermost content rank, never a rank count multiplied onto the shell's
 * own size — see `shellOffset`'s proof.
 *
 * Factor 0 is identity BY CONSTRUCTION: every offset is `factor × …`, so a
 * caller that forgets to gate on factor cannot un-explode by accident, and a
 * pin can assert bit-identical placement at factor 0 without a special case
 * anywhere in this module.
 */

/** Gap between adjacent ranks, in unit-dimensions, at factor 1. > 1 is
 *  load-bearing — it is what guarantees the SHELL clears the outermost
 *  content rank (see `shellOffset`'s proof below). Do not lower this
 *  without re-checking that proof. */
export const EXPLODE_GAP_K = 1.5;

/** Coordinates within this many mm are the same rank. */
const RANK_TOL = 1e-3;

/**
 * Cluster `values` into ranks (equal value within `tol` is one rank) and
 * return the rank-offset-from-centre for each INPUT value, same order and
 * length as `values`. The middle rank is 0; a 2-way split gets ±0.5, a
 * 3-way split gets -1/0/1, and so on — symmetric and centred before any
 * scaling, so multiplying by a signed step spreads evenly both ways.
 */
export function rankOffsets(values, tol = RANK_TOL){
  const uniq = [];
  for(const v of values) if(!uniq.some(u => Math.abs(u - v) <= tol)) uniq.push(v);
  uniq.sort((a, b) => a - b);
  const mid = (uniq.length - 1)/2;
  return values.map(v => uniq.findIndex(u => Math.abs(u - v) <= tol) - mid);
}

/**
 * Per-value offsets for ONE axis: `factor × EXPLODE_GAP_K × rank × unit`.
 * `unit` is the axis's own fixed step size — pass the LARGEST extent among
 * the instances being ranked, so one step serves every rank and consecutive
 * gaps come out exactly equal regardless of any per-instance size variation
 * (a mixed-orientation tier, say — the rank spacing is uniform either way).
 * Factor 0 short-circuits to all-zero without computing ranks at all.
 */
export function axisOffsets(values, unit, factor){
  if(!factor) return values.map(() => 0);
  return rankOffsets(values).map(r => factor*EXPLODE_GAP_K*r*unit);
}

/**
 * The shell's own offset for one axis, given the CONTENT ranks already
 * computed for that axis (raw `rankOffsets` output, unscaled), the
 * content's own per-rank step size, and the shell's own outer dimension.
 *
 * An ADDITIVE gap beyond the outermost (most positive) content rank's own
 * offset — never a rank count multiplied onto the shell's dimension, which
 * would make the shell fly further away the more ranks there are (a case of
 * a dozen cartons would fling its shell six times further than a case of
 * two, for no reason a viewer would read as meaningful). Content fits
 * inside the shell by construction, so the shell's own dimension is always
 * >= any content extent on the same axis, and EXPLODE_GAP_K > 1 is exactly
 * what makes ONE such gap clear the outermost content's bounding box
 * regardless of how many ranks came before it:
 *
 *   topContentOffset    = K·r·contentUnit                (r = outermost rank)
 *   shell's near edge   = topContentOffset + K·shellDim − shellDim/2
 *   content's far edge <= topContentOffset + contentUnit/2 <= topContentOffset + shellDim/2
 *   difference           = K·shellDim − shellDim           > 0  exactly when K > 1
 */
export function shellOffset(contentRanks, contentUnit, shellDim, factor){
  if(!factor) return 0;
  const maxRank = contentRanks.length ? Math.max(...contentRanks) : 0;
  const topContentOffset = factor*EXPLODE_GAP_K*maxRank*contentUnit;
  return topContentOffset + factor*EXPLODE_GAP_K*shellDim;
}

/**
 * Full per-placement offsets for one container tier, plus the shell's own
 * offset — one call computes both from the SAME rank set and the SAME
 * factor, so they can never disagree.
 *
 * @param {Array<{x:number,y:number,z:number}>} positions  each placement's
 *   own already-resolved local position (e.g. `childPos`'s output)
 * @param {Array<{x:number,y:number,z:number}>} extents  each placement's own
 *   oriented outer extent, same length/order as `positions`
 * @param {{x:number,y:number,z:number}} shellExtent  the container's own
 *   outer extent
 * @param {'x'|'y'|'z'|'all'} axis
 * @param {number} factor  0..1 — not clamped here, the caller's UI does that
 * @returns {{offsets: Array<{x,y,z}>, shell: {x,y,z}}}
 */
export function explodeTier(positions, extents, shellExtent, axis, factor){
  const axes = axis === 'all' ? ['x', 'y', 'z'] : [axis];
  const offsets = positions.map(() => ({x: 0, y: 0, z: 0}));
  const shell = {x: 0, y: 0, z: 0};
  if(!factor) return {offsets, shell};
  for(const ax of axes){
    const values = positions.map(p => p[ax]);
    const unit = extents.length ? Math.max(...extents.map(e => e[ax])) : 0;
    axisOffsets(values, unit, factor).forEach((o, i) => { offsets[i][ax] = o; });
    shell[ax] = shellOffset(rankOffsets(values), unit, shellExtent[ax], factor);
  }
  return {offsets, shell};
}
