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
      // round product: 3 stacks of 2 pieces each (6 total), each piece a
      // 47mm-diameter x 12mm-thick puck, stood on its flat face (stackAxis
      // Z) -> envelope 141 x 47 x 24 (3 stacks of 47 across, one deep,
      // 2*12 tall) — clean whole-mm numbers straight through the chain.
      collation: {
        piece: {kind: 'cylinder', diameter: 47, thickness: 12},
        perStack: 2, stackAxis: 'Z', nx: 3, ny: 1, stackGap: 0, pieceGap: 0
      },
      // a plain product envelope instead of a collation — a single manual
      // outer, no inner, no compensation. Mutually exclusive with
      // `collation` (and with `wrap`, which wraps collated pieces, not a
      // box that's already its own envelope); null = use `collation` above.
      box: null,
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
                 L: 141, W: 47, H: 24},
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
      clearance: {wall: 1.5, between: 0, bottom: 0, top: 0, betweenZ: 0},
      // false = this tier is skipped: its own parent's child re-points to
      // whatever is next enabled below it. At least one of secondary/
      // tertiary must stay enabled — see resolveChainShape.
      enabled: true
    },
    tertiary: {
      styleId: 'fefco201',
      params: {...styleDefaults('fefco201')},        // L/W/H overwritten when solved
      options: styleOptionDefaults('fefco201'),      // {outerFlaps:'L'} — the 3D-fold major-panel choice
      allowedOrientations: ['LWH', 'WLH'],           // cases upright on the pallet
      clearance: {wall: 0, between: 0},
      enabled: true
    },
    pallet: {L: 48*25.4, W: 40*25.4, maxH: 60*25.4, baseH: 127, pattern: 'optimal'},
    // free print text on the package's print panel — lives in the model (and
    // the save file) even though its input control is hidden from the UI, so
    // it is never an orphaned, unsaveable Path-A value again.
    printText: 'FRAGILE',
    links: [
      {parent: 'tertiary', child: 'secondary', count: 12, arrangement: 'auto', locked: false},
      {parent: 'secondary', child: 'primary', count: 8, arrangement: {nx: 4, ny: 2, nz: 1}, locked: false}
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

/* ---------------- optional levels: the enabled-level fold ----------------
 * secondary (carton) and tertiary (case) each carry their own `enabled`
 * flag. A level's actual parent is the next enabled level above it — a fold
 * over ['secondary', 'tertiary'], never a hardcoded pair. The wrap tier is
 * NOT part of this fold: project.primary's own allowedOrientations/
 * clearance always describe the content's placement into whatever level is
 * actually next, whether or not a wrap style renders any geometry — wrap
 * only changes what geometry that content collapses into, never whether a
 * stage is "in the chain". At least one of secondary/tertiary must stay
 * enabled: content has to feed something before it reaches the pallet.
 */

/** Which of secondary/tertiary are enabled, and which is outermost (the one
 *  enumerated against the pallet — the other, if also enabled, is solved to
 *  a single deterministic variant feeding it). Throws if neither is enabled;
 *  the UI must never let that state happen (see app.js's toggle guard). */
export function resolveChainShape(project){
  const secOn = project.secondary.enabled !== false;
  const terOn = project.tertiary.enabled !== false;
  if(!secOn && !terOn) throw new Error('at least one packaging level (carton or case) must stay enabled');
  return {secOn, terOn, outermost: terOn ? 'tertiary' : 'secondary', secondaryIsInner: secOn && terOn};
}

/** Human-facing description of the current chain shape — which tier rides
 *  the pallet (`outerNoun`) and what feeds it (`childNoun`) — derived from
 *  the SAME fold resolveChainShape uses, never a hardcoded pair. Shared by
 *  the rails' placement labels and the Build table's status line, so the
 *  two can never describe the chain differently. */
export function describeChain(project){
  if(!project.primary) return {outerKey: 'tertiary', outerNoun: 'case', childNoun: 'carton'};
  const shape = resolveChainShape(project);
  const contentNoun = project.primary.wrap ? 'wrap' : (project.primary.box ? 'box' : 'collation');
  const childNoun = (shape.outermost === 'tertiary' && shape.secondaryIsInner) ? 'carton' : contentNoun;
  return {outerKey: shape.outermost, outerNoun: TIER_NOUN[shape.outermost], childNoun};
}

/** The content at the bottom of the chain: a collated set of pieces, or —
 *  per the plain-box ruling — a single manual outer with no inner and no
 *  compensation (a product envelope, not a package). Mutually exclusive:
 *  `box` set means `collation` is not consulted. `collation` is collate()'s
 *  own result (envelope/placements/count/fillEfficiency only — it carries
 *  none of the raw config); `config` is the raw collation config itself
 *  (piece/stackAxis/nx/ny), needed separately for labels and readouts. */
function contentEnvelope(prim){
  if(prim.box) return {outer: prim.box, count: 1, collation: null, config: null};
  const col = collate(prim.collation);
  return {outer: col.envelope, count: col.count, collation: col, config: prim.collation};
}

/** Solve the wrap tier, if configured, against `content` — otherwise pass
 *  `content` through untouched. Either way the result's allowedOrientations/
 *  clearance are project.primary's OWN: the content's placement settings,
 *  used whether or not a wrap style actually renders any geometry. */
function solvePrimaryStage(project, content){
  const prim = project.primary;
  const base = {allowedOrientations: prim.allowedOrientations, clearance: prim.clearance};
  if(!prim.wrap) return {...base, outer: content.outer, geo: null, fits: true, wrapAxis: null, wp: null};

  const wp = {...prim.wrap.params};
  // resolve which collation axis is the machine direction BEFORE calling
  // the style, so flowwrap.js never has to know about the permutation — it
  // stays a pure function of whatever L/W/H it's handed, always treating L
  // as pack length. The permutation (and its inverse on the way back out)
  // live here, not in the style.
  const wrapAxis = resolveWrapAxis(content.outer, prim.wrap.wrapAxis || 'auto');
  const permEnv = swapLW(content.outer, wrapAxis);
  // round girth basis is only meaningful for a single cylindrical slug
  // wrapped along its own axis — roundGirthEligible is the SAME predicate
  // the Build UI checks, so the two can never silently disagree. A plain
  // box has no collation to check eligibility against — never round.
  if(wp.girthBasis === 'round'){
    if(content.collation && roundGirthEligible(prim.collation, wrapAxis)) wp.roundDiameter = prim.collation.piece.diameter;
    else wp.girthBasis = 'rectangular';
  }
  let wrapFits = true;
  if(prim.wrap.locked){
    // locked wrap: content dims are user-fixed (in machine-direction
    // terms); check the permuted envelope fits
    wrapFits = permEnv.L <= wp.L && permEnv.W <= wp.W && permEnv.H <= wp.H;
  }else{
    wp.L = permEnv.L; wp.W = permEnv.W; wp.H = permEnv.H;
  }
  const raw = styleById(prim.wrap.styleId).geometry(wp);
  // un-permute back to true envelope axes: everything downstream (carton
  // sizing, display, the renderer's non-shape math) works in true L/W/H and
  // knows nothing about the machine-direction permutation.
  const wrapGeo = {...raw, inner: swapLW(raw.inner, wrapAxis), outer: swapLW(raw.outer, wrapAxis)};
  return {...base, outer: wrapGeo.outer, geo: wrapGeo, fits: wrapFits, wrapAxis, wp};
}

/**
 * Solve the secondary (carton) tier as a single deterministic variant
 * against `child` (whatever the wrap tier produced) — used only when
 * secondary sits BETWEEN content and the outermost enabled tier (tertiary
 * is also enabled). When secondary is itself the outermost tier it's
 * enumerated instead, exactly like tertiary is today (see candidateCases).
 */
/**
 * The 'auto' scoring objective for a solved (single-variant) inner tier:
 * minimize the PARENT's own material blank area, not cavity volume. Board
 * is what a case or carton costs; film is what a wrap costs; volume prices
 * neither. A minimal-volume cavity is frequently not a minimal-material one
 * (a flatter, wider cavity can need less board than a taller, narrower one
 * of the same volume, once the style's own compensation and panel layout
 * are accounted for) — so the score has to come from actually instantiating
 * the parent's style geometry for the candidate cavity, not from L*W*H.
 *
 * Supplied to solveParent's existing custom-scorer escape hatch (a plain
 * `(cavity) => number` function) — containment.js never learns what a
 * style or a blank area is; it just calls whatever scorer it's handed.
 * `level` (project.secondary today) supplies the styleId/params this
 * candidate cavity's L/W/H get merged into, exactly as solveSecondaryInner
 * itself does for the FINAL chosen cavity two lines below — this is the
 * same geometry call, just run once per candidate instead of once total.
 */
function materialAreaObjective(level){
  return cavity => {
    const params = {...level.params, L: cavity.L, W: cavity.W, H: cavity.H};
    const geo = styleById(level.styleId).geometry(params);
    return geo.bbox.maxX*geo.bbox.maxY;
  };
}

function solveSecondaryInner(project, child, step){
  const sec = project.secondary, prim = project.primary;
  const link = linkFor(project, 'secondary');
  let params, fits = true, capacity = null, chosen, arrangement, requestedUnits;
  if(link.locked){
    params = sec.params;                                        // user-fixed carton
    const chk = fitInto(child, {L: params.L, W: params.W, H: params.H}, prim.clearance, 'column');
    capacity = chk.total; fits = chk.total >= link.count;
    chosen = chk.placements[0] ? chk.placements[0].orientation : child.allowedOrientations[0];
    arrangement = chk; requestedUnits = link.count;
  }else if(link.arrangement === 'auto'){
    const solved = solveParent(child, link.count, prim.clearance, {objective: materialAreaObjective(sec)});
    const cavity = roundCavityUp(solved.cavity, step);
    params = {...sec.params, L: cavity.L, W: cavity.W, H: cavity.H};
    chosen = solved.arrangement.placements[0]
      ? solved.arrangement.placements[0].orientation : child.allowedOrientations[0];
    arrangement = solved.arrangement; requestedUnits = link.count;
  }else{
    // explicit nx×ny×nz: identical pattern to the outermost tier's explicit
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
      params = sec.params; fits = false; capacity = 0;
      chosen = child.allowedOrientations[0]; arrangement = {placements: [], total: 0};
    }else{
      const cavity = roundCavityUp(cands[0].cavity, step);
      params = {...sec.params, L: cavity.L, W: cavity.W, H: cavity.H};
      const fit = fitInto(child, cavity, prim.clearance, 'column');
      chosen = fit.placements[0] ? fit.placements[0].orientation : child.allowedOrientations[0];
      arrangement = fit; fits = fit.total >= requestedUnits; capacity = fit.total;
    }
  }
  return {params, geo: styleById(sec.styleId).geometry(params), orientation: chosen, fits, capacity, arrangement, requestedUnits};
}

