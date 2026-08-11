/**
 * Cookie sizing tray — the PARAMETER + DERIVATION layer, ported from the
 * Cookie-Tray repo (`cookie_tray/params.py` + `cookie_tray/calculator.py`,
 * which are that project's source of truth; its `web/src/*.js` is a replicad
 * port of the same math).
 *
 * WHAT THIS IS NOT. Cookie-Tray's `geometry.py` / `geometry.js` build a
 * watertight 3D-printed solid with an OpenCASCADE B-rep kernel (CadQuery /
 * replicad): drafted lofts, boolean trough cuts, edge fillets, STEP/STL out.
 * None of that ports here — this app has no CSG kernel, no build step, and a
 * 3D-printed tray has no dieline at all (no cut/crease polylines, no blank,
 * nothing to DXF), so it cannot satisfy the `Geometry` contract in types.js.
 * Only the arithmetic below is portable, and it is pure: the upstream
 * modules import nothing but stdlib, and so does this one.
 *
 * WHAT IT IS FOR. `trayOuter()` publishes the tray's external envelope —
 * exactly the {L, W, H} the containment layer consumes — so a cookie tray
 * can be sized from a product spec and then treated as a rigid unit by the
 * rest of the chain. This module deliberately stops there: it declares no
 * level, no style, and no UI, because a part with no blank needs a product
 * ruling on what the 2D view and DXF export do before it can become either.
 *
 * DOM-free, mm-only, side-effect-free. Every derived value is computed once
 * into a FROZEN result — upstream they are lazy `@property`s off mutable
 * inputs; here the object cannot drift from the inputs it was built from,
 * which is the stronger form of this codebase's one-writer rule.
 *
 * Fidelity is pinned by differential test against the upstream Python
 * (test/cookietray.test.html carries the pinned vectors that sweep
 * generated).
 */

/** Outer-wall floor: the draft angle is reduced to respect this. */
export const MIN_WALL = 0.8;
/** Internal-divider floor. */
export const MIN_DIVIDER = 0.8;

const rad = d => d*Math.PI/180;
const deg = r => r*180/Math.PI;

/** The independent inputs (upstream spec §3) and their defaults. `cradleR`
 *  and `divider` default from other inputs, so they start null. */
export const TRAY_DEFAULTS = Object.freeze({
  nCells: 3,
  longAxis: 'X',        // 'X' = channels run along L; 'Y' rotates the part 90°
  cellLen: 170,
  cellWid: 48,
  cellH: 28,
  cradleR: null,        // defaults to cellWid/2
  wall: 3,              // outer-wall thickness
  divider: null,        // cell-to-cell wall; defaults to wall
  floor: 2.5,
  cornerR: 8,
  draftDeg: 5,
  stripL: 5,            // flange strip on the ±L (long-axis) sides
  stripW: 5,            // flange strip on the ±W sides
  lipH: 3,
  flangeT: 2.5,
  cellFillet: 2,
  nozzle: 0.42
});

/**
 * Build a validated tray parameter set with every derived value resolved.
 *
 * Clamps (never rejections) are reported on `warnings` rather than thrown:
 * upstream raises Python `warnings`, which have no equivalent here, and a
 * clamp is always a valid fallback the caller may want to surface. Hard
 * guards still throw — an invalid tray must not reach a consumer.
 *
 * @param {Object} [inputs] any subset of TRAY_DEFAULTS
 * @returns {Readonly<Object>} inputs (post-clamp) + derived + `warnings`
 * @throws {Error} on any guard the upstream module rejects
 */
