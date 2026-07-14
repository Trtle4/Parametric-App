/**
 * The project model: the packaging hierarchy. A Level is one tier (carton,
 * case); a Link records that a parent level is driven by — or locked
 * against — its child. This module runs the full chain:
 *
 *   carton outer -> arrangement + clearance -> case cavity -> case outer -> pallet fit
 *
 * DOM-free, THREE-free, mm-only. The pallet's physical height (timber) is
 * passed in via PalletConfig.baseH so this module knows nothing about decks.
 */
import {fitInto, parentCandidates, solveParent} from './containment.js';
import {styleById} from './styles/index.js';
import {collate, orientationLabel} from './collation.js';

/**
 * @typedef {import('./containment.js').Orientation} Orientation
 * @typedef {import('./containment.js').Clearance} Clearance
 *
 * @typedef {Object} Level
 * @property {string} styleId
 * @property {Object} params                       // style params, mm
 * @property {Orientation[]} allowedOrientations   // how THIS level may sit inside its parent
 * @property {Clearance} clearance                 // how much room THIS level needs inside its parent
 * @property {Object} [geometry]                   // derived, cached
 *
 * @typedef {Object} PalletConfig
 * @property {number} L @property {number} W      // deck, mm
 * @property {number} maxH                         // total height budget incl. base, mm
 * @property {number} baseH                        // deck assembly height, mm
 * @property {'optimal'|'column'|'interlock'} pattern
 *
 * @typedef {Object} Link
 * @property {'tertiary'} parent
 * @property {'secondary'} child
 * @property {number} count                        // children per parent
 * @property {'auto'|{nx:number,ny:number,nz:number}} arrangement
 * @property {boolean} locked                      // true: parent dims fixed, child only checked
 *
 * @typedef {Object} Project
 * @property {Level|null} secondary                // the carton
 * @property {Level|null} tertiary                 // the case
 * @property {PalletConfig} pallet
 * @property {Link[]} links
 */

/** Rounding steps for solved cavity dimensions (mm). */
export const ROUNDING = {'1mm': 1, '5mm': 5, '1/16in': 25.4/16};

/** Round a cavity up to the step, per axis. The epsilon absorbs FP residue
 *  so 407.0000000000001 rounds to 407, not 408. */
export function roundCavityUp(cavity, step){
  const r = v => Math.ceil((v - 1e-9)/step)*step;
  return {L: r(cavity.L), W: r(cavity.W), H: r(cavity.H)};
}

/** Default params for a style, from its registry descriptors. */
export function styleDefaults(styleId){
  const out = {};
  for(const d of styleById(styleId).params) out[d.key] = d.default;
  return out;
}

/** Default style-VIEW options (e.g. fefco201's outerFlaps) for a style — the
 *  fold-only cosmetic choices that consume no chain math. Stored on the level
 *  so they are part of the project (and the save file), never an orphaned
 *  Path-A value. */
export function styleOptionDefaults(styleId){
  const out = {};
  for(const d of (styleById(styleId).options || [])) out[d.key] = d.default;
  return out;
}

/** A fresh project: collated product driving a carton driving a case, on a
 *  GMA pallet. `primary: null` reverts to the carton-driven chain. */
