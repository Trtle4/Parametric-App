/**
 * The containment model: every level of the packaging hierarchy is the same
 * relationship — a parent holds N children, arranged in a pattern, with
 * clearances and orientation limits. This module builds that once.
 *
 * Knows nothing about pallets, boxes, timber, or the DOM. All lengths mm.
 *
 * Axes: a cavity has L (x), W (y) and H (z, vertical). Placements are
 * cavity-centred in plane; z is measured up from the cavity floor to the
 * child centre. Renderers map (x, y, z) -> (world x, world z, world y).
 */
import {packLayer, stack} from './pack.js';

/**
 * @typedef {import('./types.js').Dims} Dims
 */

/**
 * Orientation 'ABC': child axis A lies along cavity L, B along cavity W,
 * C along cavity H (vertical). This is packaging domain data, declared per
 * level — the solver only tries a child's allowedOrientations and NEVER
 * defaults to all six.
 * @typedef {'LWH'|'WLH'|'LHW'|'HLW'|'WHL'|'HWL'} Orientation
 */
export const ORIENTATIONS = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'];

/**
 * @typedef {Object} Child
 * @property {Dims} outer            // mm, the compensated external envelope
 * @property {Orientation[]} allowedOrientations
 * @property {string} [styleId]
 */

/**
 * @typedef {Object} Cavity          // the space available inside a parent
 * @property {number} L @property {number} W
 * @property {number|null} H         // null = unbounded (solve for it)
 */

/**
 * @typedef {Object} Clearance       // mm, per level
 * @property {number} wall           // child to parent inner wall, LATERAL faces
 * @property {number} between        // child to child, in plane
 * @property {number} [bottom]       // under the first layer (default: wall — legacy uniform)
 * @property {number} [top]          // headspace above the last layer (default: wall)
 * @property {number} [betweenZ]     // layer to layer (default: between)
 *
 * Vertical clearance is not the same animal as lateral: children normally
 * bear directly on the parent floor (bottom = 0) and headspace is a
 * deliberate design parameter. The legacy uniform shape (wall/between on
 * every axis) is preserved when the vertical fields are omitted.
 */
function normClearance(c){
  const wall = c.wall || 0, between = c.between || 0;
  return {
    wall, between,
    bottom:   c.bottom   !== undefined ? c.bottom   : wall,
    top:      c.top      !== undefined ? c.top      : wall,
    betweenZ: c.betweenZ !== undefined ? c.betweenZ : between
  };
}

/**
 * @typedef {Object} Placement
 * @property {number} x @property {number} y   // cavity-centred, in plane
 * @property {number} z                        // child centre above cavity floor
 * @property {Orientation} orientation
 */

/**
 * @typedef {Object} Arrangement
 * @property {Placement[]} placements  // capped at PLACEMENT_CAP; counts stay exact
 * @property {number} perLayer
 * @property {number} layers
 * @property {number} total
 * @property {Dims} envelope           // bounding box the arrangement actually occupies
 * @property {number} utilization      // volumetric
 * @property {string} label
 */

/** Placements are for rendering/inspection; the numeric fields are the
 *  authoritative counts. Keeps absurd inputs from allocating millions. */
const PLACEMENT_CAP = 20000;

/** Map a child's outer dims through an orientation. */
export function orientDims(outer, o){
  return {l: outer[o[0]], w: outer[o[1]], h: outer[o[2]]};
}

const transpose = o => o[1] + o[0] + o[2];   // swap in-plane axes, same vertical

function validateOrientations(list){
  if(!Array.isArray(list) || list.length === 0)
    throw new Error('Child.allowedOrientations is required and non-empty — orientation limits are per level, never defaulted');
  for(const o of list)
    if(!ORIENTATIONS.includes(o)) throw new Error(`unknown orientation "${o}"`);
}

/**
 * Group allowed orientations that share a vertical axis: a transposed pair
 * (e.g. LWH + WLH) is one packLayer call with in-plane rotation allowed;
 * a lone orientation forbids rotation.
 */
