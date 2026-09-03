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
 * tolerance is one rank — and every placement in a rank moves together.
 *
 * X AND Z ARE CENTRED, Y IS ONE-SIDED — a genuine asymmetry, not an
 * oversight (`rankOffsets` for X/Z, `rankOffsetsUp` for Y — see each).
 * On X/Z, ranks are numbered OUT FROM THE CENTRE (the middle rank is 0; a
 * 2-way split gets ±0.5, a 3-way split -1/0/1): even, countable gaps
 * spreading both ways, which is right there — a horizontal spread has no
 * "up" or "down" to respect. On Y — vertical, the axis every level in this
 * chain is actually LOADED along — a centred spread sends half the
 * contents BELOW the container floor, which is not "exploded", it is
 * wrong: nothing was ever loaded through the floor, so nothing should
 * explode through it either. Y ranks are numbered from the LOWEST rank
 * (rank 0, offset 0) increasing upward: contents lift OUT of their
 * container the same direction they were loaded INTO it, and the lowest
 * rank never moves at all — no offset on this module is ever negative on Y.
 *
 * THE SHELL follows the same asymmetry. On X/Z it steps out by one
 * ADDITIVE gap beyond the outermost content rank (never a rank count
 * multiplied onto the shell's own size — see `shellOffset`'s X/Z proof).
 * On Y it does not move AT ALL: it stays at its solved position while the
 * contents rise out of it, rather than it stepping down to meet them. See
 * `shellOffset`'s Y proof for why that is provably enough (and its one
 * honest, disclosed limitation).
 *
 * Factor 0 is identity BY CONSTRUCTION: every offset is `factor × …`, so a
 * caller that forgets to gate on factor cannot un-explode by accident, and a
 * pin can assert bit-identical placement at factor 0 without a special case
 * anywhere in this module.
 */

/** Gap between adjacent ranks, in unit-dimensions, at factor 1. Shared by
 *  every axis — ON X/Z AND ON Y, `> 1` is what turns a rank step into a
 *  visible separation rather than a null one (see both proofs on
 *  `shellOffset` below; they arrive at the identical `K > 1` threshold by
 *  two different arguments, which is why one constant serves both shapes).
 *  Do not lower this without re-checking BOTH proofs. */
export const EXPLODE_GAP_K = 1.5;

/** Coordinates within this many mm are the same rank. */
const RANK_TOL = 1e-3;

/**
 * Cluster `values` into ranks (equal value within `tol` is one rank) and
 * return the rank-offset-from-centre for each INPUT value, same order and
 * length as `values`. The middle rank is 0; a 2-way split gets ±0.5, a
 * 3-way split gets -1/0/1, and so on — symmetric and centred before any
 * scaling, so multiplying by a signed step spreads evenly both ways.
 *
 * X/Z only — see the module header for why Y uses `rankOffsetsUp` instead.
 */
export function rankOffsets(values, tol = RANK_TOL){
  const uniq = [];
  for(const v of values) if(!uniq.some(u => Math.abs(u - v) <= tol)) uniq.push(v);
  uniq.sort((a, b) => a - b);
  const mid = (uniq.length - 1)/2;
  return values.map(v => uniq.findIndex(u => Math.abs(u - v) <= tol) - mid);
}

/**
 * Cluster `values` into ranks exactly like `rankOffsets`, but number them
 * 0..n-1 from the LOWEST value upward — never centred, never negative.
 * Rank 0 (the lowest content) always gets offset 0: it never moves, because
 * nothing above the floor should ever explode BELOW it. Y only.
 */
export function rankOffsetsUp(values, tol = RANK_TOL){
  const uniq = [];
  for(const v of values) if(!uniq.some(u => Math.abs(u - v) <= tol)) uniq.push(v);
  uniq.sort((a, b) => a - b);
  return values.map(v => uniq.findIndex(u => Math.abs(u - v) <= tol));
}

/**
 * Per-value offsets for ONE axis: `factor × EXPLODE_GAP_K × rank × unit`.
 * `unit` is the axis's own fixed step size — pass the LARGEST extent among
 * the instances being ranked, so one step serves every rank and consecutive
 * gaps come out exactly equal regardless of any per-instance size variation
 * (a mixed-orientation tier, say — the rank spacing is uniform either way).
 * Factor 0 short-circuits to all-zero without computing ranks at all.
 *
 * `oneSidedUp` selects `rankOffsetsUp` in place of the centred `rankOffsets`
 * — pass `true` for the vertical axis (Y), `false`/omit for X or Z. Every
 * caller of this function on Y (this module's own `explodeTier`, and
 * hierarchy3d.js's U-board/product split) must pass it, or content on that
 * axis will spread below its solved position again.
 */
export function axisOffsets(values, unit, factor, oneSidedUp = false){
  if(!factor) return values.map(() => 0);
  const ranks = oneSidedUp ? rankOffsetsUp(values) : rankOffsets(values);
  return ranks.map(r => factor*EXPLODE_GAP_K*r*unit);
}

