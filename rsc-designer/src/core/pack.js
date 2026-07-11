/**
 * Rectangle layer-fit solver: the 2D fit primitives under core/containment.js.
 * Fits axis-aligned child rectangles into a parent rectangle, and stacks
 * layers up to a height budget.
 *
 * Deliberately generic: no knowledge of pallets, boxes, or timber. All
 * candidates are floor-fitted and centred, so nothing can exceed the
 * parent extents. All lengths in mm.
 *
 * Clearance model: `wall` is the minimum child-to-parent gap, `between`
 * the minimum child-to-child gap. Internally each child cell is expanded
 * by `between` and the parent shrunk by `2*wall - between`, which makes
 *   N*child + (N-1)*between <= parent - 2*wall
 * exactly equivalent to N*cell <= effectiveParent. Cell centres are child
 * centres, so positions come out correct and the arrangement stays centred.
 * With wall = between = 0 the math is bit-identical to the pre-clearance
 * version.
 */

/**
 * @param {Object} o
 * @param {number} o.childL   child footprint length (x when not rotated)
 * @param {number} o.childW   child footprint width  (y when not rotated)
 * @param {number} o.parentL  parent extent along x
 * @param {number} o.parentW  parent extent along y
 * @param {'optimal'|'column'|'interlock'} o.pattern
 * @param {number} [o.wall=0]     child-to-parent clearance
 * @param {number} [o.between=0]  child-to-child clearance
 * @param {boolean} [o.allowRotate=true]  may children rotate 90° in plane?
 * @returns {{positions: {x:number,y:number,rot:boolean}[], perLayer: number, label: string}}
 */
export function packLayer({childL, childW, parentL, parentW, pattern, wall = 0, between = 0, allowRotate = true}){
  const PL = parentL - 2*wall + between, PW = parentW - 2*wall + between; // effective parent
  const CL = childL + between,           CW = childW + between;           // cell sizes
  const square = CL === CW;

  // uniform grid, cell footprint a×b (x×y); rot flags the 90-degree orientation
  const colGrid = (a, b, rot) => {
    const nx = Math.floor(PL/a), ny = Math.floor(PW/b), out = [];
    for(let i=0;i<nx;i++) for(let j=0;j<ny;j++)
      out.push({x:(i+0.5)*a - nx*a/2, y:(j+0.5)*b - ny*b/2, rot: rot && !square});
    return {positions: out, label: `${nx} × ${ny}${rot && !square ? ' rotated' : ''} grid`};
  };
  const gA = colGrid(CL, CW, false);

  // a single legal in-plane orientation: every pattern degenerates to the grid
  if(!allowRotate) return {positions: gA.positions, perLayer: gA.positions.length, label: gA.label};

  const gB = colGrid(CW, CL, true);
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
        const rotA = a !== CL && !square;    // block-1 orientation
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
    fam(PL, PW, CL, CW, false); fam(PL, PW, CW, CL, false);
    fam(PW, PL, CL, CW, true);  fam(PW, PL, CW, CL, true);
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
 * @param {number} [o.wall=0]     child-to-parent clearance (top & bottom)
 * @param {number} [o.between=0]  layer-to-layer clearance
 * @returns {{layers: number, total: number, loadHeight: number}}
 */
export function stack({perLayer, childH, parentMaxH, baseH, wall = 0, between = 0}){
  const budget = parentMaxH - baseH - 2*wall + between;
  const layers = perLayer > 0 ? Math.max(0, Math.floor(budget/(childH + between))) : 0;
  const loadHeight = baseH + (layers > 0 ? 2*wall + layers*childH + (layers - 1)*between : 0);
  return {layers, total: perLayer*layers, loadHeight};
}