/**
 * Resolve everything below the outermost enabled tier: the content, the
 * wrap tier (if configured), and — only when secondary sits between content
 * and the outermost tier — the carton solved to a single variant. Returns
 * `child`: whatever feeds the outermost tier's own enumeration/lock check,
 * carrying its OWN allowedOrientations/clearance (never the outermost's) —
 * this is the re-pointing: disabling a level makes the level below it hand
 * its OWN placement settings to whatever is now its actual parent.
 */
function solveBelowOutermost(project, shape, step){
  const content = contentEnvelope(project.primary);
  const primaryResult = solvePrimaryStage(project, content);
  const primaryChild = {outer: primaryResult.outer, allowedOrientations: primaryResult.allowedOrientations, clearance: primaryResult.clearance};

  let secondaryVariant = null, child = primaryChild;
  if(shape.secondaryIsInner){
    secondaryVariant = solveSecondaryInner(project, primaryChild, step);
    child = {outer: secondaryVariant.geo.outer, allowedOrientations: project.secondary.allowedOrientations, clearance: project.secondary.clearance};
  }
  return {content, primaryResult, secondaryVariant, child};
}

/** Whatever feeds the outermost tier, fitted into its cavity in the
 *  candidate's chosen orientation. Generalizes what was `fitCartonsInCase`:
 *  the CHILD's own allowedOrientations/clearance apply — whichever level
 *  actually produced it, never the outermost's own settings. */