export function newProject(){
  return {
    primary: {
      collation: {
        piece: {kind: 'box', L: 90, W: 50, H: 20},
        perStack: 6, stackAxis: 'Z', nx: 1, ny: 1, stackGap: 0, pieceGap: 0
      },
      // the flow wrap around the collation. null = bare envelope (legacy).
      // Seal values are editable defaults, not conventions.
      wrap: {
        styleId: 'flowwrap',
        // L/W/H here are the REMEMBERED locked-content dims (used only when
        // locked: true) — defaulted to match this default collation's own
        // envelope so the field has a sane starting value the moment the
        // lock checkbox is turned on, instead of reading back `undefined`.
        params: {sealType: 'fin', finHeight: 8, finSealBand: 5, finTreatment: 'folded', finFace: 'back',
                 lapOverlap: 12, endSealWidth: 10, endSealBleed: 3,
                 girthBasis: 'rectangular', roundDiameter: 0, gauge: 30, density: 0.92,
                 L: 90, W: 50, H: 120},
        // which collation axis is the machine (repeat) direction through a
        // HORIZONTAL flow wrapper — never H (vertical is never the travel
        // axis on this machine class; a genuinely vertical feed is a
        // different machine, VFFS, a different style). 'auto' resolves to
        // whichever of L/W is longer, ties to L — see resolveWrapAxis.
        wrapAxis: 'auto',
        options: styleOptionDefaults('flowwrap'),   // fold-only cosmetics (none today)
        locked: false
      },
      // H up, rotation allowed: product is often orientation-free in plan,
      // but which face is UP stays a hard user constraint (verticalToOrientations)
      allowedOrientations: ['LWH', 'WLH'],
      // product-in-carton allowances: 0/0/0 are review-me placeholders, not
      // conventions. top is HEADSPACE — a design decision, exposed in Build.
      clearance: {wall: 0, between: 0, bottom: 0, top: 0, betweenZ: 0}
    },
    secondary: {
      styleId: 'a6120',
      params: styleDefaults('a6120'),                // L/W/H overwritten when solved from the collation
      options: styleOptionDefaults('a6120'),         // fold-only cosmetics (none today)
      allowedOrientations: ['LWH', 'WLH'],           // upright; set deliberately in Build
      // wall/between are the review-me defaults; vertical is explicitly
      // non-uniform: cartons bear on the case floor (bottom 0), headspace
      // (top) is a first-class Build input, layers stack directly (betweenZ 0)
      clearance: {wall: 1.5, between: 0, bottom: 0, top: 0, betweenZ: 0}
    },
    tertiary: {
      styleId: 'fefco201',
      params: {...styleDefaults('fefco201')},        // L/W/H overwritten when solved
      options: styleOptionDefaults('fefco201'),      // {outerFlaps:'L'} — the 3D-fold major-panel choice
      allowedOrientations: ['LWH', 'WLH'],           // cases upright on the pallet
      clearance: {wall: 0, between: 0}
    },
    pallet: {L: 48*25.4, W: 40*25.4, maxH: 60*25.4, baseH: 127, pattern: 'optimal'},
    // free print text on the package's print panel — lives in the model (and
    // the save file) even though its input control is hidden from the UI, so
    // it is never an orphaned, unsaveable Path-A value again.
    printText: 'FRAGILE',
    links: [
      {parent: 'tertiary', child: 'secondary', count: 12, arrangement: 'auto', locked: false},
      {parent: 'secondary', child: 'primary', count: 1, arrangement: 'auto', locked: false}
    ]
  };
}

export const linkFor = (project, parent) => project.links.find(l => l.parent === parent);

/**
 * Resolve user intent — "which child axis points up" + "may the solver
 * rotate it in plan" — into the orientation set containment consumes.
 * Which face is up is a HARD CONSTRAINT (print, product settle, closure),
 * never an optimization variable; in-plan rotation is the only freedom the
 * solver may be granted, and only explicitly.
 * @param {'H'|'L'|'W'} verticalAxis  child dimension that points up
 * @param {boolean} mayRotate         solver may turn the child 90° in plan
 */
export function verticalToOrientations(verticalAxis, mayRotate){
  const pairs = {H: ['LWH', 'WLH'], L: ['WHL', 'HWL'], W: ['LHW', 'HLW']};
  const pair = pairs[verticalAxis];
  if(!pair) throw new Error(`unknown vertical axis "${verticalAxis}"`);
  return mayRotate ? [...pair] : [pair[0]];
}

/** Plain-language labels for the vertical-axis choice, code alongside. */
export const VERTICAL_CHOICES = [
  {axis: 'H', label: 'H up — upright, as designed', codes: 'LWH·WLH'},
  {axis: 'L', label: 'L up — on end',               codes: 'WHL·HWL'},
  {axis: 'W', label: 'W up — on side',              codes: 'LHW·HLW'}
];

