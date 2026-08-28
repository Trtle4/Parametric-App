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
  // Cookie-Tray's own column split. This port's layout is 1×N (a single row
  // of `nCells` cradles along one channel — see deriveTrayParams's own doc),
  // so nCols has NO geometric effect here: it rides through trayParams()'s
  // spread untouched (same shape as flangeT, validated/tracked upstream but
  // not consumed by any of this port's derived dimensions) purely so a
  // Cookie-Tray link round-trips losslessly instead of silently resetting
  // this field to their default. Building real 2D row x column trays is a
  // separate, larger feature this does not attempt.
  nCols: 1,
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
  nozzle: 0.42,
  // The 2D GRID. null = the legacy 1×N layout (one row, built from nCells/
  // cellLen/cellWid/cellH/cradleR above) — every existing caller stays on
  // this path, bit-identical, until it opts in. A non-empty array puts N
  // independent ROWS side by side across the tray's width, each its own
  // channel of cells running the long axis; a row may set its own nCells/
  // cellLen/cellWid/cellH/cradleR (all optional — a key a row omits falls
  // back to the top-level field above, the same auto-with-override idiom
  // the rest of this module already uses). This is what makes the grid
  // ASYMMETRIC: rows can differ in cell count AND cell size, not just count.
  // Rows stack along W, separated by the SAME `divider` value used between
  // cells within a row — one "wall between two cells" constant either way,
  // not a second, independently-driftable one for the row direction.
  rows: null
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
  if(p.divider == null) p.divider = p.wall;

  // ---- guards, in the upstream's own order (later guards read values the
  //      earlier clamps may have changed, so the order is load-bearing) ----
  if(p.longAxis !== 'X' && p.longAxis !== 'Y')
    throw new Error(`longAxis must be "X" or "Y", got ${JSON.stringify(p.longAxis)}`);
  if(p.wall < MIN_WALL) throw new Error(`wall (${p.wall}) must be >= ${MIN_WALL}mm`);
  if(!(p.floor > 0)) throw new Error('floor must be > 0');
  // negative draft has no physical meaning; "no draft" is always valid
  if(p.draftDeg < 0){ warnings.push('draftDeg is negative; clamped to 0 (no draft).'); p.draftDeg = 0; }
  if(p.divider < MIN_DIVIDER) throw new Error(`divider (${p.divider}) must be >= ${MIN_DIVIDER}mm`);

  // ---- ROWS: the 2D grid. An absent/empty `rows` input reproduces the
  // legacy 1×N tray as ONE row built from the top-level fields — there is
  // no separate single-row code path to drift from this one; every tray
  // this module has ever produced is the nRows===1 case of the same walk.
  // Each row may override nCells/cellLen/cellWid/cellH/cradleR; an absent
  // key falls back to the top-level field (the auto-with-override idiom
  // this module already uses for cradleR/divider above).
  const rawRows = Array.isArray(p.rows) && p.rows.length
    ? p.rows
    : [{nCells: p.nCells, cellLen: p.cellLen, cellWid: p.cellWid, cellH: p.cellH, cradleR: p.cradleR}];

  const rows = rawRows.map((r, i) => {
    const row = {
      nCells: r.nCells != null ? r.nCells : p.nCells,
      cellLen: r.cellLen != null ? r.cellLen : p.cellLen,
      cellWid: r.cellWid != null ? r.cellWid : p.cellWid,
      cellH: r.cellH != null ? r.cellH : p.cellH,
      cradleR: r.cradleR != null ? r.cradleR : p.cradleR
    };
    if(!(row.nCells >= 1)) throw new Error(`row ${i}: nCells must be >= 1, got ${row.nCells}`);
    if(row.cradleR == null) row.cradleR = row.cellWid/2;

    // 1: cradle radius can never exceed the half-width it has to sit in
    const maxCradleR = row.cellWid/2;
    if(row.cradleR > maxCradleR){
      warnings.push(`row ${i}: cradleR=${row.cradleR} exceeds cellWid/2=${maxCradleR}; clamping.`);
      row.cradleR = maxCradleR;
    }
    if(!(row.cradleR > 0)) throw new Error(`row ${i}: cradleR must be > 0, got ${row.cradleR}`);

    // 2: the rounded bottom cannot complete in a trough shallower than its radius
    if(row.cellH < row.cradleR)
      throw new Error(`row ${i}: cellH (${row.cellH}) must be >= cradleR (${row.cradleR}); the ` +
                      `rounded bottom cannot complete otherwise. Increase cellH or decrease cradleR.`);

    row.pitch = row.cellWid + p.divider;   // centre-to-centre WITHIN this row
    // this row's OWN total Z-extent: its nCells channels plus the
    // (nCells-1) dividers BETWEEN them — the single-row topW formula,
    // generalized to one row instead of the whole tray. tray3d.js/tray2d.js
    // place rows back to back using exactly this span, so the geometry and
    // this derivation can never disagree about how wide a row is.
    row.span = row.nCells*row.cellWid + (row.nCells - 1)*p.divider;
    return Object.freeze(row);
  });
  const nRows = rows.length;

  // ---- derived (upstream spec §3 "Derived") ----
  const lipT  = 3*p.nozzle;
  // the tray's own length must hold the LONGEST row's run; shorter rows sit
  // centred in that same length (see tray2d.js/tray3d.js row placement)
  const topL  = Math.max(...rows.map(r => r.cellLen)) + 2*p.wall;
  // outer walls both sides are `wall`; a row-to-row wall is `divider` too —
  // each row already counts its OWN internal channel dividers in `span`, so
  // only the (nRows-1) dividers BETWEEN rows are added here.
  const topW  = rows.reduce((s, r) => s + r.span, 0) + 2*p.wall + (nRows - 1)*p.divider;
  // the tray's own depth follows the DEEPEST row's trough — a shallower row
  // just leaves headroom under its own rim, the same "footprint constrains,
  // height does not" rule the tray already applies to its contents
  const H     = p.floor + Math.max(...rows.map(r => r.cellH));

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

  // 5: purely geometric validity — clamped silently upstream, so silent here.
  // Bounded by the SMALLEST cell in play, so the fillet stays valid on every row.
  const maxSafeFillet = Math.max(0, Math.min(...rows.map(r => Math.min(r.cellWid, r.cellLen)))/2 - 0.01);
  if(p.cellFillet > maxSafeFillet) p.cellFillet = maxSafeFillet;

  // 6-8: remaining hard guards
  if(!(p.lipH > 0))    throw new Error(`lipH (${p.lipH}) must be > 0`);
  if(!(p.flangeT > 0)) throw new Error(`flangeT (${p.flangeT}) must be > 0`);
  if(p.nozzle < 0)     throw new Error(`nozzle (${p.nozzle}) must be >= 0`);
  if(p.cellFillet < 0) throw new Error(`cellFillet (${p.cellFillet}) must be >= 0`);

  const outerL = topL + 2*p.stripL;
  const outerW = topW + 2*p.stripW;

  return Object.freeze({
    ...p,
    rows, nRows,
    // SINGLE-ROW MIRRORS: when nRows===1 these equal that one row's own
    // resolved values, exactly as trayParams() has always returned — every
    // pre-grid consumer (tray2d.js, the rail readout, cookietraylink) keeps
    // reading these unchanged. Once nRows>1 they are row[0]'s values only;
    // a row-aware consumer must read `rows` instead — never both, in the
    // same view, for the same fact.
    nCells: rows.reduce((s, r) => s + r.nCells, 0),
    cellLen: rows[0].cellLen, cellWid: rows[0].cellWid, cellH: rows[0].cellH,
    cradleR: rows[0].cradleR, pitch: rows[0].pitch,
    lipT, topL, topW, H,
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
 * Inverse path: a product spec -> a fully-derived tray parameter set for ONE
 * row (a count distributed along one axis). A multi-row grid is assembled a
 * layer up (project.js's trayAutoCells), by calling this once per row and
 * handing trayParams() the resulting `rows` array — this function itself
 * stays a single-row primitive so there is exactly one place that derives
 * "how big does a row have to be for N of this product," never a second one
 * duplicated per row.
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
 * THE pitch one product occupies along a tray channel — the axis
 * cookietraylink exports as Cookie-Tray's `productThickness`/`cookieThickness`.
 * ONE definition, so the dimension used to SIZE a cell is provably the
 * dimension the exported link carries.
 *
 * Orientation-dependent for a round product, and only for a round product:
 *   - on-edge (default; matches every tray built before this parameter
 *     existed) — the cylinder lies on its curved edge, rolled up the channel
 *     like a stack of poker chips, so it pitches by its own `thickness`.
 *   - flat — the cylinder stands axis-vertical (a puck on a table) and sits
 *     side by side along the channel instead, so it pitches by its own
 *     `diameter`. collate() already builds this envelope correctly for a
 *     'flat' cylinder (see resolvePieceOrientation); this is the other half
 *     of the same fact reaching the tray's own cell-length derivation, which
 *     used to assume on-edge unconditionally.
 * A box has no such choice: nose-to-tail is always along its own L,
 * regardless of pieceOrientation (which only ever swaps the box's W/H — see
 * collation.js boxDims — never its L).
 * @param {import('./shape.js').Piece} piece
 * @param {'flat'|'on-edge'} [orientation='on-edge']
 */
export const packPitchOf = (piece, orientation = 'on-edge') =>
  piece.kind !== 'cylinder' ? piece.L
  : orientation === 'flat' ? piece.diameter
  : piece.thickness;

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
