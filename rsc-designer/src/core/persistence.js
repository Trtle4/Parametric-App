/**
 * The save document: one JSON object representing the whole Project, with
 * nothing derived in it (no geometry, no arrangements, no candidate table —
 * those are recomputed on load by the same code path that computes them
 * from any live edit). Saving derived values would create a second source
 * of truth, which containment/project's own history has already paid for
 * once (see the retained-arrangement rework this codebase went through).
 *
 * schemaVersion/migration handling lives in schemaMigrations.js; this
 * module owns the document shape itself and the defaulting/preservation
 * rules for loading an imperfect (older, hand-edited, or partially
 * corrupted) file:
 *   - a field ABSENT from the loaded doc is "missing" -> filled from
 *     newProject()'s defaults for that path, and reported.
 *   - a field explicitly `null` (a disabled primary or wrap) is a real
 *     value, not missing -> preserved exactly, never defaulted.
 *   - a field present in the loaded doc but not part of the current
 *     schema is "unknown" -> preserved through the round trip untouched.
 */
import {newProject, styleOpenTopDefault} from './project.js';
import {migrate, CURRENT_SCHEMA_VERSION} from './schemaMigrations.js';

const APP_VERSION = 'rsc-designer-dev';   // human reference only, never used for logic

const clone = x => JSON.parse(JSON.stringify(x));

/**
 * @param {Object} state
 * @param {Object} state.project        the live project (primary/secondary/tertiary/pallet/links)
 * @param {string} state.rounding       ROUNDING key, e.g. '1mm'
 * @param {Object|null} state.selectedCandidate  {nx,ny,nz,orientation} identifying the picked
 *        row, re-matched against a freshly recomputed candidate list on load — never the row
 *        itself, which carries derived geometry
 * @param {string} state.unit           display length unit, 'mm'|'in'
 * @param {string} state.palUnit        pallet-field display unit, 'mm'|'in'
 * @returns {Object} the save document, ready for JSON.stringify
 */
export function serializeProject({project, rounding, selectedCandidate, unit, palUnit}){
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    project: clone(project),
    rounding,
    selectedCandidate: selectedCandidate ? clone(selectedCandidate) : null,
    display: {unit, palUnit}
  };
}

/**
 * Recursively fill `loaded` from `defaults` for every key `defaults` has.
 * - `loaded === undefined` (key absent): defaulted, reported at `path`.
 * - `loaded === null` or `defaults === null`: a deliberate value, kept as-is.
 * - arrays: presence/absence only — no element-wise merge (that's handled
 *   specially for `links`, the one array of non-uniform objects; plain
 *   lists like allowedOrientations are meant to be replaced wholesale).
 * - a `loaded` value whose own type isn't a plain object (e.g. the
 *   discriminated-union arrangement field, 'auto' vs {nx,ny,nz}) is kept
 *   as-is even when `defaults` is shaped as an object — spreading a string
 *   here would fabricate numeric-index junk keys and misreport every
 *   object field as "missing".
 * - anything present in `loaded` that ISN'T in `defaults` rides through in
 *   the `{...loaded}` spread untouched: unknown-field preservation.
 */
function mergeDefaults(loaded, defaults, path, report){
  if(loaded === undefined){
    report.push(path);
    return clone(defaults);
  }
  if(loaded === null || defaults === null) return loaded;
  if(Array.isArray(defaults)) return loaded;
  if(typeof defaults !== 'object') return loaded;
  if(typeof loaded !== 'object' || Array.isArray(loaded)) return loaded;
  const out = {...loaded};
  for(const k of Object.keys(defaults))
    out[k] = mergeDefaults(loaded[k], defaults[k], path ? `${path}.${k}` : k, report);
  return out;
}

/** `links` is a fixed-length array of small, individually-meaningful
 *  objects (the tertiary->secondary and secondary->primary relationships) —
 *  merged element-wise by position rather than treated as an opaque leaf,
 *  so a link missing e.g. `locked` still gets a usable default instead of
 *  candidateCases() seeing `undefined`. */
function mergeLinks(loaded, defaults, report){
  if(loaded === undefined){ report.push('links'); return clone(defaults); }
  if(!Array.isArray(loaded)) return loaded;
  return defaults.map((d, i) => loaded[i] === undefined
    ? (report.push(`links[${i}]`), clone(d))
    : mergeDefaults(loaded[i], d, `links[${i}]`, report));
}