/** Nouns for each tier, keyed by the tier name used in Link.parent/child.
 *  Every child-count / arrangement control label is DERIVED from this map
 *  plus the actual Link objects — never a hardcoded "Cartons/case" string
 *  disconnected from the chain. */
export const TIER_NOUN = {primary: 'wrap', secondary: 'carton', tertiary: 'case'};

/**
 * Which collation axis ('L'|'W') is the machine direction through a
 * horizontal flow wrapper. H is never eligible: the collation's Z axis is
 * vertical by construction (stackAxis: 'Z' stacks upward), and a horizontal
 * wrapper's travel axis can never be the vertical one — a product that
 * genuinely feeds vertically belongs to a different machine (VFFS), not
 * this style. 'auto' resolves to whichever of L/W is longer (ties to L),
 * which is exactly the axis a stacked collation (long axis in H) still
 * wraps along, and exactly the axis an in-line-on-edge collation (long
 * axis already in L) wraps along — "longest overall axis" would get the
 * first of those wrong, since it would pick H.
 * @param {{L:number,W:number,H:number}} envelope
 * @param {'auto'|'L'|'W'} wrapAxis
 * @returns {'L'|'W'}
 */
export function resolveWrapAxis(envelope, wrapAxis){
  if(wrapAxis === 'L' || wrapAxis === 'W') return wrapAxis;
  return envelope.W > envelope.L ? 'W' : 'L';
}

/** Swap L and W (never touches H) — the permutation between the collation's
 *  true envelope frame and the wrap style's own L/W/H, where L always means
 *  "pack length". Its own inverse: applying it twice is the identity, so
 *  the same function un-permutes wrapGeo's inner/outer back to true axes. */
export function swapLW(dims, axis){
  return axis === 'W' ? {L: dims.W, W: dims.L, H: dims.H} : dims;
}

/**
 * Round girth (π·d) is only physically meaningful for a single cylindrical
 * slug wrapped along its OWN axis: one stack, 1×1, with the collation's
 * stack axis aligned to the resolved wrapAxis — the only geometry whose
 * wrap path is actually a circle. Any other collation (or a slug wrapped
 * across its axis instead of along it) makes "round" report a fabricated
 * film-area number. The Build UI uses this same predicate to grey out the
 * option and to detect a stale selection, so the two can never silently
 * disagree.
 * @param {'L'|'W'} wrapAxis  the RESOLVED axis (see resolveWrapAxis), not the raw setting
 */
export function roundGirthEligible(collation, wrapAxis){
  const requiredStackAxis = wrapAxis === 'W' ? 'Y' : 'X';
  return collation.piece.kind === 'cylinder' && collation.nx === 1 && collation.ny === 1
    && collation.stackAxis === requiredStackAxis;
}

/* ---------------- candidate enumeration + full-chain metrics ------------ */

// keep only irreducible grids: capacity >= count and no axis removable
function irreducible(c, count){
  const cap = (a, b, d) => a*b*d >= count;
  if(!cap(c.nx, c.ny, c.layers)) return false;
  if(c.nx > 1 && cap(c.nx - 1, c.ny, c.layers)) return false;
  if(c.ny > 1 && cap(c.nx, c.ny - 1, c.layers)) return false;
  if(c.layers > 1 && cap(c.nx, c.ny, c.layers - 1)) return false;
  return true;
}

/**
 * Run every candidate case arrangement through the full chain and return
 * the comparison rows. Never collapses to one winner — ranking and choice
 * belong to the engineer.
 * @param {Project} project
 * @param {string} rounding  key of ROUNDING
 * @returns {Object[]} rows (see fields below), enumeration order
 */
