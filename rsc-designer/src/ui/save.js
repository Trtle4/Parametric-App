/**
 * Two storage layers, kept strictly separate:
 *
 *   FILE (durable, portable, primary) — a downloaded <name>.pkg.json.
 *   This is the format that survives a cache clear, gets emailed, gets
 *   committed to a repo. Every function here that touches a File/Blob
 *   belongs to this layer.
 *
 *   localStorage (convenience only) — autosave + SLOT_COUNT named slots.
 *   Never the source of truth: every access is wrapped so a failure (quota,
 *   private-mode Safari, disabled storage) degrades to "the feature quietly
 *   doesn't work", never to a broken app. hasStorage reports which case
 *   we're in, once, at load.
 */
import {serializeProject, deserializeProject} from '../core/persistence.js';

const AUTOSAVE_KEY = 'rsc-designer:autosave';
const SLOT_KEY = i => `rsc-designer:slot:${i}`;
export const SLOT_COUNT = 10;

function probeStorage(){
  try{
    const k = '__rsc_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  }catch(e){ return false; }
}
export const hasStorage = probeStorage();

function safeGet(key){ if(!hasStorage) return null; try{ return localStorage.getItem(key); }catch(e){ return null; } }
/** Write, and SAY WHY IT FAILED. This used to return a bare `false` for every
 *  failure, and both callers threw that away -- so a project too big for
 *  localStorage produced a Save-to-slot button that did nothing at all, with
 *  no error anywhere, and an autosave that quietly kept an older snapshot.
 *  A convenience that fails is fine; a convenience that fails SILENTLY is
 *  not, because the user cannot tell it from success.
 *  @returns {{ok:boolean, reason:'none'|'unavailable'|'quota'|'error', bytes:number}} */
function safeSet(key, value){
  const bytes = value ? value.length : 0;
  if(!hasStorage) return {ok: false, reason: 'unavailable', bytes};
  try{
    localStorage.setItem(key, value);
    return {ok: true, reason: 'none', bytes};
  }catch(e){
    // QuotaExceededError is the one that matters and the one that actually
    // happens: artwork is stored in the save file, and a few megabytes of it
    // will not fit a ~5MB origin quota. Name it, so the caller can say
    // something useful instead of "didn't work".
    const quota = e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
    return {ok: false, reason: quota ? 'quota' : 'error', bytes};
  }
}
function safeRemove(key){ if(!hasStorage) return; try{ localStorage.removeItem(key); }catch(e){} }

/* ---------------- file layer ---------------- */

/** Serialize `state` and trigger a browser download named `<name>.pkg.json`. */
export function downloadProjectFile(state, name){
  const doc = serializeProject(state);
  const filename = /\.pkg\.json$/i.test(name) ? name : `${name || 'project'}.pkg.json`;
  const blob = new Blob([JSON.stringify(doc, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return doc;
}

/** Parse and migrate/default file text. Throws a plain Error (newer schema,
 *  invalid JSON) for the caller to surface to the user — never guesses. */
export function parseProjectFile(text){
  let raw;
  try{ raw = JSON.parse(text); }
  catch(e){ throw new Error(`not a valid save file (JSON parse failed: ${e.message})`); }
  return deserializeProject(raw);
}

export function readFileAsText(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('could not read file'));
    r.readAsText(file);
  });
}

/* ---------------- localStorage: autosave ---------------- */

let autosaveTimer = null;
/** Debounced autosave. `stateFn` is called at FIRE time (not schedule
 *  time) so it always captures the latest project, not a stale snapshot
 *  from when the timer was set. Best-effort: a write failure is swallowed,
 *  never surfaced as a blocking error — autosave is a convenience. */
export function scheduleAutosave(stateFn, delayMs = 800, onFail){
  if(!hasStorage) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    let res;
    try{ res = safeSet(AUTOSAVE_KEY, JSON.stringify(serializeProject(stateFn()))); }
    catch(e){ res = {ok: false, reason: 'error', bytes: 0}; }
    if(res.ok) return;
    // A FAILED AUTOSAVE MUST NOT LEAVE THE OLD ONE BEHIND. The previous
    // entry is now a snapshot of a project the user has since moved on
    // from -- and startup restores it while announcing "Restored your last
    // session", which presents stale work as current. Losing a restore
    // point is bad; silently restoring the WRONG one and saying it is the
    // right one is worse, because the user has no way to notice.
    safeRemove(AUTOSAVE_KEY);
    if(onFail) onFail(res);
  }, delayMs);
}

/** Cancel a pending (not-yet-fired) autosave without writing it. Needed by
 *  "Discard restored session": loading the fresh default project re-arms
 *  a new autosave via the same "project changed" hook every other edit
 *  uses, which would otherwise silently resurrect an autosave entry a few
 *  hundred ms after the user asked to discard it. */
export function cancelAutosave(){ clearTimeout(autosaveTimer); }

/** Returns the deserialized autosave, or null if there isn't one / it
 *  fails to parse or migrate (a corrupt autosave is discarded quietly,
 *  never crashes startup — it's a convenience cache, not the source of truth). */
export function readAutosave(){
  const raw = safeGet(AUTOSAVE_KEY);
  if(!raw) return null;
  try{ return deserializeProject(JSON.parse(raw)); }
  catch(e){ return null; }
}
export const hasAutosave = () => safeGet(AUTOSAVE_KEY) !== null;
export const clearAutosave = () => safeRemove(AUTOSAVE_KEY);

/* ---------------- localStorage: named slots ---------------- */

/** @returns {{index:number, name:string|null, savedAt:string|null}[]} */
export function listSlots(){
  const out = [];
  for(let i = 1; i <= SLOT_COUNT; i++){
    const raw = safeGet(SLOT_KEY(i));
    if(!raw){ out.push({index: i, name: null, savedAt: null}); continue; }
    try{
      const wrapper = JSON.parse(raw);
      out.push({index: i, name: wrapper.name || null, savedAt: (wrapper.doc && wrapper.doc.savedAt) || null});
    }catch(e){ out.push({index: i, name: null, savedAt: null}); }
  }
  return out;
}
/** @returns safeSet's own {ok, reason, bytes} — CHECK IT. A slot that could
 *  not be written looks exactly like one that was, from the UI, unless the
 *  caller says otherwise. */
export function saveToSlot(i, name, state){
  return safeSet(SLOT_KEY(i), JSON.stringify({name: name || `Slot ${i}`, doc: serializeProject(state)}));
}
/** @returns the deserialized project, or null if the slot is empty/corrupt. */
export function loadFromSlot(i){
  const raw = safeGet(SLOT_KEY(i));
  if(!raw) return null;
  try{
    const wrapper = JSON.parse(raw);
    return deserializeProject(wrapper.doc);
  }catch(e){ return null; }
}
export const clearSlot = i => safeRemove(SLOT_KEY(i));
