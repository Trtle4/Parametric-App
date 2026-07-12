/**
 * Flow wrap "fold": film has no panel-and-hinge fold sequence — the wrapped
 * pack is a continuous sealed surface. The builder contributes no open
 * parts and no flaps; fold3d's generic closed shell + print decal IS the
 * representation, shown immediately (app jumps the fold to closed).
 */
export function flowwrapFold(){
  return {parts: [], flaps: [], closedExtras: []};
}