/**
 * Resolve the carton variants that feed the case stage. Without a primary
 * level there is exactly one (the carton as configured). With one, the
 * collation envelope drives — or is checked against — the carton, once per
 * allowed primary orientation. Solved cavities use solveParent's volume
 * objective (the case stage is where enumeration + ranking happen).
 */
function cartonVariants(project, step){
  const sec = project.secondary;
  if(!project.primary){
    const geo = styleById(sec.styleId).geometry(sec.params);
    return [{params: sec.params, geo, orientation: null, label: null, piecesPerCarton: null, fits: true}];
  }
  const prim = project.primary;
  const link = linkFor(project, 'secondary');   // parent='secondary'(carton), child='primary'(wrap) — the SAME uniform Link shape every other level uses
  const col = collate(prim.collation);

  // the wrap (if any) sits between the collation and the carton: it takes
  // the envelope as content and hands up its seal-compensated outer
  let wrapGeo = null, wrapFits = true, wp = null, wrapAxis = null;
  if(prim.wrap){
    wp = {...prim.wrap.params};
    // resolve which collation axis is the machine direction BEFORE calling
    // the style, so flowwrap.js never has to know about the permutation —
    // it stays a pure function of whatever L/W/H it's handed, always
    // treating L as pack length. The permutation (and its inverse on the
    // way back out) live here, not in the style.
    wrapAxis = resolveWrapAxis(col.envelope, prim.wrap.wrapAxis || 'auto');
    const permEnv = swapLW(col.envelope, wrapAxis);
    // round girth basis is only meaningful for a single cylindrical slug
    // wrapped along its own axis — roundGirthEligible is the SAME predicate
    // the Build UI checks, so the two can never silently disagree.
    if(wp.girthBasis === 'round'){
      if(roundGirthEligible(prim.collation, wrapAxis)) wp.roundDiameter = prim.collation.piece.diameter;
      else wp.girthBasis = 'rectangular';
    }
    if(prim.wrap.locked){
      // locked wrap: content dims are user-fixed (in machine-direction
      // terms); check the permuted envelope fits
      wrapFits = permEnv.L <= wp.L && permEnv.W <= wp.W && permEnv.H <= wp.H;
    }else{
      wp.L = permEnv.L; wp.W = permEnv.W; wp.H = permEnv.H;
    }
    const raw = styleById(prim.wrap.styleId).geometry(wp);
    // un-permute back to true envelope axes: everything downstream (carton
    // sizing, display, the renderer's non-shape math) works in true L/W/H
    // and knows nothing about the machine-direction permutation.
    wrapGeo = {...raw, inner: swapLW(raw.inner, wrapAxis), outer: swapLW(raw.outer, wrapAxis)};
  }
  const content = wrapGeo ? wrapGeo.outer : col.envelope;

  // ONE variant: the vertical axis is user-locked and the orientation set
  // already encodes whether in-plan rotation is allowed — the solver picks
  // within that set only, never across vertical axes
  const child = {outer: content, allowedOrientations: prim.allowedOrientations};
  let params, fits = true, capacity = null, chosen, wrapsArrangement, requestedUnits;
  if(link.locked){
    params = sec.params;                                        // user-fixed carton
    const chk = fitInto(child, {L: params.L, W: params.W, H: params.H}, prim.clearance, 'column');
    capacity = chk.total; fits = chk.total >= link.count;
    chosen = chk.placements[0] ? chk.placements[0].orientation : prim.allowedOrientations[0];
    wrapsArrangement = chk;
    requestedUnits = link.count;
  }else if(link.arrangement === 'auto'){
    const solved = solveParent(child, link.count, prim.clearance);
    const cavity = roundCavityUp(solved.cavity, step);
    params = {...sec.params, L: cavity.L, W: cavity.W, H: cavity.H};
    chosen = solved.arrangement.placements[0]
      ? solved.arrangement.placements[0].orientation : prim.allowedOrientations[0];
    wrapsArrangement = solved.arrangement;
    requestedUnits = link.count;
  }else{
    // explicit nx×ny×nz: identical pattern to the case level's explicit
    // arrangement (candidateCases below) — take the exact-grid candidate
    // cavity, round it, then build the REAL Arrangement inside it via
    // fitInto. No enumeration/ranking here (still one variant), just an
    // exact layout instead of the solver's best-scored one.
    const {nx, ny, nz} = link.arrangement;
    requestedUnits = nx*ny*nz;
    const cands = parentCandidates(child, requestedUnits, prim.clearance, {layers: nz})
      .filter(c => c.nx === nx && c.ny === ny);
    if(cands.length === 0){
      // the typed grid isn't reachable for this child/orientation set —
      // surface it as a mismatch rather than silently guessing a carton size
      params = sec.params;
      fits = false; capacity = 0;
      chosen = prim.allowedOrientations[0];
      wrapsArrangement = {placements: [], total: 0};
    }else{
      const cavity = roundCavityUp(cands[0].cavity, step);
      params = {...sec.params, L: cavity.L, W: cavity.W, H: cavity.H};
      const fit = fitInto(child, cavity, prim.clearance, 'column');
      chosen = fit.placements[0] ? fit.placements[0].orientation : prim.allowedOrientations[0];
      wrapsArrangement = fit;
      fits = fit.total >= requestedUnits; capacity = fit.total;
    }
  }

  // pieces/carton depends only on how many collation UNITS sit in the
  // carton — true whether or not those units are wrapped in film.
  // wrapsPerCarton (the "wrap" noun) is meaningful only when a wrap style
  // is actually configured; it feeds film-mass math, which is itself
  // skipped downstream whenever wrapGeo is null.
  const piecesPerCarton = col.count*requestedUnits;
  const wrapsPerCarton = prim.wrap ? requestedUnits : null;

  return [{
    params, geo: styleById(sec.styleId).geometry(params),
    orientation: chosen, label: orientationLabel(prim.collation.stackAxis, chosen),
    piecesPerCarton, fits: fits && wrapFits, capacity,
    wrapGeo, wrapFits, wrapsPerCarton,
    // SINGLE SOURCE OF TRUTH: the arrangements this solve produced, retained
    // so the hierarchy view reads them instead of re-solving.
    wrapsArr: prim.wrap ? {placements: wrapsArrangement.placements, count: wrapsArrangement.total} : null,
    pieces: prim.wrap ? {placements: col.placements, envelope: col.envelope,
                         piece: prim.collation.piece, stackAxis: prim.collation.stackAxis,
                         nx: prim.collation.nx, ny: prim.collation.ny, wrapAxis,
                         seals: {sealType: wp.sealType, finTreatment: wp.finTreatment,
                                 finHeight: wp.finHeight, finSealBand: wp.finSealBand,
                                 endSealWidth: wp.endSealWidth, finFace: wp.finFace || 'back',
                                 gauge: wp.gauge}} : null
  }];
}