function fitChildInOuter(child, cavity, chosenOrientation){
  const c = {
    outer: child.outer,
    allowedOrientations: typeof chosenOrientation === 'string' && chosenOrientation.length === 3
      ? [chosenOrientation] : child.allowedOrientations
  };
  return fitInto(c, cavity, child.clearance, 'column');
}

/** The legacy bare-carton chain (`project.primary === null`): no content
 *  stage at all, the carton is whatever's configured, unsolved. Predates
 *  the wrap/optional-levels features and is still exercised by hand-checked
 *  tests — preserved exactly, always case-enumerated (secondary/tertiary
 *  enabled flags are not consulted in this legacy mode). */
function legacyBelowOutermost(project){
  const sec = project.secondary;
  const geo = styleById(sec.styleId).geometry(sec.params);
  return {
    content: null, primaryResult: null,
    secondaryVariant: {params: sec.params, geo, fits: true, orientation: null, requestedUnits: null},
    child: {outer: geo.outer, allowedOrientations: sec.allowedOrientations, clearance: sec.clearance}
  };
}

function resolveBelowAndOuterKey(project, step){
  if(!project.primary) return {below: legacyBelowOutermost(project), outerKey: 'tertiary'};
  const shape = resolveChainShape(project);
  return {below: solveBelowOutermost(project, shape, step), outerKey: shape.outermost};
}

