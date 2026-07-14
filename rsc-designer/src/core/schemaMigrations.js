/**
 * Save-file schema versioning and migrations.
 *
 * THE RULE: once a schema version ships, its on-disk shape is FROZEN. A
 * later change that needs a new field, a renamed field, or a different
 * meaning for an existing field bumps CURRENT_SCHEMA_VERSION and adds a
 * migration function from the previous version to the new one — it never
 * edits what an existing version's fields mean in place. An old save file
 * must always mean today what it meant the day it was written, all the way
 * up the migration chain.
 *
 * This is enforced by test/saveload.test.html against the fixtures
 * committed in test/fixtures/: every fixture must keep loading, migrating,
 * and reproducing its hand-checked chain values forever. If a change
 * cannot preserve an old fixture, that is a deliberate breaking change —
 * it has to be raised, not silently absorbed by editing the fixture to
 * match.
 */

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * One entry per version step. `migrate` receives and returns a plain
 * object shaped like the SAVE DOCUMENT (the {schemaVersion, appVersion,
 * savedAt, project, ...} envelope) — a migration may move fields between
 * the envelope and the project if that's what the version bump requires.
 * Pure function: no DOM, no global state, no side effects beyond its
 * return value.
 *
 * @typedef {Object} Migration
 * @property {number} from
 * @property {number} to
 * @property {(doc: Object) => Object} migrate
 * @property {string} describe  plain-language summary, surfaced in the load log
 */
export const MIGRATIONS = [
  // v1 is the first schema — nothing to migrate from yet. When v2 ships,
  // add: {from: 1, to: 2, migrate: doc => ({...}), describe: '...'}
];

/**
 * Bring `doc` up to CURRENT_SCHEMA_VERSION by running every migration in
 * the chain from its own version forward, in sequence.
 *
 * - A file at exactly the current version passes through untouched (no
 *   migrations run, empty log).
 * - A file older than current runs each migration in order; the returned
 *   log names every step, so a silent success is still visible on request,
 *   never silently invisible.
 * - A file NEWER than this app supports is refused outright — the app does
 *   not guess at an unknown future shape. The thrown error names both
 *   versions and tells the user to update the app.
 *
 * @param {Object} doc  the raw parsed save document
 * @returns {{doc: Object, log: string[]}}
 */
export function migrate(doc){
  if(doc === null || typeof doc !== 'object')
    throw new Error('save file is not a JSON object — cannot load');
  if(typeof doc.schemaVersion !== 'number' || !Number.isInteger(doc.schemaVersion))
    throw new Error('save file has no valid schemaVersion — cannot load');
  if(doc.schemaVersion > CURRENT_SCHEMA_VERSION)
    throw new Error(
      `This file is schema v${doc.schemaVersion}; this app only understands up to v${CURRENT_SCHEMA_VERSION}. ` +
      `Update the app to open it — refusing to guess at a newer save format.`);

  let cur = doc, version = doc.schemaVersion;
  const log = [];
  while(version < CURRENT_SCHEMA_VERSION){
    const step = MIGRATIONS.find(m => m.from === version);
    if(!step)
      throw new Error(`No migration registered from schema v${version} to reach v${CURRENT_SCHEMA_VERSION} — cannot load.`);
    cur = step.migrate(cur);
    log.push(`v${step.from} -> v${step.to}: ${step.describe}`);
    version = step.to;
  }
  return {doc: {...cur, schemaVersion: CURRENT_SCHEMA_VERSION}, log};
}