export function candidateCases(project, rounding = '1mm'){
  const link = linkFor(project, 'tertiary');
  const sec = project.secondary, ter = project.tertiary;
  const step = ROUNDING[rounding] || 1;
  const rows = [];

  for(const variant of cartonVariants(project, step)){
    const child = {outer: variant.geo.outer, allowedOrientations: sec.allowedOrientations};
    const cartonVol = variant.geo.outer.L*variant.geo.outer.W*variant.geo.outer.H;

    let cands;
    if(link.arrangement === 'auto'){
      cands = parentCandidates(child, link.count, sec.clearance).filter(c => irreducible(c, link.count));
    }else{
      const {nx, ny, nz} = link.arrangement;
      cands = parentCandidates(child, nx*ny*nz, sec.clearance, {layers: nz})
        .filter(c => c.nx === nx && c.ny === ny);
    }

    for(const c of cands){
      const cavity = roundCavityUp(c.cavity, step);
      const caseParams = {...ter.params, L: cavity.L, W: cavity.W, H: cavity.H};
      const caseGeo = styleById(ter.styleId).geometry(caseParams);
      const row = chainMetrics(project, c, cavity, caseParams, caseGeo, cartonVol, link.count);
      const cartonsFit = fitCartonsInCase(project, variant.geo, cavity, c.o);
      rows.push(decorateRow(row, project, variant, caseGeo, row.casesFit, cartonsFit));
    }
  }
  return rows;
}