/**
 * Enumerate every arrangement of the OUTERMOST enabled tier and run it
 * through to the pallet. Never collapses to one winner — ranking and choice
 * belong to the engineer. Works identically whether the outermost tier is
 * the case (the default) or, with tertiary disabled, the carton itself.
 * @param {Project} project
 * @param {string} rounding  key of ROUNDING
 * @returns {Object[]} rows (see fields below), enumeration order
 */
export function candidateCases(project, rounding = '1mm'){
  const step = ROUNDING[rounding] || 1;
  const {below, outerKey} = resolveBelowAndOuterKey(project, step);
  const outerLevel = project[outerKey];
  const outerLink = linkFor(project, outerKey);
  const child = below.child;
  const childVol = child.outer.L*child.outer.W*child.outer.H;

  let cands;
  if(outerLink.arrangement === 'auto'){
    cands = parentCandidates(child, outerLink.count, child.clearance).filter(c => irreducible(c, outerLink.count));
  }else{
    const {nx, ny, nz} = outerLink.arrangement;
    cands = parentCandidates(child, nx*ny*nz, child.clearance, {layers: nz})
      .filter(c => c.nx === nx && c.ny === ny);
  }

  const rows = [];
  for(const c of cands){
    const cavity = roundCavityUp(c.cavity, step);
    const outerParams = {...outerLevel.params, L: cavity.L, W: cavity.W, H: cavity.H};
    const outerGeo = styleById(outerLevel.styleId).geometry(outerParams);
    const row = chainMetrics(project, outerKey, c, cavity, outerParams, outerGeo, childVol, outerLink.count);
    const childFit = fitChildInOuter(child, cavity, c.o);
    rows.push(decorateRow(row, project, below, outerKey, outerGeo, row.casesFit, childFit));
  }
  return rows;
}

/** Locked direction: the outermost tier's dims are fixed; check its child
 *  against them. With a primary level, the child is first derived from (or
 *  checked against) the content using the FIRST allowed orientation. */
export function checkLockedCase(project, rounding = '1mm'){
  const step = ROUNDING[rounding] || 1;
  const {below, outerKey} = resolveBelowAndOuterKey(project, step);
  const outerLevel = project[outerKey];
  const outerLink = linkFor(project, outerKey);
  const child = below.child;
  const cavity = {L: outerLevel.params.L, W: outerLevel.params.W, H: outerLevel.params.H};
  // the child's orientation into ITS parent is a different rotational
  // relationship than the outermost's own contents — passing it here would
  // wrongly restrict the fit check to whichever orientation the child
  // happened to use, so a level locked at exactly its own solved cavity
  // could spuriously "not fit". Pass none: fitChildInOuter falls back to
  // the child's own allowedOrientations, same as the unlocked path.
  const childFit = fitChildInOuter(child, cavity, null);
  const outerGeo = styleById(outerLevel.styleId).geometry(outerLevel.params);
  const childVol = child.outer.L*child.outer.W*child.outer.H;
  const cand = {nx: '—', ny: '—', layers: childFit.layers,
                o: childFit.placements[0] ? childFit.placements[0].orientation : '—'};
  const row = chainMetrics(project, outerKey, cand, cavity, outerLevel.params, outerGeo, childVol, outerLink.count);
  row.capacity = childFit.total;
  const outerFits = childFit.total >= outerLink.count;
  const upstreamFits = (below.secondaryVariant ? below.secondaryVariant.fits : true)
    && (below.primaryResult ? below.primaryResult.fits : true);
  row.fits = outerFits && upstreamFits;
  row.arrangementLabel = `locked (${childFit.label})`;
  return decorateRow(row, project, below, outerKey, outerGeo, row.casesFit, childFit, outerFits);
}