export function trayParams(inputs = {}){
  const p = {...TRAY_DEFAULTS, ...inputs};
  const warnings = [];

  // ---- defaults derived from other inputs ----
  if(p.cradleR == null) p.cradleR = p.cellWid/2;
  if(p.divider == null) p.divider = p.wall;

  // ---- guards, in the upstream's own order (later guards read values the
  //      earlier clamps may have changed, so the order is load-bearing) ----
  if(!(p.nCells >= 1)) throw new Error(`nCells must be >= 1, got ${p.nCells}`);
  if(p.longAxis !== 'X' && p.longAxis !== 'Y')
    throw new Error(`longAxis must be "X" or "Y", got ${JSON.stringify(p.longAxis)}`);

  // 1: cradle radius can never exceed the half-width it has to sit in
  const maxCradleR = p.cellWid/2;
  if(p.cradleR > maxCradleR){
    warnings.push(`cradleR=${p.cradleR} exceeds cellWid/2=${maxCradleR}; clamping.`);
    p.cradleR = maxCradleR;
  }
  if(!(p.cradleR > 0)) throw new Error(`cradleR must be > 0, got ${p.cradleR}`);

  // 2: the rounded bottom cannot complete in a trough shallower than its radius
  if(p.cellH < p.cradleR)
    throw new Error(`cellH (${p.cellH}) must be >= cradleR (${p.cradleR}); the rounded bottom ` +
                    `cannot complete otherwise. Increase cellH or decrease cradleR.`);

  if(p.wall < MIN_WALL) throw new Error(`wall (${p.wall}) must be >= ${MIN_WALL}mm`);
  if(!(p.floor > 0)) throw new Error('floor must be > 0');

  // negative draft has no physical meaning; "no draft" is always valid
  if(p.draftDeg < 0){ warnings.push('draftDeg is negative; clamped to 0 (no draft).'); p.draftDeg = 0; }

  // ---- derived (upstream spec §3 "Derived") ----
  const lipT  = 3*p.nozzle;
  const topL  = p.cellLen + 2*p.wall;
  // outer walls both sides are `wall`; the nCells-1 internal dividers are `divider`
  const topW  = p.nCells*p.cellWid + 2*p.wall + (p.nCells - 1)*p.divider;
  const pitch = p.cellWid + p.divider;          // centre-to-centre; a view of `divider`
  const H     = p.floor + p.cellH;

  // The base inset from ONE continuous draft over the full height, limited so
  // the base never insets past `wall - MIN_WALL`. When the wall is thin the
  // ANGLE shrinks (effectiveDraftDeg) rather than the taper stopping partway
  // up — a bounded band plus a vertical step used to leave a visible crease.
  const fullInset  = p.draftDeg > 0 ? H*Math.tan(rad(p.draftDeg)) : 0;
  const maxInset   = Math.max(0, p.wall - MIN_WALL);
  const draftOffset = Math.min(fullInset, maxInset);
  if(fullInset > draftOffset + 1e-9) warnings.push('Draft reduced to fit a thin wall.');

  // 3: below this the drafted racetrack's bottom corner radius goes non-positive
  if(p.cornerR <= draftOffset)
    throw new Error(`cornerR (${p.cornerR}) must exceed the draft inset (${draftOffset.toFixed(4)}); ` +
                    `otherwise bottomCornerR is non-positive.`);

  // 4: the lip would otherwise consume the whole flange strip on that axis
  if(p.stripL <= lipT)
    throw new Error(`stripL (${p.stripL}) must exceed lipT (${lipT.toFixed(4)}); ` +
                    `otherwise the lip consumes the whole flange strip.`);
  if(p.stripW <= lipT)
    throw new Error(`stripW (${p.stripW}) must exceed lipT (${lipT.toFixed(4)}); ` +
                    `otherwise the lip consumes the whole flange strip.`);

  // 5: purely geometric validity — clamped silently upstream, so silent here
  const maxSafeFillet = Math.max(0, Math.min(p.cellWid, p.cellLen)/2 - 0.01);
  if(p.cellFillet > maxSafeFillet) p.cellFillet = maxSafeFillet;

  // 6-8: remaining hard guards
  if(p.divider < MIN_DIVIDER) throw new Error(`divider (${p.divider}) must be >= ${MIN_DIVIDER}mm`);
  if(!(p.lipH > 0))    throw new Error(`lipH (${p.lipH}) must be > 0`);
  if(!(p.flangeT > 0)) throw new Error(`flangeT (${p.flangeT}) must be > 0`);
  if(p.nozzle < 0)     throw new Error(`nozzle (${p.nozzle}) must be >= 0`);
  if(p.cellFillet < 0) throw new Error(`cellFillet (${p.cellFillet}) must be >= 0`);

  const outerL = topL + 2*p.stripL;
  const outerW = topW + 2*p.stripW;

  return Object.freeze({
    ...p,
    lipT, topL, topW, pitch, H,
    draftOffset,
    bottomL: topL - 2*draftOffset,
    bottomW: topW - 2*draftOffset,
    bottomCornerR: p.cornerR - draftOffset,
    effectiveDraftDeg: draftOffset <= 0 ? 0 : deg(Math.atan(draftOffset/H)),
    outerL, outerW,
    // min() keeps the corner blend clean when the two strip widths differ
    outerR: p.cornerR + Math.min(p.stripL, p.stripW),
    overallH: H + p.lipH,
    footprint: outerL*outerW,
    warnings: Object.freeze(warnings)
  });
}