function orientationGroups(allowed){
  const groups = [], seen = new Set();
  for(const o of allowed){
    if(seen.has(o)) continue;
    seen.add(o);
    const t = transpose(o);
    const paired = allowed.includes(t);
    if(paired) seen.add(t);
    groups.push({base: o, allowRotate: paired});
  }
  return groups;
}

/**
 * Fit children into a FIXED parent cavity.
 * @param {Child} child
 * @param {Cavity} cavity            // H must be bounded here
 * @param {Clearance} [clearance]
 * @param {'optimal'|'column'|'interlock'} [pattern]
 * @returns {Arrangement}
 */
export function fitInto(child, cavity, clearance = {wall: 0, between: 0}, pattern = 'optimal'){
  validateOrientations(child.allowedOrientations);
  if(cavity.H == null)
    throw new Error('fitInto needs a bounded cavity height; use solveParent to size a parent');
  const {wall, between, bottom, top, betweenZ} = normClearance(clearance);

  // try each vertical-axis group; keep the best total (first group wins ties)
  let best = null;
  for(const grp of orientationGroups(child.allowedOrientations)){
    const {l, w, h} = orientDims(child.outer, grp.base);
    const layer = packLayer({childL: l, childW: w, parentL: cavity.L, parentW: cavity.W,
                             pattern, wall, between, allowRotate: grp.allowRotate});
    const st = stack({perLayer: layer.perLayer, childH: h, parentMaxH: cavity.H, baseH: 0,
                      between: betweenZ, gapBelow: bottom, gapAbove: top});
    if(!best || st.total > best.st.total) best = {grp, dims: {l, w, h}, layer, st};
  }
  const {grp, dims, layer, st} = best;

  // expand layers into placements; interlock mirrors odd layers (180° turn)
  const placements = [];
  outer: for(let ly = 0; ly < st.layers; ly++){
    const flip = pattern === 'interlock' && (ly & 1);
    const z = bottom + dims.h/2 + ly*(dims.h + betweenZ);
    for(const p of layer.positions){
      if(placements.length >= PLACEMENT_CAP) break outer;
      placements.push({
        x: flip ? -p.x : p.x,
        y: flip ? -p.y : p.y,
        z,
        orientation: p.rot ? transpose(grp.base) : grp.base
      });
    }
  }

  // envelope actually occupied (from the layer footprints + stack height)
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for(const p of layer.positions){
    const fx = p.rot ? dims.w : dims.l, fy = p.rot ? dims.l : dims.w;
    minX = Math.min(minX, p.x - fx/2); maxX = Math.max(maxX, p.x + fx/2);
    minY = Math.min(minY, p.y - fy/2); maxY = Math.max(maxY, p.y + fy/2);
  }
  const envelope = st.layers > 0 && layer.perLayer > 0
    ? {L: maxX - minX, W: maxY - minY, H: st.layers*dims.h + (st.layers - 1)*betweenZ}
    : {L: 0, W: 0, H: 0};

  const childVol = child.outer.L*child.outer.W*child.outer.H;
  const cavityVol = cavity.L*cavity.W*cavity.H;
  return {
    placements,
    perLayer: layer.perLayer,
    layers: st.layers,
    total: st.total,
    envelope,
    utilization: cavityVol > 0 ? st.total*childVol/cavityVol : 0,
    label: layer.label
  };
}

/**
 * Size a parent cavity around N children (bottom-up design: product drives
 * primary, primary count drives carton, carton count drives case).
 *
 * @param {Child} child
 * @param {number} count
 * @param {Clearance} [clearance]
 * @param {Object} [opts]
 * @param {'volume'|'footprint'|function} [opts.objective='volume']
 *        named objective, or a custom scorer (cavity, arrangement) -> number
 *        (lower is better — e.g. a style-aware board-area estimate)
 * @param {number} [opts.aspect=1]       preferred cavity L:W ratio (tie-break)
 * @param {number} [opts.layers]         layer count hint (restricts the search)
 * @param {Orientation[]} [opts.orientations]  preference-ordered subset of allowedOrientations
 * @returns {{cavity: Cavity, arrangement: Arrangement}}
 */