/**
 * Resolve the ONE candidate row every view should render — a locked
 * outermost tier uses checkLockedCase (a single row), otherwise the
 * enumerated candidate matching `selectedKey` (nx/ny/nz/orientation),
 * falling back to the freight-optimal row (max cartons/pallet). This is the
 * single row hierarchyBundle, the 2D dieline, the 3D fold, the DXF export,
 * and every readout all read from — so they can never show different
 * geometry for the same level (the Path-A bug).
 * @returns {Object|null} a decorated candidate row, or null if nothing fits
 */
export function resolveActiveRow(project, rounding = '1mm', selectedKey = null){
  const outerKey = project.primary ? resolveChainShape(project).outermost : 'tertiary';
  const outerLink = linkFor(project, outerKey);
  if(outerLink.locked) return checkLockedCase(project, rounding);
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
 * configured, 'carton' with secondary disabled, 'case' with tertiary
 * disabled, or nothing fits). This is the seam that makes the 2D dieline,
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

/** Attach every derived field + the retained arrangements to a metrics row.
 *  `outerFits` defaults true: candidateCases only ever enumerates candidates
 *  that already fit, so there's nothing to misreport; a locked outermost
 *  tier (checkLockedCase) passes its own real check instead. */
function decorateRow(row, project, below, outerKey, outerGeo, casesFit, childFit, outerFits = true){
  const {primaryResult, secondaryVariant, content} = below;
  const cartonGeo = outerKey === 'secondary' ? outerGeo : (secondaryVariant ? secondaryVariant.geo : null);
  const caseGeo = outerKey === 'tertiary' ? outerGeo : null;

  row.cartonParams = outerKey === 'secondary' ? row.caseParams : (secondaryVariant ? secondaryVariant.params : null);
  row.cartonOuter = cartonGeo ? cartonGeo.outer : null;
  // secondaryVariant.orientation is the wrap/content's orientation inside
  // the carton, computed by the INNER solve; when there's no inner solve
  // (secondary disabled, or secondary IS outermost), the outermost
  // enumeration's own chosen orientation (row.orientation) answers the same
  // question instead — whatever's immediately below the outermost tier.
  row.primaryOrientation = secondaryVariant ? secondaryVariant.orientation : row.orientation;
  row.primaryLabel = (content && content.config) ? orientationLabel(content.config.stackAxis, row.primaryOrientation) : null;
  row.primaryFits = (secondaryVariant ? secondaryVariant.fits : true) && (primaryResult ? primaryResult.fits : true);
  // per-level fit flags — the rail uses these to show a misfit against the
  // SPECIFIC locked level, not just the chain's overall combined result
  row.wrapFits = primaryResult ? primaryResult.fits : true;
  row.secondaryFits = outerKey === 'secondary' ? outerFits : (secondaryVariant ? secondaryVariant.fits : true);
  row.tertiaryFits = outerKey === 'tertiary' ? outerFits : true;

  // pieces/carton depends only on how many content UNITS sit in the carton —
  // true whether or not those units are wrapped in film. Meaningless (null)
  // when there's no carton at all (secondary disabled).
  const requestedForPieces = secondaryVariant ? secondaryVariant.requestedUnits
    : (outerKey === 'secondary' ? linkFor(project, 'secondary').count : null);
  row.piecesPerCarton = (content && requestedForPieces != null) ? content.count*requestedForPieces : null;
  row.piecesPerPallet = row.piecesPerCarton !== null ? row.piecesPerCarton*row.cartonsPerPallet : null;

  if(primaryResult && primaryResult.geo){
    // film cost columns — board vs film trade against each other. film
    // numbers and fillEfficiency NEVER touch cube utilization.
    const film = primaryResult.geo.meta.film;
    row.filmAreaM2 = film.filmAreaM2;
    row.filmKgPerPallet = requestedForPieces != null
      ? (film.massPer1000g/1000)*requestedForPieces*row.cartonsPerPallet/1000 : null;
    row.wrapOuter = primaryResult.geo.outer;
  }else{
    row.filmAreaM2 = null; row.filmKgPerPallet = null; row.wrapOuter = null;
  }
  // retained arrangements (single source of truth; the view reads these)
  const p = project.pallet;
  row.geo = {case: caseGeo, carton: cartonGeo, wrap: primaryResult ? primaryResult.geo : null};
  row.arr = {
    cases:   {placements: casesFit.placements, count: casesFit.total, deck: {L: p.L, W: p.W, baseH: p.baseH}},
    cartons: {placements: childFit.placements, count: childFit.total},
    wraps:   (secondaryVariant && secondaryVariant.arrangement && primaryResult && primaryResult.geo)
      ? {placements: secondaryVariant.arrangement.placements, count: secondaryVariant.arrangement.total} : null,
    pieces:  (content && content.collation && primaryResult && primaryResult.geo)
      ? {placements: content.collation.placements, envelope: content.collation.envelope,
         piece: content.config.piece, stackAxis: content.config.stackAxis,
         nx: content.config.nx, ny: content.config.ny, wrapAxis: primaryResult.wrapAxis,
         seals: {sealType: primaryResult.wp.sealType, finTreatment: primaryResult.wp.finTreatment,
                 finHeight: primaryResult.wp.finHeight, finSealBand: primaryResult.wp.finSealBand,
                 endSealWidth: primaryResult.wp.endSealWidth, finFace: primaryResult.wp.finFace || 'back',
                 gauge: primaryResult.wp.gauge}} : null
  };
  return row;
}

