/**
 * Rectangle layer-fit solver. Fits axis-aligned child rectangles into a
 * parent rectangle, and stacks layers up to a height budget.
 *
 * Deliberately generic: no knowledge of pallets, boxes, or timber. All
 * candidates are floor-fitted and centred, so nothing can exceed the
 * parent extents. All lengths in mm.
 */

/**
 * @param {Object} o
 * @param {number} o.childL   child footprint length (x when not rotated)
 * @param {number} o.childW   child footprint width  (y when not rotated)
 * @param {number} o.parentL  parent extent along x
 * @param {number} o.parentW  parent extent along y
 * @param {'optimal'|'column'|'interlock'} o.pattern
 * @returns {{positions: import('./types.js').LayerPosition[], perLayer: number, label: string}}
 */
export function packLayer({childL, childW, parentL, parentW, pattern}){
  const square = childL === childW;

  // uniform grid, footprint a×b (x×y); rot flags the 90-degree orientation
  const colGrid = (a, b, rot) => {
    const nx = Math.floor(parentL/a), ny = Math.floor(parentW/b), out = [];
    for(let i=0;i<nx;i++) for(let j=0;j<ny;j++)
      out.push({x:(i+0.5)*a - nx*a/2, y:(j+0.5)*b - ny*b/2, rot: rot && !square});
    return {positions: out, label: `${nx} × ${ny}${rot && !square ? ' rotated' : ''} grid`};
  };
  const gA = colGrid(childL, childW, false), gB = colGrid(childW, childL, true);
  const column = gA.positions.length >= gB.positions.length ? gA : gB;

  // two-block guillotine: k strips of a×b along one axis, remainder rotated
  const mixed = () => {
    let best = column;
    const fam = (U, V, a, b, swap) => {
      const rows = Math.floor(V/b), n2v = Math.floor(V/a);
      for(let k=0; k<=Math.floor(U/a); k++){
        const n2u = Math.floor((U - k*a)/b);
        const n1 = k*rows, n2 = n2u*n2v;
        if(n1 + n2 <= best.positions.length) continue;
        const maxU = k*a + n2u*b, positions = [];
        const rotA = a !== childL && !square;    // block-1 orientation
        for(let i=0;i<k;i++) for(let j=0;j<rows;j++){
          const u = (i+0.5)*a - maxU/2, v = (j+0.5)*b - rows*b/2;
          positions.push(swap ? {x:v, y:u, rot: !rotA && !square} : {x:u, y:v, rot: rotA});
        }
        for(let i=0;i<n2u;i++) for(let j=0;j<n2v;j++){
          const u = k*a + (i+0.5)*b - maxU/2, v = (j+0.5)*a - n2v*a/2;
          positions.push(swap ? {x:v, y:u, rot: rotA} : {x:u, y:v, rot: !rotA && !square});
        }
        best = {positions, label: `${n1}+${n2} mixed`};
      }
    };
    fam(parentL, parentW, childL, childW, false); fam(parentL, parentW, childW, childL, false);
    fam(parentW, parentL, childL, childW, true);  fam(parentW, parentL, childW, childL, true);
    return best;
  };

  const layer = pattern === 'column' ? column : mixed();
  return {positions: layer.positions, perLayer: layer.positions.length, label: layer.label};
}

/**
 * @param {Object} o
 * @param {number} o.perLayer     children per layer (0 -> no stack)
 * @param {number} o.childH      child height
 * @param {number} o.parentMaxH  total height budget, including the base
 * @param {number} o.baseH       height consumed by the base (e.g. a deck)
 * @returns {{layers: number, total: number, loadHeight: number}}
 */
export function stack({perLayer, childH, parentMaxH, baseH}){
  const layers = perLayer > 0 ? Math.max(0, Math.floor((parentMaxH - baseH)/childH)) : 0;
  return {layers, total: perLayer*layers, loadHeight: baseH + layers*childH};
}
