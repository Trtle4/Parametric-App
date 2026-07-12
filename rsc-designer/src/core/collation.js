/**
 * The collation model: how pieces group into a bounded envelope that the
 * carton (and everything above it) consumes as a plain box.
 *
 * One parameterization generates every industry pattern — the six named
 * flow-wrap presets are labeled parameter sets over this model, never
 * special cases in code.
 *
 * Coordinate convention matches containment placements: x/y centred on the
 * envelope, z measured up from the envelope bottom. All lengths mm.
 */
import {pieceDims, pieceVolume, validatePiece} from './shape.js';

/**
 * @typedef {Object} Collation
 * @property {import('./shape.js').Piece} piece
 * @property {number} perStack       // pieces in a single stack
 * @property {'X'|'Y'|'Z'} stackAxis // direction the stack runs. Z = vertical.
 * @property {number} nx             // stacks across
 * @property {number} ny             // stacks deep
 * @property {number} stackGap       // mm between stacks
 * @property {number} pieceGap       // mm between pieces within a stack (usually 0)
 */

/**
 * Named presets: parameter sets only. `n` fields marked editable keep the
 * user's current values where the preset doesn't pin them.
 */
export const PRESETS = [
  {id: 'standard',  label: 'Standard',                 set: {perStack: 1, stackAxis: 'Z', nx: 1, ny: 1}},
  {id: 'inline',    label: 'In line',                  set: {perStack: 1, stackAxis: 'Z', ny: 1}},          // nx editable
  {id: 'onedge',    label: 'In line on edge',          set: {stackAxis: 'X', nx: 1, ny: 1}},                // perStack editable
  {id: 'stacked',   label: 'Stacked',                  set: {stackAxis: 'Z', nx: 1, ny: 1}},                // perStack editable
  {id: 'sideby',    label: 'Side by side',             set: {perStack: 1, stackAxis: 'Z'}},                 // nx, ny editable
  {id: 'multi',     label: 'Multiple pieces collated', set: {stackAxis: 'Z'}}                               // all editable
];

/**
 * @param {Collation} c
 * @returns {{envelope: {L:number,W:number,H:number},
 *            placements: {x:number,y:number,z:number, axis:'X'|'Y'|'Z'|null}[],
 *            count: number, fillEfficiency: number}}
 *
 * fillEfficiency is INFORMATIONAL ONLY: it reports product void inside the
 * envelope for the engineer's awareness and must never feed cube
 * utilization, which is defined at the corrugate-on-pallet level.
 */
export function collate(c){
  validatePiece(c.piece);
  const n = Math.max(1, Math.round(c.perStack));
  const nx = Math.max(1, Math.round(c.nx)), ny = Math.max(1, Math.round(c.ny));
  const sg = c.stackGap || 0, pg = c.pieceGap || 0;
  const axis = c.stackAxis;
  if(!['X', 'Y', 'Z'].includes(axis)) throw new Error(`unknown stackAxis "${axis}"`);

  // pieces stack face-to-face along the stack axis; a cylinder's own axis
  // travels with the stack direction (that is what "on edge" means)
  const d = pieceDims(c.piece, c.piece.kind === 'cylinder' ? axis : 'Z');

  // one stack: n pieces pitched along the stack axis
  const stack = {x: d.x, y: d.y, z: d.z};
  const ax = axis.toLowerCase();
  stack[ax] = n*d[ax] + (n - 1)*pg;

  // stacks arrayed in plan (nx across, ny deep)
  const envelope = {
    L: nx*stack.x + (nx - 1)*sg,
    W: ny*stack.y + (ny - 1)*sg,
    H: stack.z
  };

  const placements = [];
  const pitch = d[ax] + pg;
  for(let iy = 0; iy < ny; iy++) for(let ix = 0; ix < nx; ix++){
    // stack centre in plan (cell-centred, same convention as pack.js)
    const sx = (ix + 0.5)*(stack.x + sg) - nx*(stack.x + sg)/2;
    const sy = (iy + 0.5)*(stack.y + sg) - ny*(stack.y + sg)/2;
    for(let k = 0; k < n; k++){
      const p = {x: sx, y: sy, z: stack.z/2, axis: c.piece.kind === 'cylinder' ? axis : null};
      if(ax === 'x') p.x = sx - stack.x/2 + d.x/2 + k*pitch;
      if(ax === 'y') p.y = sy - stack.y/2 + d.y/2 + k*pitch;
      if(ax === 'z') p.z = d.z/2 + k*pitch;
      placements.push(p);
    }
  }

  const count = n*nx*ny;
  const envVol = envelope.L*envelope.W*envelope.H;
  return {
    envelope, placements, count,
    fillEfficiency: envVol > 0 ? count*pieceVolume(c.piece)/envVol : 0
  };
}

/**
 * Plain-language label for how a collation enters a carton in a given
 * containment orientation — the engineer must see at a glance which way
 * the stacks run. The axis-mapping code is shown alongside by the UI, so
 * this stays traceable rather than hidden.
 * @param {'X'|'Y'|'Z'} stackAxis
 * @param {string} orientation  e.g. 'LWH' (envelope axis -> carton L/W/vertical)
 */
export function orientationLabel(stackAxis, orientation){
  const envAxis = {X: 'L', Y: 'W', Z: 'H'}[stackAxis];   // envelope axis the stacks run along
  const slot = orientation.indexOf(envAxis);              // where that axis lands in the carton
  const where = slot === 2 ? 'Stacks upright'
              : slot === 0 ? 'Stacks lengthwise in the carton'
              :              'Stacks crosswise in the carton';
  if(slot === 2){
    // distinguish the transposed twin (same upright stacks, envelope turned):
    // the twin whose first in-plane axis comes later in L<W<H order is "turned"
    const rank = {L: 0, W: 1, H: 2};
    return where + (rank[orientation[0]] > rank[orientation[1]] ? ', envelope turned 90°' : '');
  }
  const upFace = orientation[2];
  return where + (upFace === 'H' ? '' : `, ${upFace === 'L' ? 'length' : 'width'} face up`);
}