/** Locked direction: the case dims are fixed; check the carton against them.
 *  With a primary level, the carton itself is first derived from (or checked
 *  against) the collation using the FIRST allowed primary orientation. */
export function checkLockedCase(project, rounding = '1mm'){
  const link = linkFor(project, 'tertiary');
  const sec = project.secondary, ter = project.tertiary;
  const step = ROUNDING[rounding] || 1;
  const variant = cartonVariants(project, step)[0];
  const cavity = {L: ter.params.L, W: ter.params.W, H: ter.params.H};
  const cartonsFit = fitCartonsInCase(project, variant.geo, cavity, variant.orientation);
  const caseGeo = styleById(ter.styleId).geometry(ter.params);
  const cartonVol = variant.geo.outer.L*variant.geo.outer.W*variant.geo.outer.H;
  const cand = {nx: '—', ny: '—', layers: cartonsFit.layers,
                o: cartonsFit.placements[0] ? cartonsFit.placements[0].orientation : '—'};
  const row = chainMetrics(project, cand, cavity, ter.params, caseGeo, cartonVol, link.count);
  row.capacity = cartonsFit.total;
  row.fits = cartonsFit.total >= link.count && variant.fits;
  row.arrangementLabel = `locked (${cartonsFit.label})`;
  return decorateRow(row, project, variant, caseGeo, row.casesFit, cartonsFit);
}

/**
 * Resolve the ONE candidate row every view should render — locked case uses
 * checkLockedCase (a single row), otherwise the enumerated candidate matching
 * `selectedKey` (nx/ny/nz/orientation), falling back to the freight-optimal
 * row (max cartons/pallet). This is the single row hierarchyBundle, the 2D
 * dieline, the 3D fold, the DXF export, and every readout all read from — so
 * they can never show different geometry for the same level (the Path-A bug).
 * @returns {Object|null} a decorated candidate row, or null if nothing fits
 */
export function resolveActiveRow(project, rounding = '1mm', selectedKey = null){
  const caseLink = linkFor(project, 'tertiary');
  if(caseLink.locked) return checkLockedCase(project, rounding);
  const rows = candidateCases(project, rounding);
  if(rows.length === 0) return null;
  if(selectedKey){
    const m = rows.find(r => r.nx === selectedKey.nx && r.ny === selectedKey.ny &&
      r.nz === selectedKey.nz && r.orientation === selectedKey.orientation);
    if(m) return m;
  }
  return rows.reduce((a, b) => (b.cartonsPerPallet > (a ? a.cartonsPerPallet : -1) ? b : a), null);
}

/**
 * The resolved Geometry for a single level ('wrap'|'carton'|'case'), read off
 * the active row's retained `geo` — the SAME object the 3D hierarchy renders.
 * Returns null when the level has no geometry (e.g. 'wrap' with no wrap
 * configured, or nothing fits). This is the seam that makes the 2D dieline,
 * the 3D fold, and the DXF export provably identical: they all call this.
 */
export function levelGeometry(project, level, rounding = '1mm', selectedKey = null){
  const row = resolveActiveRow(project, rounding, selectedKey);
  return row && row.geo ? (row.geo[level] || null) : null;
}

/* ---------------- single-source-of-truth row decoration -----------------
 * The chain retains the Arrangement it solves at each link, ON THE ROW.
 * The Build table reads the row's counts; the 3D hierarchy reads the row's
 * stored placements. Nothing downstream re-solves — one computation, one
 * truth. (Fixes the old split where nestArrangement/wrapsInCarton/... each
 * re-solved and could diverge, and where nestArrangement fit the UNSOLVED
 * carton — see git history / the report.)
 */