/**
 * THE HANDOFF. The tray's external envelope in the containment layer's own
 * terms — the one expression the whole integration rests on, because every
 * downstream number (wrap, carton, case, pallet) is derived from it by
 * machinery that already works. Two things it must get right:
 *
 * 1. MAX CROSS-SECTION, never the tapered base. The tray is drafted, so it
 *    is WIDEST at the top: the flange (`outerL`/`outerW` = the rim plus its
 *    strips) is the largest section, while `bottomL`/`bottomW` are inset by
 *    the draft. The base footprint is a render-only detail; handing it up
 *    would undersize the wrap — and every level above it — in a way that
 *    still looks entirely plausible on screen.
 *
 * 2. PROUD CONTENTS. The tray is open-top, so product may stand above the
 *    cells; film pulls over the tallest thing present, not the tray rim.
 *    Same `max()` shape as the FEFCO 0300 open-tray work: the product tops
 *    out at `floor + productStandingH` (it bears on the cell floor, which
 *    sits at the tray's own floor thickness), and the envelope takes
 *    whichever of that and the tray's own overall height is taller.
 *
 * Rotation: upstream applies `long_axis` at BUILD time (`build_tray` rotates
 * the finished solid 90° about Z) while `outer_L`/`outer_W` stay in the
 * unrotated frame — it never has to reconcile the two because its only
 * consumer of both is `footprint`, a product and so rotation-invariant.
 * Here L and W are NOT interchangeable (they are distinct axes to a pallet
 * solve), so the rotation is applied to reach the real placed footprint.
 *
 * @param {Object} p a result of trayParams()
 * @param {number} [productStandingH=0] tallest product height above the cell
 *   floor, in the orientation it actually sits in. 0 = nothing proud.
 * @returns {{L: number, W: number, H: number}} mm, as placed
 */
export function trayOuter(p, productStandingH = 0){
  const H = Math.max(p.overallH, p.floor + (productStandingH > 0 ? productStandingH : 0));
  return p.longAxis === 'Y'
    ? {L: p.outerW, W: p.outerL, H}
    : {L: p.outerL, W: p.outerW, H};
}

/** Does the product stand above the tray's own rim? Surfaced so the render
 *  and the readout can say so, and so a "does not fit" is never reported for
 *  it — at tray level the footprint constrains, height does not. */
export function isProud(p, productStandingH = 0){
  return p.floor + productStandingH > p.overallH + 1e-9;
}

/**
 * Inverse path: a product spec -> a fully-derived tray parameter set.
 * Layouts are 1×N (a count distributed along one axis), so there is no 2D
 * row×col factoring here — unlike the pallet solve.
 *
 * The returned params are validated by trayParams(), so a spec that implies
 * an impossible tray (e.g. a cellH too shallow for the cradle it asks for)
 * throws here rather than silently growing the tray past what was requested.
 *
 * @param {Object} spec
 * @param {number} spec.qtyTotal            total products to hold
 * @param {'round'|'rectangle'} [spec.productType='round']
 * @param {number} [spec.cookieDiameter]    round: across the cell
 * @param {number} [spec.cookieThickness]   round: pitch along the channel
 * @param {number} [spec.productWidth]      rectangle: across the cell
 * @param {number} [spec.productHeight]     rectangle: vertical (unused by the tray solid)
 * @param {number} [spec.productThickness]  rectangle: pitch along the channel
 * @param {number} [spec.nCells]            supply exactly ONE of nCells...
 * @param {number} [spec.perCell]           ...or perCell
 * @param {number} [spec.sideClearance=1.5] each side, across the cell
 * @param {number} [spec.endClearance=3]    total, along the channel
 * @param {number} [spec.cradleClearance=0]
 * @param {number} [spec.cellH=28]          trough depth; independent of product size
 *   plus any pass-through TRAY_DEFAULTS input (wall, floor, cornerR, ...).
 * @returns {Readonly<Object>} same shape as trayParams()
 */