/**
 * The shell's own offset for one axis, given the CONTENT ranks already
 * computed for that axis (raw rank output, unscaled — `rankOffsets` for
 * X/Z, `rankOffsetsUp` for Y), the content's own per-rank step size, and
 * the shell's own outer dimension.
 *
 * ============================== X/Z PROOF ==============================
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
 *
 * ================================ Y PROOF ================================
 * The shell does NOT move on Y (`oneSidedUp` returns 0 unconditionally) —
 * re-derived, not assumed, because the geometry the X/Z proof rests on
 * doesn't carry over: the outermost content rank is no longer at
 * ±(n-1)/2 from centre, it's at (n-1) from the BOTTOM, and there is no
 * moving shell edge to chase it.
 *
 * What CAN be proven instead: with the shell fixed, does the topmost
 * content rank clear the shell's own RIM (the top edge of its side walls,
 * at +shellDim/2 — every container this app draws is open-topped:
 * hierarchy3d.js's `cutawayBox` builds four walls and a floor, no ceiling,
 * so "clearing the rim" is a VISIBILITY question, not a collision one —
 * content above +shellDim/2 reads as lifted clear of the box; content
 * below it, however far offset, still sits inside the walls' own
 * silhouette)?
 *
 *   worst-case original position of the topmost content (r = maxRank):
 *     p_top >= -shellDim/2 + contentUnit/2        (content fits inside the shell)
 *   its far edge after lifting:
 *     farEdge >= p_top + K·r·contentUnit + contentUnit/2
 *             >= -shellDim/2 + contentUnit + K·r·contentUnit
 *   clears the rim (farEdge > shellDim/2) exactly when:
 *     K·r·contentUnit > shellDim − contentUnit                       (*)
 *
 * Unlike the X/Z proof, "one content unit fits inside the shell"
 * (contentUnit <= shellDim) is NOT enough to bound (*) for a FIXED K:
 * shellDim can exceed contentUnit by an arbitrary ratio (an r+1-layer
 * stack in a tall case has shellDim ~ (r+1)×contentUnit), and satisfying
 * (*) at large r would then need K to grow with the layer count.
 *
 * The bound that DOES make (*) hold for a fixed K is that content FILLS
 * the shell along this axis — true for every CLOSED style in this app: the
 * outer's own H is solved FROM the stacked content (r+1 layers of
 * contentUnit, plus the small top/bottom clearances containment.js already
 * reserves), so shellDim <= (r+1)·contentUnit + slack, slack small
 * relative to the stack. Taking the tightest case (slack -> 0, hardest to
 * clear):
 *     shellDim = (r+1)·contentUnit
 *   substitute into (*):
 *     K·r·contentUnit > (r+1)·contentUnit − contentUnit = r·contentUnit
 *     K > 1
 * — the SAME threshold the X/Z proof needs, reached by a different
 * argument (there, K>1 is what makes the shell clear a fixed content
 * envelope; here, it's what makes a lift exceed the stack's own fill
 * height). EXPLODE_GAP_K = 1.5 already satisfies both: NO axis-specific
 * constant is needed, and this is a finding, not an assumption — the
 * result could have come out otherwise.
 *
 * With real (nonzero) clearance slack, margin only shrinks by
 * `slack / (r·contentUnit)`, which stays small for any ordinary top/bottom
 * clearance value (a few mm against a stack many multiples of one
 * content's own height).
 *
 * THE ONE HONEST GAP: an `openTop` level (core/project.js — a tray, or any
 * style with `defaultOpenTop`) sizes H INDEPENDENTLY of the stacked
 * content — "an independent design input, not solved from the child
 * stack" (see this codebase's own note on that field). Its shellDim is NOT
 * bounded by (r+1)·contentUnit; a tray built with real headroom above its
 * contents has slack this proof cannot absorb, and at large enough slack
 * the topmost content may lift short of the rim at factor 1. That is a
 * real, disclosed limitation, not a silent one — the same looseness
 * `openTop`'s own doc comment already accepts for H, inherited here rather
 * than fought.
 */
export function shellOffset(contentRanks, contentUnit, shellDim, factor, oneSidedUp = false){
  if(!factor) return 0;
  if(oneSidedUp) return 0;
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
    const oneSidedUp = ax === 'y';
    const values = positions.map(p => p[ax]);
    const unit = extents.length ? Math.max(...extents.map(e => e[ax])) : 0;
    axisOffsets(values, unit, factor, oneSidedUp).forEach((o, i) => { offsets[i][ax] = o; });
    const ranks = oneSidedUp ? rankOffsetsUp(values) : rankOffsets(values);
    shell[ax] = shellOffset(ranks, unit, shellExtent[ax], factor, oneSidedUp);
  }
  return {offsets, shell};
}
