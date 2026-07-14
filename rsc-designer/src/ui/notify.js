/**
 * The single "project changed" notification registry.
 *
 * Before this module, refreshing after an edit meant a hand-maintained list
 * of function calls (onProjectEdited in app.js). Every consumer missing from
 * that list went stale silently, and it happened twice: once for the rails'
 * own "Dimensions" boxes, once for the 3D hierarchy view (which read a
 * build.js row cache nothing told to recompute). A list like that cannot be
 * completed by inspection — it can only be completed by removing the need
 * for it.
 *
 * So there is no list here. A display that reads project/chain state calls
 * onRefresh(name, fn) once, at its own definition site, to register its own
 * refresher. Adding a new display never means finding and editing a shared
 * call list — refreshAll() just runs whatever is currently registered.
 *
 * `name` makes re-registration idempotent (a Map, not a Set/array): a
 * consumer that re-registers under the same name replaces its own prior
 * entry instead of accumulating a second copy, which matters for anything
 * that might be wired more than once (defensive; nothing here currently
 * re-registers after startup).
 */
const refreshers = new Map();

/** Register (or replace) a named refresher. */
export function onRefresh(name, fn){ refreshers.set(name, fn); }

/** Remove a named refresher — for a display that can stop existing. */
export function offRefresh(name){ refreshers.delete(name); }

// reentrancy guard: no registered refresher may itself trigger a nested
// refreshAll() — none currently do (every refresher only READS project/
// chain state), but this is the kind of assumption that should fail loudly
// (a silent no-op skip) rather than blow the stack if it's ever violated.
let running = false;

/** Run every registered refresher, in registration order. This is the
 *  second half of "one recompute() resolves the chain and notifies every
 *  registered consumer" — see build.recompute(), which calls this as its
 *  own last step so nothing that mutates the project has to remember to
 *  call this separately. */
export function refreshAll(){
  if(running) return;
  running = true;
  try{ for(const fn of refreshers.values()) fn(); }
  finally{ running = false; }
}