/**
 * THE pitch one product occupies along a tray channel. Products sit
 * nose-to-tail in the cradle, so the pitch is the product's own thickness:
 * a round product's `thickness`, a box's L — the axis cookietraylink exports
 * as Cookie-Tray's `productThickness`. ONE definition, so the dimension used
 * to SIZE a cell is provably the dimension the exported link carries.
 */
export const packPitchOf = piece => piece.kind === 'cylinder' ? piece.thickness : piece.L;

/**
 * THE cell-length rule: `perCell` products nose-to-tail at their own pitch,
 * plus ONE end clearance total along the channel (not one per end).
 *
 * Cookie-Tray's rule, and now the only one. The app used to size the cell
 * from the COLLATION's envelope instead (its product run, `env.L + endC`) —
 * a second derivation with a different convention: the collation run carries
 * the collation's own inter-piece `pieceGap`, while this rule has products
 * touching. A gapped collation therefore built a cell (perCell-1)*pieceGap
 * longer than the tray its own exported link rebuilds, a divergence that
 * GROWS with the count. Everything that needs a cell length calls this.
 */
export const cellLengthFor = (perCell, packPitch, endClearance) => perCell*packPitch + endClearance;

export function deriveTrayParams(spec){
  const s = {productType: 'round', sideClearance: 1.5, endClearance: 3,
             cradleClearance: 0, cellH: 28, ...spec};

  if(s.productType !== 'round' && s.productType !== 'rectangle')
    throw new Error(`productType must be "round" or "rectangle", got ${JSON.stringify(s.productType)}`);
  // exactly one of the two count controls — both or neither is ambiguous
  if((s.nCells == null) === (s.perCell == null))
    throw new Error('Supply exactly one of nCells or perCell, not both/neither.');
  if(!(s.qtyTotal >= 1)) throw new Error(`qtyTotal must be >= 1, got ${s.qtyTotal}`);
  if(s.productType === 'round'){
    if(s.cookieDiameter == null || s.cookieThickness == null)
      throw new Error('round productType requires cookieDiameter and cookieThickness');
    if(!(s.cookieDiameter > 0) || !(s.cookieThickness > 0))
      throw new Error('cookieDiameter and cookieThickness must be > 0');
  }else{
    if(s.productWidth == null || s.productHeight == null || s.productThickness == null)
      throw new Error('rectangle productType requires productWidth, productHeight, and productThickness');
    if(!(s.productWidth > 0) || !(s.productHeight > 0) || !(s.productThickness > 0))
      throw new Error('productWidth, productHeight, and productThickness must be > 0');
  }
  if(!(s.cellH > 0)) throw new Error(`cellH must be > 0, got ${s.cellH}`);

  // the ONE round/rectangle branch point — both shape rules live here so a
  // second call site can never let them drift
  const rect = s.productType === 'rectangle';
  const cellWid   = (rect ? s.productWidth : s.cookieDiameter) + 2*s.sideClearance;
  const packPitch =  rect ? s.productThickness : s.cookieThickness;
  // a rectangle has no natural radius to hug, so it gets a modest fixed
  // rounded bottom instead of the round product's full half-width cradle
  const maxCradleR = cellWid/2;
  const cradleR = Math.min(Math.max((rect ? 5 : cellWid/2) - s.cradleClearance, 1e-6), maxCradleR);

  const perCell = s.perCell != null ? s.perCell : Math.ceil(s.qtyTotal/s.nCells);
  const nCells  = s.perCell != null ? Math.ceil(s.qtyTotal/s.perCell) : s.nCells;

  // pass through every §3 input the spec may carry, then override what the
  // product actually determines
  const passThrough = {};
  for(const k of Object.keys(TRAY_DEFAULTS)) if(s[k] !== undefined) passThrough[k] = s[k];

  return trayParams({
    ...passThrough,
    nCells,
    cellLen: cellLengthFor(perCell, packPitch, s.endClearance),
    cellWid,
    cellH: s.cellH,
    cradleR
  });
}