/** Cartons fitted into a case cavity, in the candidate's carton orientation
 *  (cand.o, the orientation that sized the cavity). */
function fitCartonsInCase(project, cartonGeo, cavity, cartonOrientation){
  const child = {
    outer: cartonGeo.outer,
    allowedOrientations: typeof cartonOrientation === 'string' && cartonOrientation.length === 3
      ? [cartonOrientation] : project.secondary.allowedOrientations
  };
  return fitInto(child, cavity, project.secondary.clearance, 'column');
}

/** Attach every derived field + the retained arrangements to a metrics row. */
function decorateRow(row, project, variant, caseGeo, casesFit, cartonsFit){
  row.cartonParams = variant.params;
  row.cartonOuter = variant.geo.outer;
  row.primaryOrientation = variant.orientation;
  row.primaryLabel = variant.label;
  row.primaryFits = variant.fits;
  row.piecesPerCarton = variant.piecesPerCarton;
  row.piecesPerPallet = variant.piecesPerCarton !== null ? variant.piecesPerCarton*row.cartonsPerPallet : null;
  if(variant.wrapGeo){
    // film cost columns — board vs film trade against each other. film
    // numbers and fillEfficiency NEVER touch cube utilization.
    const film = variant.wrapGeo.meta.film;
    row.filmAreaM2 = film.filmAreaM2;
    row.filmKgPerPallet = (film.massPer1000g/1000)*variant.wrapsPerCarton*row.cartonsPerPallet/1000;
    row.wrapOuter = variant.wrapGeo.outer;
  }else{
    row.filmAreaM2 = null; row.filmKgPerPallet = null; row.wrapOuter = null;
  }
  // retained arrangements (single source of truth; the view reads these)
  const p = project.pallet;
  row.geo = {case: caseGeo, carton: variant.geo, wrap: variant.wrapGeo};
  row.arr = {
    cases:   {placements: casesFit.placements, count: casesFit.total, deck: {L: p.L, W: p.W, baseH: p.baseH}},
    cartons: {placements: cartonsFit.placements, count: cartonsFit.total},
    wraps:   variant.wrapsArr,     // {placements, count} | null
    pieces:  variant.pieces        // {placements, envelope, piece, stackAxis, seals} | null
  };
  return row;
}

function chainMetrics(project, cand, cavity, caseParams, caseGeo, cartonVol, count){
  const p = project.pallet;
  const fit = fitInto(
    {outer: caseGeo.outer, allowedOrientations: project.tertiary.allowedOrientations},
    {L: p.L, W: p.W, H: p.maxH - p.baseH},
    project.tertiary.clearance,
    p.pattern
  );
  const loadH = fit.layers*caseGeo.outer.H;
  const cartonsPerPallet = fit.total*count;
  return {
    // identity
    nx: cand.nx, ny: cand.ny, nz: cand.layers, orientation: cand.o,
    arrangementLabel: `${cand.nx} × ${cand.ny} × ${cand.layers} ${cand.o}`,
    // the case
    cavity, caseParams,
    outer: caseGeo.outer,
    boardAreaM2: caseGeo.bbox.maxX*caseGeo.bbox.maxY/1e6,
    // the pallet
    casesPerLayer: fit.perLayer,
    caseLayers: fit.layers,
    casesPerPallet: fit.total,
    cartonsPerPallet,
    coveragePct: Math.round(fit.perLayer*caseGeo.outer.L*caseGeo.outer.W/(p.L*p.W)*100),
    // cube utilization: total carton volume over the LOAD envelope
    // (deck footprint x load height above the deck, wood excluded) —
    // the freight-driving number
    cubeUtilPct: loadH > 0 ? Math.round(cartonVol*cartonsPerPallet/(p.L*p.W*loadH)*100) : 0,
    casesFit: fit                            // retained for decorateRow (single source)
  };
}