/**
 * Enumerate every candidate parent cavity for N children — the raw grid ×
 * orientation × layer-count search space that solveParent scores. Exposed
 * so a consumer can rank candidates by downstream outcomes (e.g. how each
 * case palletizes) instead of collapsing to one winner here.
 * Same argument contract as solveParent; returns candidates in the same
 * deterministic order solveParent evaluates them.
 * @returns {{cavity: Cavity, nx: number, ny: number, layers: number,
 *            oi: number, o: Orientation, l: number, w: number, h: number}[]}
 */
export function parentCandidates(child, count, clearance = {wall: 0, between: 0}, opts = {}){
  validateOrientations(child.allowedOrientations);
  if(!(count >= 1)) throw new Error('parentCandidates needs count >= 1');
  const {wall, between, bottom, top, betweenZ} = normClearance(clearance);

  let orientations = child.allowedOrientations;
  if(opts.orientations){
    for(const o of opts.orientations)
      if(!child.allowedOrientations.includes(o))
        throw new Error(`orientation preference "${o}" is not in allowedOrientations`);
    orientations = opts.orientations;
  }

  const layerChoices = opts.layers ? [opts.layers] : Array.from({length: count}, (_, i) => i + 1);
  const out = [];
  for(let oi = 0; oi < orientations.length; oi++){
    const {l, w, h} = orientDims(child.outer, orientations[oi]);
    for(const layers of layerChoices){
      const perLayer = Math.ceil(count/layers);
      for(let nx = 1; nx <= perLayer; nx++){
        const ny = Math.ceil(perLayer/nx);
        out.push({
          cavity: {
            L: nx*l + (nx - 1)*between + 2*wall,
            W: ny*w + (ny - 1)*between + 2*wall,
            H: layers*h + (layers - 1)*betweenZ + bottom + top
          },
          nx, ny, layers, oi, o: orientations[oi], l, w, h
        });
      }
    }
  }
  return out;
}

export function solveParent(child, count, clearance = {wall: 0, between: 0}, opts = {}){
  const objective = opts.objective || 'volume';
  const aspect = opts.aspect || 1;
  const {between, bottom, betweenZ} = normClearance(clearance);

  const score = (cavity, arr) =>
    typeof objective === 'function' ? objective(cavity, arr) :
    objective === 'footprint' ? cavity.L*cavity.W :
    cavity.L*cavity.W*cavity.H;                       // 'volume'

  let best = null;
  for(const cand of parentCandidates(child, count, clearance, opts)){
    cand.score = score(cand.cavity, cand);
    cand.aspectDev = Math.abs(Math.log((cand.cavity.L/cand.cavity.W)/aspect));
    if(!best || better(cand, best)) best = cand;
  }

  // deterministic comparator: objective, then aspect preference, then fewer
  // layers, then earlier orientation preference, then fewer columns
  function better(a, b){
    if(a.score !== b.score) return a.score < b.score;
    if(a.aspectDev !== b.aspectDev) return a.aspectDev < b.aspectDev;
    if(a.layers !== b.layers) return a.layers < b.layers;
    if(a.oi !== b.oi) return a.oi < b.oi;
    return a.nx < b.nx;
  }

  // build the arrangement: fill `count` children row-major, layer by layer
  const {nx, ny, layers, l, w, h, o, cavity} = best;
  const placements = [];
  let remaining = count;
  outer: for(let ly = 0; ly < layers; ly++){
    const z = bottom + h/2 + ly*(h + betweenZ);
    for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++){
      if(remaining-- <= 0) break outer;
      if(placements.length >= PLACEMENT_CAP) break outer;
      placements.push({
        x: (i + 0.5)*(l + between) - nx*(l + between)/2,
        y: (j + 0.5)*(w + between) - ny*(w + between)/2,
        z,
        orientation: o
      });
    }
  }

  const arrangement = {
    placements,
    perLayer: nx*ny,                     // designed grid capacity per layer
    layers,
    total: count,
    envelope: {L: nx*l + (nx - 1)*between, W: ny*w + (ny - 1)*between, H: layers*h + (layers - 1)*betweenZ},
    utilization: count*(child.outer.L*child.outer.W*child.outer.H)/(cavity.L*cavity.W*cavity.H),
    label: `${nx} × ${ny} × ${layers}`
  };
  return {cavity, arrangement};
}