/** Full-chain metrics for the outermost tier (`outerKey`, 'secondary' or
 *  'tertiary') against the pallet — generalizes what was hardcoded to
 *  tertiary. `count` is outerKey's own link.count: cartons/case when the
 *  case is outermost (the default), or content-units/case when secondary is
 *  disabled — either way, the right multiplier to reach a per-pallet total.
 *  When secondary itself is outermost (no case), that multiplier is 1: the
 *  outermost unit IS what's on the pallet, nothing further to multiply. */
function chainMetrics(project, outerKey, cand, cavity, outerParams, outerGeo, childVol, count){
  const outerLevel = project[outerKey];
  const p = project.pallet;
  const fit = fitInto(
    {outer: outerGeo.outer, allowedOrientations: outerLevel.allowedOrientations},
    {L: p.L, W: p.W, H: p.maxH - p.baseH},
    outerLevel.clearance,
    p.pattern
  );
  const loadH = fit.layers*outerGeo.outer.H;
  const perPalletMultiplier = outerKey === 'tertiary' ? count : 1;
  const cartonsPerPallet = fit.total*perPalletMultiplier;
  // the "productive volume" cube-util measures is whatever `cartonsPerPallet`
  // actually counts: the outermost's own CHILD when a multiplier bridges the
  // gap (case counting cartons within it), or the outermost itself when
  // there's no gap to bridge (carton riding the pallet directly)
  const outerVol = outerGeo.outer.L*outerGeo.outer.W*outerGeo.outer.H;
  const unitVol = outerKey === 'tertiary' ? childVol : outerVol;
  return {
    // identity
    nx: cand.nx, ny: cand.ny, nz: cand.layers, orientation: cand.o,
    arrangementLabel: `${cand.nx} × ${cand.ny} × ${cand.layers} ${cand.o}`,
    // the outermost tier
    cavity, caseParams: outerParams,
    outer: outerGeo.outer,
    boardAreaM2: outerGeo.bbox.maxX*outerGeo.bbox.maxY/1e6,
    // the pallet
    casesPerLayer: fit.perLayer,
    caseLayers: fit.layers,
    casesPerPallet: fit.total,
    cartonsPerPallet,
    coveragePct: Math.round(fit.perLayer*outerGeo.outer.L*outerGeo.outer.W/(p.L*p.W)*100),
    // cube utilization: total carton volume over the LOAD envelope
    // (deck footprint x load height above the deck, wood excluded) —
    // the freight-driving number
    cubeUtilPct: loadH > 0 ? Math.round(unitVol*cartonsPerPallet/(p.L*p.W*loadH)*100) : 0,
    casesFit: fit                            // retained for decorateRow (single source)
  };
}

