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
import {fitInto, parentCandidates, solveParent, orientDims} from './containment.js';
import {palletPatternList, emptyArrangement} from './palletpatterns.js';
import {trayParams, trayOuter, isProud, deriveTrayParams, packPitchOf} from './cookietray.js';
import {materialCost} from './cost.js';
import {styleById} from './styles/index.js';
import {withPerforation} from './perf.js';
import {collate, orientationLabel, resolvePieceOrientation} from './collation.js';

/**
 * @typedef {import('./containment.js').Orientation} Orientation
 * @typedef {import('./containment.js').Clearance} Clearance
 *
 * @typedef {Object} Level
 * @property {string} styleId
 * @property {Object} params                       // style params, mm
 * @property {Orientation[]} allowedOrientations   // how THIS level may sit inside its parent
 * @property {Clearance} clearance                 // how much room THIS level needs inside its parent
 * @property {boolean} [openTop]                   // this level, as a PARENT to whatever it holds,
 *   does not constrain height — its own H is an independent design input
 *   (e.g. a tray's wall height), not solved from its child's stack, and
 *   doesn't bound how many children fit. A containment-relationship fact,
 *   defaulted from the style's own defaultOpenTop but overridable per level
 *   (the same tray under a telescoping cap is no longer open) — containment.js
 *   never reads a style, only this flag. Defaults to false (closed).
 * @property {Object} [geometry]                   // derived, cached
 *
 * @typedef {Object} PalletConfig
 * @property {number} L @property {number} W      // deck, mm
 * @property {number} maxH                         // total height budget incl. base, mm
 * @property {number} baseH                        // deck assembly height, mm
 * @property {'optimal'|'column'|'interlock'} pattern  // FAMILY filter into the
 *   ranked pattern list (palletpatterns.js): optimal = every construction,
 *   column = aligned grids, interlock = odd-layer-180° stacking
 * @property {number} [patternIndex]               // 0-based pick within the
 *   ACTIVE row's ranked list (the 3D cycle arrows step this); clamped to the
 *   list on read, 0 (the ranked best) when absent — older saves load as-is
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

/** A level's openTop DEFAULTS from its style (e.g. the FEFCO 0300 tray is
 *  open by default) but is a level field, not a style read at chain time —
 *  see the Level typedef. */