// canonical per-kind piece shapes, used only to pick the RIGHT default shape
// for collation.piece before merging — see the comment at the call site.
const PIECE_DEFAULTS = {
  box: {kind: 'box', L: 90, W: 50, H: 20},
  cylinder: {kind: 'cylinder', diameter: 50, thickness: 6}
};

/** Fill missing fields of a loaded project from newProject()'s defaults,
 *  reporting every path that was defaulted. Returns a project shaped
 *  exactly like the live model (primary/wrap stay null when the loaded
 *  doc says so — "enabled" is expressed by null-vs-object, not a separate
 *  flag, matching the live model project.js already uses everywhere). */
function fillProjectDefaults(loadedProject){
  const report = [];
  const base = newProject();
  if(loadedProject === undefined || loadedProject === null){
    report.push('project');
    return {project: base, defaulted: report};
  }
  const out = {...loadedProject};

  for(const level of ['primary', 'secondary', 'tertiary']){
    const loadedLevel = loadedProject[level];
    if(loadedLevel === undefined){ report.push(level); out[level] = clone(base[level]); continue; }
    if(loadedLevel === null){ out[level] = null; continue; }         // primary disabled deliberately

    let baseForLevel = base[level];
    if(level === 'primary'){
      // collation.piece is a discriminated union (box vs cylinder). Shape
      // the DEFAULT to match the loaded piece's own kind before merging,
      // rather than merging against newProject()'s (box) default and
      // patching afterward — patching after the fact would still leave
      // the generic pass's bogus box-shaped reports (a defaulted "L", "W",
      // "H" for what is actually a cylinder) sitting in `report`.
      const kind = loadedLevel.collation && loadedLevel.collation.piece && loadedLevel.collation.piece.kind;
      const pieceDefault = PIECE_DEFAULTS[kind] || PIECE_DEFAULTS.box;
      // `box` (a plain product envelope) is null-by-default like `wrap` —
      // mergeDefaults short-circuits null-vs-null and preserves any real
      // value untouched, so a full shape here only matters when the loaded
      // doc actually has a box, filling ITS missing L/W/H rather than
      // leaving them undefined.
      const boxDefault = loadedLevel.box ? {L: 90, W: 50, H: 20} : null;
      baseForLevel = {...base.primary, collation: {...base.primary.collation, piece: pieceDefault}, box: boxDefault};
    }
    const merged = mergeDefaults(loadedLevel, baseForLevel, level, report);
    // openTop's correct default depends on THIS level's own styleId (a
    // tray defaults open, an RSC doesn't) — not on newProject()'s template
    // style, which the generic merge above just filled in blindly.
    if(loadedLevel.openTop === undefined && merged.styleId)
      merged.openTop = styleOpenTopDefault(merged.styleId);
    out[level] = merged;
  }
  out.pallet = mergeDefaults(loadedProject.pallet, base.pallet, 'pallet', report);
  out.links = mergeLinks(loadedProject.links, base.links, report);
  // top-level scalars (printText, …): defaulted if absent, preserved if present
  if(loadedProject.printText === undefined){ report.push('printText'); out.printText = base.printText; }
  return {project: out, defaulted: report};
}

/**
 * Load a save document: migrate to the current schema (throws a plain
 * Error, refusing outright, if the file is newer than this app supports),
 * then fill any missing fields from defaults.
 * @param {Object} rawDoc  JSON.parse'd file contents
 * @returns {{project, rounding, selectedCandidate, unit, palUnit, migrationsRun: string[], defaulted: string[]}}
 */
export function deserializeProject(rawDoc){
  const {doc, log: migrationsRun} = migrate(rawDoc);
  const {project, defaulted} = fillProjectDefaults(doc.project);
  const rounding = doc.rounding || '1mm';
  const selectedCandidate = doc.selectedCandidate || null;
  const unit = (doc.display && doc.display.unit) || 'mm';
  const palUnit = (doc.display && doc.display.palUnit) || 'in';
  return {project, rounding, selectedCandidate, unit, palUnit, migrationsRun, defaulted};
}
