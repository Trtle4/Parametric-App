/**
 * Two storage layers, kept strictly separate:
 *
 *   FILE (durable, portable, primary) — a downloaded <name>.pkg.json.
 *   This is the format that survives a cache clear, gets emailed, gets
 *   committed to a repo. Every function here that touches a File/Blob
 *   belongs to this layer.
 *
 *   localStorage (convenience only) — autosave + five named slots. Never
 *   the source of truth: every access is wrapped so a failure (quota,
 *   private-mode Safari, disabled storage) degrades to "the feature quietly
 *   doesn't work", never to a broken app. hasStorage reports which case
 *   we're in, once, at load.
 */
import {serializeProject, deserializeProject} from '../core/persistence.js';

const AUTOSAVE_KEY = 'rsc-designer:autosave';
const SLOT_KEY = i => `rsc-designer:slot:${i}`;
export const SLOT_COUNT = 5;

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
function safeSet(key, value){ if(!hasStorage) return false; try{ localStorage.setItem(key, value); return true; }catch(e){ return false; } }
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
export function scheduleAutosave(stateFn, delayMs = 800){
  if(!hasStorage) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try{ safeSet(AUTOSAVE_KEY, JSON.stringify(serializeProject(stateFn()))); }
    catch(e){ /* best-effort */ }
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
