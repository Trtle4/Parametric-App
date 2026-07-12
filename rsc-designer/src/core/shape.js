/**
 * Piece shapes — the product itself. This module and core/collation.js are
 * the ONLY places in the codebase that may know a non-rectangular shape
 * exists. Collation resolves every shape into a rectangular envelope;
 * nothing above it (containment, project, styles, renderers of upper
 * levels) sees anything but a box. All lengths mm.
 */

/** @typedef {{kind:'box', L:number, W:number, H:number}} BoxPiece */
/** @typedef {{kind:'cylinder', diameter:number, thickness:number}} CylinderPiece
 *  thickness is the AXIAL dimension: a biscuit's thickness, a puck's height. */
/** @typedef {BoxPiece|CylinderPiece} Piece */

/**
 * The piece's own bounding dims when its nominal axes align with X/Y/Z.
 * A cylinder's nominal axis is Z (lying flat like a puck): diameter in X
 * and Y, thickness in Z. Axis reorientation happens in collation, where
 * the stack direction carries the cylinder axis with it.
 * @param {Piece} p
 * @param {'X'|'Y'|'Z'} [axis='Z']  cylinder axis direction
 * @returns {{x:number, y:number, z:number}}
 */
export function pieceDims(p, axis = 'Z'){
  if(p.kind === 'box') return {x: p.L, y: p.W, z: p.H};
  const d = p.diameter, t = p.thickness;
  return axis === 'X' ? {x: t, y: d, z: d}
       : axis === 'Y' ? {x: d, y: t, z: d}
       :                {x: d, y: d, z: t};
}

/** @param {Piece} p @returns {number} mm³ */
export function pieceVolume(p){
  return p.kind === 'box'
    ? p.L*p.W*p.H
    : Math.PI*(p.diameter/2)**2*p.thickness;
}

export function validatePiece(p){
  if(p.kind === 'box'){
    if(!(p.L > 0 && p.W > 0 && p.H > 0)) throw new Error('box piece needs positive L/W/H');
  }else if(p.kind === 'cylinder'){
    if(!(p.diameter > 0 && p.thickness > 0)) throw new Error('cylinder piece needs positive diameter/thickness');
  }else{
    throw new Error(`unknown piece kind "${p.kind}"`);
  }
}