export function styleOpenTopDefault(styleId){
  return !!styleById(styleId).defaultOpenTop;
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
      // the flow wrap around the collation. null = bare envelope (legacy).
      // Seal values are editable defaults, not conventions.
      wrap: {
        styleId: 'flowwrap',
        // L/W/H here are the REMEMBERED locked-content dims (used only when
        // locked: true) — defaulted to match this default collation's own
        // envelope so the field has a sane starting value the moment the
        // lock checkbox is turned on, instead of reading back `undefined`.
        params: {sealType: 'fin', finHeight: 8, finSealBand: 5, finTreatment: 'folded', finFace: 'bottom',
                 lapOverlap: 12, endSealWidth: 10, endSealBleed: 3,
                 girthBasis: 'rectangular', roundDiameter: 0, gauge: 30, density: 0.92,
                 L: 141, W: 47, H: 24},
        // machine direction is fixed at envelope L (seals at the L-ends, fin
        // on the bottom) — no wrapAxis choice; the collation orientation is
        // what varies the pack shape upstream. See roundGirthEligible.
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
      openTop: styleOpenTopDefault('a6120'),         // false: a6120 is closed
      // PERFORATION — a capability applied to this container, not to its
      // style. Absence IS the off state (the `cost` rate bag's idiom), so an
      // older save file loads unperforated rather than with five frozen
      // settings, and core/perf.js's normalizePerf fills the rest.
      perf: {},
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
      perf: {},                                      // see project.secondary.perf
      clearance: {wall: 0, between: 0},
      openTop: styleOpenTopDefault('fefco201'),      // false: fefco201 is closed
      enabled: true
    },
    // Thermoformed sizing tray between the product and the wrap. OPTIONAL and
    // OFF by default, so the default chain and every golden pin are untouched
    // until it is switched on. openTop is a fact of the part (it has no lid):
    // its footprint constrains, its height does not.
    // `nCells` is the ONE stored cell count — the tray rail and the collation
    // rail are two CONTROLS onto this single value, never two values that sync.
    // `params` holds tray inputs; a null/absent cell dimension means "derive
    // from the product" (auto-with-override), any number overrides it.
    tray: {
      enabled: false,
      nCells: 2,                       // default when enabled: 2 cells x 10 on edge
      // NOTE there is deliberately no `perCell` here. Products-per-cell is
      // owned by the COLLATION (perStack x nx x ny) and nothing else; storing
      // it again would be a second writer for one quantity, free to disagree.
      // Enabling the tray configures the collation to the 10-on-edge default
      // instead (see setTierEnabled), which is a WRITE to the one owner.
      endClearance: 3, sideClearance: 1.5,
      // NOTE there is deliberately no `distributeBy` either. Total is derived
      // and editable, and the ambiguity it used to resolve ("72 -> 80: more
      // cells or more per cell?") now has ONE fixed answer instead of a
      // setting: cells are the ANCHOR, so a total edit is absorbed by per-cell
      // and the cell count moves only when the user edits cells (app.js
      // applyTrayQuantity).
      params: {},                      // overrides only; {} = fully auto
      allowedOrientations: ['LWH', 'WLH'],
      clearance: {wall: 0, between: 0},
      openTop: true
    },
    pallet: {L: 48*25.4, W: 40*25.4, maxH: 60*25.4, baseH: 127, pattern: 'optimal', patternIndex: 0,
      // stacking-strength (BCT) inputs — engineering guidance, not packing math.
      // ect: edge crush lb/in; unitWeightLb: gross weight per box (tare +
      // contents, which the app can't know); target: required safety factor;
      // doubleStack: two unit loads high in the warehouse (doubles the column).
      stacking: {ect: 32, unitWeightLb: 20, target: 3.0, doubleStack: false}},
    // MATERIAL RATES — project assumptions, not per-level state, so one flat
    // bag. Empty = every rate at its default (core/cost.js COST_DEFAULTS);
    // the presence of a key IS the override, the same auto-with-override
    // shape the tray's cell dimensions use. Stored canonically ($/m², $/kg),
    // never in the display unit.
    cost: {},
    // free print text on the package's print panel — the capability stays
    // wired in the model + save file, but the DEFAULT is empty: with real
    // uploaded artwork a placeholder string would clutter clean output and
    // bleed through the art. Nothing renders unless the user sets it.
    printText: '',
    // the three settable counts (cases/pallet is solved, never a default):
    // product/wrap is the collation above (3 stacks of 2 = 6, unchanged),
    // wraps/carton = 8 (explicit 1x4x2 — its own product IS 8), cartons/
    // case = 12 (auto). Every test/golden pin that depends on one of these
    // must pin its own explicit value rather than inherit these — see the
    // "not a pin" comments in project.test.html/saveload.test.html.
    links: [
      {parent: 'tertiary', child: 'secondary', count: 12, arrangement: 'auto', locked: false},
      {parent: 'secondary', child: 'primary', count: 8, arrangement: {nx: 1, ny: 4, nz: 2}, locked: false}
    ],
    // uploaded artwork, keyed by style level ('wrap'|'carton'|'case'). Each
    // entry is {src, natW, natH, fit, dx, dy, scale} — `src` a downscaled data
    // URL (see save.js) so the save file round-trips the art without bloating.
    // Empty by default; a level appears only once art is uploaded there.
    artwork: {},
    // RETAIL SHELF PRESENTATION — which face is merchandised forward and how
    // far it's turned. Chosen when the design is saved and part of what the
    // design IS on shelf, so it lives on the project (unlike the shelf's own
    // width/depth/height/facings/stack/deep/cutaway, which are bay-spec, not
    // design data, and stay session-only UI state in ui/app.js). This is what
    // lets shelf-compare restore each slot's own presentation instead of
    // both bays reading whatever the live control currently shows.
    shelf: {front: 'auto', rot: 0}
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
 * The flow wrapper is FIXED: the machine direction is always envelope L. The
 * collation presents its run along L, the two end seals land at the L-ends
 * (full height), and the fin closes on the bottom. There is no axis choice
 * and no L/W permutation — the pack shape is varied UPSTREAM by the collation
 * orientation (flat / on-edge + stack axis), which decides what envelope L
 * actually is (e.g. an on-edge sleeve's N·t run), not by moving the seals.
 *
 * Round girth (π·d) is therefore meaningful only when the collation forms a
 * single circular tube running along L: one stack (nx=ny=1) of cylinders
 * lying ON EDGE with the cylinder axis along L, i.e. stackAxis X. A lone slug
 * and an on-edge sleeve of N are the same tube, longer. A flat stack presents
 * a rectangular d×t profile, and any multi-stack arrangement (nx or ny > 1)
 * is not one tube — both stay rectangular. The Build UI uses this same
 * predicate, so the two can never silently disagree.
 */
export function roundGirthEligible(collation){
  if(collation.piece.kind !== 'cylinder') return false;
  if(collation.nx !== 1 || collation.ny !== 1) return false;
  if(resolvePieceOrientation(collation) !== 'on-edge') return false;
  return collation.stackAxis === 'X';   // the on-edge tube axis must run along L (the machine direction)
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
  const contentNoun = project.primary.wrap ? 'wrap' : 'collation';
  const childNoun = (shape.outermost === 'tertiary' && shape.secondaryIsInner) ? 'carton' : contentNoun;
  return {outerKey: shape.outermost, outerNoun: TIER_NOUN[shape.outermost], childNoun};
}

/** The content at the bottom of the chain: always a collation. A simple box
 *  envelope is a Rectangular piece, 1 per stack, 1x1 — it falls out of this
 *  model, so there is no separate plain-box type. `collation` is collate()'s
 *  own result (envelope/placements/count/fillEfficiency only — it carries
 *  none of the raw config); `config` is the raw collation config itself
 *  (piece/stackAxis/nx/ny), needed separately for labels and readouts. */
function contentEnvelope(prim){
  const col = collate(prim.collation);
  return {outer: col.envelope, count: col.count, collation: col, config: prim.collation};
}

/** Solve the wrap tier, if configured, against `content` — otherwise pass
 *  `content` through untouched. Either way the result's allowedOrientations/
 *  clearance are project.primary's OWN: the content's placement settings,
 *  used whether or not a wrap style actually renders any geometry. */
function solvePrimaryStage(project, content, opts = {}){
  const prim = project.primary;
  const base = {allowedOrientations: prim.allowedOrientations, clearance: prim.clearance};
  if(!prim.wrap) return {...base, outer: content.outer, geo: null, fits: true, wrapAxis: null, wp: null};

  const wp = {...prim.wrap.params};
  // Machine direction is ALWAYS envelope L (fixed machine) — flowwrap treats
  // L as pack length directly, no axis resolution and no L/W permutation. The
  // pack shape varies upstream via the collation orientation (which decides
  // what L is), never by moving the seals.
  const env = content.outer;
  // round girth is only meaningful for a single on-edge tube running along L
  // (roundGirthEligible). A plain box has no collation to check — never round.
  // A round girth only describes a bare on-edge slug. With a tray in the
  // chain the film is pulled over the TRAY (a rectangular thing that happens
  // to contain round product), so the caller forces rectangular — reading
  // the collation here would wrongly keep hugging a cookie that is no longer
  // what the wrap touches.
  if(wp.girthBasis === 'round'){
    if(!opts.forceRectangularGirth && content.collation && roundGirthEligible(prim.collation))
      wp.roundDiameter = prim.collation.piece.diameter;
    else wp.girthBasis = 'rectangular';
  }
  let wrapFits = true;
  if(prim.wrap.locked){
    wrapFits = env.L <= wp.L && env.W <= wp.W && env.H <= wp.H;   // user-fixed dims are already true L/W/H
  }else{
    wp.L = env.L; wp.W = env.W; wp.H = env.H;
  }
  const wrapGeo = {...styleById(prim.wrap.styleId).geometry(wp, prim.wrap.options)};   // true envelope axes throughout — no permutation
  // wrapAxis stays 'L' on the row: a fixed constant the renderer/readout read
  // so seals/fin always land on the L-ends, never a resolved-per-envelope pick.
  return {...base, outer: wrapGeo.outer, geo: wrapGeo, fits: wrapFits, wrapAxis: 'L', wp};
}

/* ---------------- the thermoformed tray stage ----------------------------
 * An OPTIONAL level between the product collation and the wrap:
 *   collation (product within ONE cell) -> tray (N cells) -> wrap -> carton...
 *
 * Disabled by default, so the whole function is a pass-through until someone
 * turns it on and no existing chain can move.
 *
 * WHY THIS IS ITS OWN STAGE, not a level fed through the generic inner
 * solve. `solveSecondaryInner` never reads `openTop` — a documented
 * simplification (see CLAUDE.md: openTop is wired for the OUTERMOST tier
 * only), so an open-top container nested as an inner level still constrains
 * height as if it were closed. The tray is exactly that case: inner, and
 * open-top by nature. Routing it through that machinery would silently cap
 * the product at the tray rim and lose the proud height. Instead the tray
 * computes its own envelope here, where the open-top rule is explicit:
 *
 *   footprint CONSTRAINS (a product wider than its cell is a real misfit)
 *   height does NOT      (standing proud is legal, never "does not fit")
 *
 * containment.js is untouched — this stage never calls it.
 *
 * The cell dimensions follow the auto-with-override idiom the rails already
 * use: a null/absent override means "derive from the product", any number
 * overrides it. Auto cell depth is the shallowest trough that can complete
 * the cradle (cellWid/2, since cradleR defaults to the half-width) — which
 * is why a tall product naturally stands proud rather than being swallowed.
 */
/**
 * THE tray auto-derivation: cell length AND cell width, straight out of the
 * ported Cookie-Tray inverse path (`deriveTrayParams`). Exported so the tray
 * stage and the rail's "auto" readout are one derivation rather than two
 * copies that agree until they don't.
 *
 * Why the whole path and not another extracted rule: `deriveTrayParams` was
 * validated to 1e-9 against its source and called by NOTHING, while the app
 * restated its rules — cell length (fixed in bdf944d) and cell WIDTH, which
 * still read `env.W + 2*side`. That width is the COLLATION's envelope across,
 * so a multi-stack or cross-axis collation grew the cell by a whole product
 * (measured: ny=2 -> 97mm vs 50mm, stackAxis Y -> 123mm vs 50mm) and the tray
 * our own exported link rebuilds was a different tray. Their rule is one stack
 * per cell: product across + 2*sideClearance, full stop.
 *
 * The PROBE: their derive takes cellH as an input, but our own auto depth is
 * half the derived WIDTH — knowable only after deriving. One throwaway call
 * resolves the ordering, with the cradle collapsed (a huge cradleClearance) and
 * a minimal depth so the `cellH >= cradleR` guard cannot fire on the probe;
 * neither cellLen nor cellWid depends on either, so what it reports is exact.
 * Two calls to ONE rule — the alternative is restating the width rule here,
 * which is the duplication being removed.
 */
export function trayAutoCells(project, content = contentEnvelope(project.primary)){
  const tray = project.tray || {};
  const ov = tray.params || {};
  const num = v => typeof v === 'number' && isFinite(v);
  const piece = content.config.piece;
  const perCell = content.count;
  const nCells = Math.max(1, Math.round(tray.nCells || 1));
  const probe = deriveTrayParams({
    ...ov,                                        // pass-through §3 inputs (wall, floor, ...)
    qtyTotal: perCell*nCells, nCells,
    sideClearance: num(tray.sideClearance) ? tray.sideClearance : 1.5,
    endClearance:  num(tray.endClearance)  ? tray.endClearance  : 3,
    ...(piece.kind === 'cylinder'
      ? {productType: 'round', cookieDiameter: piece.diameter, cookieThickness: packPitchOf(piece)}
      : {productType: 'rectangle', productThickness: packPitchOf(piece),
         productWidth: piece.W, productHeight: piece.H}),
    cellH: 1, cradleClearance: Number.MAX_SAFE_INTEGER   // probe-only; see above
  });
  return {cellLen: probe.cellLen, cellWid: probe.cellWid};
}

function solveTrayStage(project, content){
  const tray = project.tray;
  if(!tray || tray.enabled !== true) return null;      // pass-through (the default)

  const env = content.outer;                            // ONE cell's product envelope
  const ov = tray.params || {};
  const num = v => typeof v === 'number' && isFinite(v);
  const endC = num(tray.endClearance) ? tray.endClearance : 3;
  const sideC = num(tray.sideClearance) ? tray.sideClearance : 1.5;

  const nCells = Math.max(1, Math.round(tray.nCells || 1));
  const auto = trayAutoCells(project, content);          // THE derivation (see below)

  // auto-with-override, one axis at a time — the AUTO half now comes entirely
  // from the ported, validated inverse path; only the user's own overrides are
  // applied here.
  const cellLen = num(ov.cellLen) ? ov.cellLen : auto.cellLen;
  const cellWid = num(ov.cellWid) ? ov.cellWid : auto.cellWid;
  // trough DEPTH is ours, not theirs: their derive defaults cellH to a flat
  // 28mm, we use the shallowest trough that still completes the cradle. It
  // follows the EFFECTIVE width, so a cellWid override deepens the trough too.
  const cellH   = num(ov.cellH)   ? ov.cellH   : cellWid/2;
  // M4, a DELIBERATE override of the validated path. trayParams derives
  // cradleR = cellWid/2 when it is null, and guards cellH >= cradleR — so a
  // user who shallows the trough below the half-width would get a THROW rather
  // than simply a shallower cradle. Null on the normal path (their rule owns
  // it); clamped to the trough only when that guard would otherwise fire.
  const cradleR = num(ov.cradleR) ? ov.cradleR : (cellH < cellWid/2 ? cellH : null);

  const p = trayParams({...ov, nCells, cellLen, cellWid, cellH, cradleR});

  // the product bottoms out on the trough floor, which sits at the tray's own
  // floor thickness — so its top is floor + the collation's standing height
  const standingH = env.H;
  const outer = trayOuter(p, standingH);

  // FOOTPRINT-ONLY fit. Height is deliberately absent from this test: a
  // product standing above the cells is the normal case for an open tray,
  // not a failure. Only an override that makes a cell too small in plan is.
  const EPS = 1e-9;
  const widthFits = cellWid + EPS >= env.W;
  const lengthFits = cellLen + EPS >= env.L;
  const fits = widthFits && lengthFits;
  // A misfit here is nearly always a collation the tray MODEL cannot express
  // (more than one stack across a cell, or the run laid along the wrong axis),
  // not a mis-typed dimension — so it says which, rather than a bare "does not
  // fit" that reads like an arithmetic failure.
  const why = [];
  if(!widthFits)  why.push('collation width exceeds the tray cell; the tray models one stack per cell');
  if(!lengthFits) why.push('collation run exceeds the tray cell length');
  const misfitReason = why.length ? why.join('; ') : null;

  return {
    params: p, outer, nCells, fits, misfitReason, standingH,
    proud: isProud(p, standingH),
    perCell: content.count,
    total: nCells*content.count,
    cellAuto: {cellLen: !num(ov.cellLen), cellWid: !num(ov.cellWid), cellH: !num(ov.cellH)}
  };
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
    const geo = styleById(level.styleId).geometry(params, level.options);
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
  return {params, geo: styleById(sec.styleId).geometry(params, sec.options), orientation: chosen, fits, capacity, arrangement, requestedUnits};
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
  const collation = contentEnvelope(project.primary);
  // The tray, when enabled, is what the wrap actually wraps: it replaces the
  // collation envelope with its own (max cross-section, proud-aware) and
  // multiplies the piece count by its cell count. Disabled — the default —
  // `trayResult` is null and `content` IS the collation, bit-identical to
  // the pre-tray chain.
  const trayResult = solveTrayStage(project, collation);
  const content = trayResult
    ? {...collation, outer: trayResult.outer, count: trayResult.total}
    : collation;
  const primaryResult = solvePrimaryStage(project, content, {forceRectangularGirth: !!trayResult});
  const primaryChild = {outer: primaryResult.outer, allowedOrientations: primaryResult.allowedOrientations, clearance: primaryResult.clearance};

  let secondaryVariant = null, child = primaryChild;
  if(shape.secondaryIsInner){
    secondaryVariant = solveSecondaryInner(project, primaryChild, step);
    child = {outer: secondaryVariant.geo.outer, allowedOrientations: project.secondary.allowedOrientations, clearance: project.secondary.clearance};
  }
  return {content, collation, trayResult, primaryResult, secondaryVariant, child};
}

/** Whatever feeds the outermost tier, fitted into its cavity in the
 *  candidate's chosen orientation. Generalizes what was `fitCartonsInCase`:
 *  the CHILD's own allowedOrientations/clearance apply — whichever level
 *  actually produced it, never the outermost's own settings.
 *  @param {Object} [opts] forwarded to fitInto (openTop/wantCount) */
function fitChildInOuter(child, cavity, chosenOrientation, opts){
  const c = {
    outer: child.outer,
    allowedOrientations: typeof chosenOrientation === 'string' && chosenOrientation.length === 3
      ? [chosenOrientation] : child.allowedOrientations
  };
  return fitInto(c, cavity, child.clearance, 'column', opts);
}

/** The legacy bare-carton chain (`project.primary === null`): no content
 *  stage at all, the carton is whatever's configured, unsolved. Predates
 *  the wrap/optional-levels features and is still exercised by hand-checked
 *  tests — preserved exactly, always case-enumerated (secondary/tertiary
 *  enabled flags are not consulted in this legacy mode). */
function legacyBelowOutermost(project){
  const sec = project.secondary;
  const geo = styleById(sec.styleId).geometry(sec.params, sec.options);
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
  // openTop: a containment-relationship fact on THIS level (defaults from
  // the style, overridable — see styles/index.js's defaultOpenTop), never
  // read by containment.js itself. When set, the outer's own H is an
  // independent design input (outerLevel.params.H), not solved from the
  // child stack, and it stops constraining how many children fit.
  const openTop = !!outerLevel.openTop;
  const openTopOpts = openTop ? {openTop: true, fixedH: outerLevel.params.H} : {};
  // An OPEN tray holds ONE layer of contents: there is no lid to bear a second
  // layer WITHIN the tray — multi-layer stacking happens tray-on-tray on the
  // pallet (chainMetrics' proud-stack height drives that). So the auto enumeration
  // for an open-top outer tier is a single layer deep; without this the ranker
  // picks absurd deep-stack grids (e.g. 1×1×12 cartons towering out of one low
  // tray). Explicit grids the engineer types keep their own nz (their call).
  const autoOpenTopOpts = openTop ? {...openTopOpts, layers: 1} : {};

  // cartons-per-case is a RANGE when the outer link carries countMax > count
  // (auto mode only — an explicit grid pins the count to its own product). Every
  // count in [count..countMax] is enumerated against every arrangement AND, via
  // child.allowedOrientations, every checked vertical axis, and all go into the
  // ONE ranked list. countMax absent or == count reproduces the single-count
  // path exactly (bit-identical). Each candidate is tagged with `.count` — its
  // own cartons-per-case — since the same irreducible grid can serve several
  // counts (e.g. a 2×2×3 case holds 10, 11 or 12), so the count is part of a
  // candidate's identity, not derivable from nx·ny·nz alone.
  const countMin = outerLink.count;
  const countMax = (outerLink.arrangement === 'auto' && outerLink.countMax > countMin) ? outerLink.countMax : countMin;

  const cands = [];
  if(outerLink.arrangement === 'auto'){
    for(let k = countMin; k <= countMax; k++)
      for(const c of parentCandidates(child, k, child.clearance, autoOpenTopOpts))
        if(irreducible(c, k)){ c.count = k; cands.push(c); }
  }else{
    const {nx, ny, nz} = outerLink.arrangement;
    for(const c of parentCandidates(child, nx*ny*nz, child.clearance, {layers: nz, ...openTopOpts}))
      if(c.nx === nx && c.ny === ny){ c.count = nx*ny*nz; cands.push(c); }
  }

  // Pallet solve for a case shape (cavity → geometry → fitInto) is INVARIANT
  // across counts — only the per-pallet multiplier (count) differs — so cache
  // the solved row per unique case shape and re-emit it per count, avoiding a
  // redundant pallet solve for every count that reuses the same grid.
  const rows = [];
  const shapeCache = new Map();   // grid+orientation key -> {cavity, outerGeo, childFit}
  for(const c of cands){
    const shapeKey = `${c.nx}x${c.ny}x${c.layers}:${c.o}`;
    let shape = shapeCache.get(shapeKey);
    if(!shape){
      const cavity = roundCavityUp(c.cavity, step);
      const outerParams = {...outerLevel.params, L: cavity.L, W: cavity.W, H: cavity.H};
      const outerGeo = styleById(outerLevel.styleId).geometry(outerParams, outerLevel.options);
      const childFit = fitChildInOuter(child, cavity, c.o, openTop ? {openTop: true, wantCount: c.nx*c.ny*c.layers} : {});
      shape = {cavity, outerParams, outerGeo, childFit};
      shapeCache.set(shapeKey, shape);
    }
    const row = chainMetrics(project, outerKey, c, shape.cavity, shape.outerParams, shape.outerGeo, childVol, c.count, child);
    rows.push(decorateRow(row, project, below, outerKey, shape.outerGeo, row.casesFit, shape.childFit));
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
  const openTop = !!outerLevel.openTop;
  // the child's orientation into ITS parent is a different rotational
  // relationship than the outermost's own contents — passing it here would
  // wrongly restrict the fit check to whichever orientation the child
  // happened to use, so a level locked at exactly its own solved cavity
  // could spuriously "not fit". Pass none: fitChildInOuter falls back to
  // the child's own allowedOrientations, same as the unlocked path.
  const childFit = fitChildInOuter(child, cavity, null, openTop ? {openTop: true, wantCount: outerLink.count} : {});
  const outerGeo = styleById(outerLevel.styleId).geometry(outerLevel.params, outerLevel.options);
  const childVol = child.outer.L*child.outer.W*child.outer.H;
  const cand = {nx: '—', ny: '—', layers: childFit.layers,
                o: childFit.placements[0] ? childFit.placements[0].orientation : '—'};
  const row = chainMetrics(project, outerKey, cand, cavity, outerLevel.params, outerGeo, childVol, outerLink.count, child);
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
/** The candidate shown when the engineer hasn't explicitly picked a row:
 *  the most-per-pallet arrangement. ONE definition, shared by resolveActiveRow
 *  (what every view renders) and the Build cycle arrows (build.js), so the
 *  arrows' "N of M" position can never disagree with the build actually on
 *  screen before a manual pick. */
export function defaultCandidate(rows){
  return rows.reduce((a, b) => (b.cartonsPerPallet > (a ? a.cartonsPerPallet : -1) ? b : a), null);
}

export function resolveActiveRow(project, rounding = '1mm', selectedKey = null){
  const outerKey = project.primary ? resolveChainShape(project).outermost : 'tertiary';
  const outerLink = linkFor(project, outerKey);
  // the committed chain honours the project's pallet-pattern pick
  // (pallet.patternIndex into the row's ranked list) — the ONE adjustment
  // every consumer of this row sees together (readout, BCT, 2D, DXF, dims)
  if(outerLink.locked) return applyPatternSelection(checkLockedCase(project, rounding), project);
  const rows = candidateCases(project, rounding);
  if(rows.length === 0) return null;
  if(selectedKey){
    const m = rows.find(r => r.nx === selectedKey.nx && r.ny === selectedKey.ny &&
      r.nz === selectedKey.nz && r.orientation === selectedKey.orientation &&
      // cartonsPerCase distinguishes same-grid rows at different counts; older
      // saved keys (pre-range) omit it — match on the rest when it's absent.
      (selectedKey.cartonsPerCase === undefined || r.cartonsPerCase === selectedKey.cartonsPerCase));
    if(m) return applyPatternSelection(m, project);
  }
  return applyPatternSelection(defaultCandidate(rows), project);
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
/** The derived end-seal fields the renderer needs, lifted from the wrap
 *  style's own meta.seal (flowwrap.js owns the computation). Returns {} for a
 *  flexible style that publishes no meta.seal, so the renderer just falls back
 *  to its flush defaults rather than crashing. */
function sealDerived(wrapGeo){
  const s = wrapGeo && wrapGeo.meta && wrapGeo.meta.seal;
  if(!s) return {};
  return {internalAngle: s.internalAngle, externalAngle: s.externalAngle,
          jawClearance: s.jawClearance, sealFlatLength: s.sealFlatLength};
}

/** THE blank area of a style geometry, m². One expression, so the candidate
 *  metric and the per-level cost quantity are provably the same number. */
export const blankAreaM2 = geo => geo.bbox.maxX*geo.bbox.maxY/1e6;

function decorateRow(row, project, below, outerKey, outerGeo, casesFit, childFit, outerFits = true){
  const {primaryResult, secondaryVariant, content} = below;
  // the tray stage's own result rides the row, so every consumer (readout,
  // 3D depth, Dims, STL) reads the ONE solve rather than re-deriving it
  row.tray = below.trayResult || null;
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
    // per-PACK film mass is the base figure (massPer1000g is grams per 1000
    // packs); the per-carton and per-pallet masses are that number times a
    // count, so the three cannot drift. Cost reads this one too.
    row.filmKgPerPack = film.massPer1000g/1e6;
    // per-carton film mass retained so a pattern re-selection can rescale
    // filmKgPerPallet from the new cartonsPerPallet without re-deriving
    row.filmKgPerCarton = requestedForPieces != null
      ? row.filmKgPerPack*requestedForPieces : null;
    row.filmKgPerPallet = row.filmKgPerCarton != null
      ? row.filmKgPerCarton*row.cartonsPerPallet : null;
    row.wrapOuter = primaryResult.geo.outer;
  }else{
    row.filmAreaM2 = null; row.filmKgPerPack = null; row.filmKgPerCarton = null;
    row.filmKgPerPallet = null; row.wrapOuter = null;
  }

  /* ---- material quantities, and the one cost derived from them -----------
   * Cost is a chain-level derived value, computed here with every other
   * derived value, so the rate panel, the per-level readouts and the Build
   * column all read ONE number. Nothing below measures anything: the board
   * areas come from the already-built geometries through the shared
   * blankAreaM2, the film mass off the wrap style's own meta, and the counts
   * off this row. core/cost.js can only multiply.
   *
   * WHAT A PACK IS: one unit of the primary level — a wrap, or the bare
   * collation unit when there is no wrap. `requestedForPieces` is how many of
   * those a carton holds. Without a carton in the chain the case holds packs
   * DIRECTLY, and this row's `cartonsPerCase`/`cartonsPerPallet` already count
   * those packs (the chain re-points the outermost's child), so the pack
   * counts follow the chain shape rather than assuming a carton exists.
   */
  row.cartonBoardM2 = cartonGeo ? blankAreaM2(cartonGeo) : null;
  row.caseBoardM2 = caseGeo ? blankAreaM2(caseGeo) : null;
  row.packsPerCarton = cartonGeo ? requestedForPieces : null;
  row.packsPerPallet = cartonGeo
    ? (requestedForPieces != null ? requestedForPieces*row.cartonsPerPallet : null)
    : row.cartonsPerPallet;
  row.traysPerPack = row.tray ? 1 : 0;
  row.cost = materialCost({
    cartonBoardM2: row.cartonBoardM2, caseBoardM2: row.caseBoardM2,
    filmKgPerPack: row.filmKgPerPack, traysPerPack: row.traysPerPack,
    packsPerCarton: row.packsPerCarton, cartonsPerCase: row.cartonsPerCase,
    packsPerPallet: row.packsPerPallet
  }, project.cost);
  // retained arrangements (single source of truth; the view reads these)
  const p = project.pallet;
  // The perforation is RESOLVED onto the geometry HERE and nowhere else:
  // levelGeometry() reads row.geo, so the 2D dieline, the DXF, the artwork
  // template and the 3D are four readers of one decorated object rather than
  // four places that each remember to ask perf.js. It carries the PERF layer,
  // the SHORTENED creases (never two rules at one coordinate) and the path
  // itself. withPerforation returns the SAME geometry when the level is
  // unperforated, so an unperforated blank is untouched — not a copy that
  // merely compares equal.
  row.geo = {
    case:   withPerforation(caseGeo,   project.tertiary && project.tertiary.perf),
    carton: withPerforation(cartonGeo, project.secondary && project.secondary.perf),
    wrap:   primaryResult ? primaryResult.geo : null
  };
  // The immediate child-unit placements inside the carton, and the collation
  // pieces inside one such unit, are retained WHETHER OR NOT a wrap is present.
  // Without a wrap the child unit is the bare collation envelope (no film) and
  // the piece-level `seals`/`wrapAxis` are null — but the placements and pieces
  // still exist, so the 3D hierarchy can render the product inside a carton/
  // case that has no wrap. (Previously both were gated on the wrap geometry,
  // which blanked the innermost contents the moment the wrap was disabled.)
  // Wrap-present output is unchanged: when primaryResult.geo exists, seals and
  // wrapAxis are populated exactly as before.
  const hasWrapGeo = !!(primaryResult && primaryResult.geo);
  row.arr = {
    cases:   {placements: casesFit.placements, count: casesFit.total, deck: {L: p.L, W: p.W, baseH: p.baseH}},
    cartons: {placements: childFit.placements, count: childFit.total},
    wraps:   (secondaryVariant && secondaryVariant.arrangement)
      ? {placements: secondaryVariant.arrangement.placements, count: secondaryVariant.arrangement.total} : null,
    pieces:  (content && content.collation)
      ? {placements: content.collation.placements, envelope: content.collation.envelope,
         piece: content.config.piece, stackAxis: content.config.stackAxis,
         nx: content.config.nx, ny: content.config.ny,
         wrapAxis: hasWrapGeo ? primaryResult.wrapAxis : null,
         seals: hasWrapGeo
           ? {sealType: primaryResult.wp.sealType, finTreatment: primaryResult.wp.finTreatment,
              finHeight: primaryResult.wp.finHeight, finSealBand: primaryResult.wp.finSealBand,
              endSealWidth: primaryResult.wp.endSealWidth, finFace: primaryResult.wp.finFace || 'bottom',
              gauge: primaryResult.wp.gauge,
              // DERIVED end-seal geometry read straight from the wrap style's
              // own meta.seal — the renderer must not recompute jaw clearance /
              // ramp (single source; flowwrap.js owns the tan()/sin()).
              ...sealDerived(primaryResult.geo)} : null} : null
  };
  return row;
}

/* ---- pallet-load metrics: ONE definition, two callers ------------------
 * chainMetrics (the candidate's own numbers) and applyPatternSelection (the
 * same numbers re-derived for a non-default pattern) computed these with
 * identical expressions 77 lines apart — three quantities with two writers
 * each, free to drift the moment one side is edited. `loadH` in particular is
 * what the pallet render now reads for its stacking height, so a drift here
 * would move pixels as well as readouts. */
const palletLoadH   = (fit, stackH) => fit.layers*stackH;
const deckCoveragePct = (fit, outer, pallet) =>
  Math.round(fit.perLayer*outer.L*outer.W/(pallet.L*pallet.W)*100);
const palletCubeUtilPct = (unitVol, unitCount, pallet, loadH) =>
  loadH > 0 ? Math.round(unitVol*unitCount/(pallet.L*pallet.W*loadH)*100) : 0;

/** Full-chain metrics for the outermost tier (`outerKey`, 'secondary' or
 *  'tertiary') against the pallet — generalizes what was hardcoded to
 *  tertiary. `count` is outerKey's own link.count: cartons/case when the
 *  case is outermost (the default), or content-units/case when secondary is
 *  disabled — either way, the right multiplier to reach a per-pallet total.
 *  When secondary itself is outermost (no case), that multiplier is 1: the
 *  outermost unit IS what's on the pallet, nothing further to multiply. */
function chainMetrics(project, outerKey, cand, cavity, outerParams, outerGeo, childVol, count, child){
  const outerLevel = project[outerKey];
  const p = project.pallet;
  // Effective per-unit stacking height on the pallet. An open-top parent's
  // own outer.H does not bound its contents (they may stand proud of the
  // walls) -- the pallet must stack at whichever is taller: the parent's
  // own outer height, or its immediate child's standing height in the
  // orientation this candidate actually placed it (cand.o), not the
  // child's raw, unoriented L/W/H. Closed styles: openTop is false, this
  // is always outerGeo.outer.H exactly as before -- bit-identical.
  const openTop = !!outerLevel.openTop;
  const childStandingH = child && typeof cand.o === 'string' && cand.o.length === 3
    ? orientDims(child.outer, cand.o).h : (child ? child.outer.H : 0);
  const stackH = openTop && child ? Math.max(outerGeo.outer.H, childStandingH) : outerGeo.outer.H;
  // THE pallet solve: the ranked pattern list (palletpatterns.js), filtered
  // to the selected family. list[0] — the ranked best — is what this row's
  // headline numbers bake in (the Build table ranks candidates by their
  // best pallet); the list rides on the row so applyPatternSelection can
  // re-read list[patternIndex] for the committed chain without re-packing.
  const patternList = palletPatternList(
    {outer: {...outerGeo.outer, H: stackH}, allowedOrientations: outerLevel.allowedOrientations},
    {L: p.L, W: p.W, H: p.maxH - p.baseH},
    outerLevel.clearance,
    p.pattern
  );
  const fit = patternList.length ? patternList[0].build() : emptyArrangement();
  const loadH = palletLoadH(fit, stackH);
  // Shrink-wrap FINISH on the tray: the film draws down over the tray footprint
  // AND its proud contents, so its area needs the loaded (proud) height stackH —
  // known only here, not in the tray geometry (which has no contents). Compute it
  // once and hang it on the geo's meta so the readout (trayReadouts) and the
  // render both read ONE number. A 10% draw-down/overlap allowance, matching the
  // Shrink Bundle style's default. Only when the tray option is on.
  const shrinkOn = !!(outerLevel.options && outerLevel.options.shrink);
  if(shrinkOn){
    const L = outerGeo.outer.L, W = outerGeo.outer.W;
    const surface = 2*L*W + 2*(L + W)*stackH;              // top + bottom + sides to the proud height
    outerGeo.meta.shrinkWrapped = true;
    outerGeo.meta.shrinkFilmM2 = surface*1.10/1e6;         // +10% draw-down allowance
    outerGeo.meta.shrinkLoadedH = stackH;                  // the render skins to this height
  }else if(outerGeo.meta.shrinkWrapped){
    // a cached geo (shapeCache) reused after the option was turned off
    delete outerGeo.meta.shrinkWrapped; delete outerGeo.meta.shrinkFilmM2; delete outerGeo.meta.shrinkLoadedH;
  }
  const perPalletMultiplier = outerKey === 'tertiary' ? count : 1;
  const cartonsPerPallet = fit.total*perPalletMultiplier;
  // the "productive volume" cube-util measures is whatever `cartonsPerPallet`
  // actually counts: the outermost's own CHILD when a multiplier bridges the
  // gap (case counting cartons within it), or the outermost itself when
  // there's no gap to bridge (carton riding the pallet directly)
  const outerVol = outerGeo.outer.L*outerGeo.outer.W*outerGeo.outer.H;
  const unitVol = outerKey === 'tertiary' ? childVol : outerVol;
  return {
    // identity — cartonsPerCase (this candidate's own count) is part of it: the
    // same grid can appear at several counts, so it distinguishes those rows.
    nx: cand.nx, ny: cand.ny, nz: cand.layers, orientation: cand.o, cartonsPerCase: count,
    arrangementLabel: `${cand.nx} × ${cand.ny} × ${cand.layers} ${cand.o}`,
    // the outermost tier
    cavity, caseParams: outerParams,
    outer: outerGeo.outer,
    boardAreaM2: blankAreaM2(outerGeo),
    // the pallet
    casesPerLayer: fit.perLayer,
    caseLayers: fit.layers,
    casesPerPallet: fit.total,
    cartonsPerPallet,
    coveragePct: deckCoveragePct(fit, outerGeo.outer, p),
    // effective per-unit stacking height actually used for the pallet load
    // (== outer.H for closed styles; max(outer.H, child standing height)
    // for an open-top parent whose contents may stand proud of its walls).
    // Exposed so the RENDER stacks at the same pitch the fit used, instead of
    // re-deriving from outer.H (which would let proud-content layers overlap).
    loadH, unitStackH: stackH,
    // cube utilization: total carton volume over the LOAD envelope
    // (deck footprint x load height above the deck, wood excluded) —
    // the freight-driving number
    cubeUtilPct: palletCubeUtilPct(unitVol, cartonsPerPallet, p, loadH),
    casesFit: fit,                           // retained for decorateRow (single source)
    // retained for applyPatternSelection — cycling a pattern recomputes the
    // per-pallet fields from these without re-deriving outerKey/childVol
    patternList, perPalletMultiplier, palletUnitVol: unitVol
  };
}

/**
 * Apply the project's pattern selection (pallet.patternIndex) to a decorated
 * candidate row — the ONE place the committed chain's pallet numbers are
 * re-derived from a non-default pattern. Pure: returns an adjusted shallow
 * copy (the row's own list stays untouched, so the Build table keeps each
 * candidate's ranked-best numbers). Index 0 — the default — returns the row
 * unchanged, bit-identical to the pre-pattern behaviour, since list[0] is
 * exactly what chainMetrics baked in. The index is clamped to the list, so
 * a stale selection (case changed, list shrank) degrades to the nearest
 * valid pick instead of vanishing.
 */
export function applyPatternSelection(row, project){
  const list = row && row.patternList;
  if(!list || !list.length) return row;
  const p = project.pallet;
  const i = Math.max(0, Math.min(list.length - 1, p.patternIndex > 0 ? Math.floor(p.patternIndex) : 0));
  if(i === 0) return row;
  const fit = list[i].build();
  const stackH = row.unitStackH;
  const loadH = palletLoadH(fit, stackH);
  const cartonsPerPallet = fit.total*row.perPalletMultiplier;
  return {
    ...row,
    casesPerLayer: fit.perLayer,
    caseLayers: fit.layers,
    casesPerPallet: fit.total,
    cartonsPerPallet,
    coveragePct: deckCoveragePct(fit, row.outer, p),
    loadH,
    cubeUtilPct: palletCubeUtilPct(row.palletUnitVol, cartonsPerPallet, p, loadH),
    piecesPerPallet: row.piecesPerCarton != null ? row.piecesPerCarton*cartonsPerPallet : row.piecesPerPallet,
    filmKgPerPallet: row.filmKgPerCarton != null ? row.filmKgPerCarton*cartonsPerPallet : row.filmKgPerPallet,
    casesFit: fit,
    arr: {...row.arr, cases: {...row.arr.cases, placements: fit.placements, count: fit.total}}
  };
}

