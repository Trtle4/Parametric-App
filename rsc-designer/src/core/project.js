/**
 * The project model: the packaging hierarchy. A Level is one tier (carton,
 * case); a Link records that a parent level is driven by — or locked
 * against — its child. This module runs the full chain:
 *
 *   carton outer -> arrangement + clearance -> case cavity -> case outer -> pallet fit
 *
 * DOM-free, THREE-free, mm-only. The pallet's physical height (timber) is
 * passed in via PalletConfig.baseH so this module knows nothing about decks.
 */
import {fitInto, parentCandidates, solveParent} from './containment.js';
import {styleById} from './styles/index.js';
import {collate, orientationLabel} from './collation.js';

/**
 * @typedef {import('./containment.js').Orientation} Orientation
 * @typedef {import('./containment.js').Clearance} Clearance
 *
 * @typedef {Object} Level
 * @property {string} styleId
 * @property {Object} params                       // style params, mm
 * @property {Orientation[]} allowedOrientations   // how THIS level may sit inside its parent
 * @property {Clearance} clearance                 // how much room THIS level needs inside its parent
 * @property {Object} [geometry]                   // derived, cached
 *
 * @typedef {Object} PalletConfig
 * @property {number} L @property {number} W      // deck, mm
 * @property {number} maxH                         // total height budget incl. base, mm
 * @property {number} baseH                        // deck assembly height, mm
 * @property {'optimal'|'column'|'interlock'} pattern
 *
 * @typedef {Object} Link
 * @property {'tertiary'} parent
 * @property {'secondary'} child
 * @property {number} count                        // children per parent
 * @property {'auto'|{nx:number,ny:number,nz:number}} arrangement
 * @property {boolean} locked                      // true: parent dims fixed, child only checked
 *
 * @typedef {Object} Project
 * @property {Level|null} secondary                // the carton
 * @property {Level|null} tertiary                 // the case
 * @property {PalletConfig} pallet
 * @property {Link[]} links
 */

/** Rounding steps for solved cavity dimensions (mm). */
export const ROUNDING = {'1mm': 1, '5mm': 5, '1/16in': 25.4/16};

/** Round a cavity up to the step, per axis. The epsilon absorbs FP residue
 *  so 407.0000000000001 rounds to 407, not 408. */
export function roundCavityUp(cavity, step){
  const r = v => Math.ceil((v - 1e-9)/step)*step;
  return {L: r(cavity.L), W: r(cavity.W), H: r(cavity.H)};
}

/** Default params for a style, from its registry descriptors. */
export function styleDefaults(styleId){
  const out = {};
  for(const d of styleById(styleId).params) out[d.key] = d.default;
  return out;
}

/** A fresh project: collated product driving a carton driving a case, on a
 *  GMA pallet. `primary: null` reverts to the carton-driven chain. */
export function newProject(){
  return {
    primary: {
      collation: {
        piece: {kind: 'box', L: 90, W: 50, H: 20},
        perStack: 6, stackAxis: 'Z', nx: 1, ny: 1, stackGap: 0, pieceGap: 0
      },
      allowedOrientations: ['LWH'],                  // product is usually orientation-critical
      // product-in-carton allowances: 0/0/0 are review-me placeholders, not
      // conventions. top is HEADSPACE — a design decision, exposed in Build.
      clearance: {wall: 0, between: 0, bottom: 0, top: 0, betweenZ: 0}
    },
    secondary: {
      styleId: 'a6120',
      params: styleDefaults('a6120'),                // L/W/H overwritten when solved from the collation
      allowedOrientations: ['LWH', 'WLH'],           // upright; set deliberately in Build
      // wall/between are the review-me defaults; vertical is explicitly
      // non-uniform: cartons bear on the case floor (bottom 0), headspace
      // (top) is a first-class Build input, layers stack directly (betweenZ 0)
      clearance: {wall: 1.5, between: 0, bottom: 0, top: 0, betweenZ: 0}
    },
    tertiary: {
      styleId: 'fefco201',
      params: {...styleDefaults('fefco201')},        // L/W/H overwritten when solved
      allowedOrientations: ['LWH', 'WLH'],           // cases upright on the pallet
      clearance: {wall: 0, between: 0}
    },
    pallet: {L: 48*25.4, W: 40*25.4, maxH: 60*25.4, baseH: 127, pattern: 'optimal'},
    links: [
      {parent: 'tertiary', child: 'secondary', count: 12, arrangement: 'auto', locked: false},
      {parent: 'secondary', child: 'primary', count: 1, arrangement: 'auto', locked: false}
    ]
  };
}

export const linkFor = (project, parent) => project.links.find(l => l.parent === parent);

/* ---------------- candidate enumeration + full-chain metrics ------------ */

// keep only irreducible grids: capacity >= count and no axis removable
function irreducible(c, count){
  const cap = (a, b, d) => a*b*d >= count;
  if(!cap(c.nx, c.ny, c.layers)) return false;
  if(c.nx > 1 && cap(c.nx - 1, c.ny, c.layers)) return false;
  if(c.ny > 1 && cap(c.nx, c.ny - 1, c.layers)) return false;
  if(c.layers > 1 && cap(c.nx, c.ny, c.layers - 1)) return false;
  return true;
}

/**
 * Run every candidate case arrangement through the full chain and return
 * the comparison rows. Never collapses to one winner — ranking and choice
 * belong to the engineer.
 * @param {Project} project
 * @param {string} rounding  key of ROUNDING
 * @returns {Object[]} rows (see fields below), enumeration order
 */
/**
 * Resolve the carton variants that feed the case stage. Without a primary
 * level there is exactly one (the carton as configured). With one, the
 * collation envelope drives — or is checked against — the carton, once per
 * allowed primary orientation. Solved cavities use solveParent's volume
 * objective (the case stage is where enumeration + ranking happen).
 */
function cartonVariants(project, step){
  const sec = project.secondary;
  if(!project.primary){
    const geo = styleById(sec.styleId).geometry(sec.params);
    return [{params: sec.params, geo, orientation: null, label: null, piecesPerCarton: null, fits: true}];
  }
  const prim = project.primary;
  const link = linkFor(project, 'secondary');
  const col = collate(prim.collation);
  const piecesPerCarton = col.count*link.count;
  return prim.allowedOrientations.map(o => {
    const child = {outer: col.envelope, allowedOrientations: [o]};
    let params, fits = true, capacity = null;
    if(link.locked){
      params = sec.params;                                        // user-fixed carton
      const chk = fitInto(child, {L: params.L, W: params.W, H: params.H}, prim.clearance, 'column');
      capacity = chk.total; fits = chk.total >= link.count;
    }else{
      const solved = solveParent(child, link.count, prim.clearance);
      const cavity = roundCavityUp(solved.cavity, step);
      params = {...sec.params, L: cavity.L, W: cavity.W, H: cavity.H};
    }
    return {
      params, geo: styleById(sec.styleId).geometry(params),
      orientation: o, label: orientationLabel(prim.collation.stackAxis, o),
      piecesPerCarton, fits, capacity
    };
  });
}

export function candidateCases(project, rounding = '1mm'){
  const link = linkFor(project, 'tertiary');
  const sec = project.secondary, ter = project.tertiary;
  const step = ROUNDING[rounding] || 1;
  const rows = [];

  for(const variant of cartonVariants(project, step)){
    const child = {outer: variant.geo.outer, allowedOrientations: sec.allowedOrientations};
    const cartonVol = variant.geo.outer.L*variant.geo.outer.W*variant.geo.outer.H;

    let cands;
    if(link.arrangement === 'auto'){
      cands = parentCandidates(child, link.count, sec.clearance).filter(c => irreducible(c, link.count));
    }else{
      const {nx, ny, nz} = link.arrangement;
      cands = parentCandidates(child, nx*ny*nz, sec.clearance, {layers: nz})
        .filter(c => c.nx === nx && c.ny === ny);
    }

    for(const c of cands){
      const cavity = roundCavityUp(c.cavity, step);
      const caseParams = {...ter.params, L: cavity.L, W: cavity.W, H: cavity.H};
      const caseGeo = styleById(ter.styleId).geometry(caseParams);
      const row = chainMetrics(project, c, cavity, caseParams, caseGeo, cartonVol, link.count);
      row.cartonParams = variant.params;
      row.cartonOuter = variant.geo.outer;
      row.primaryOrientation = variant.orientation;
      row.primaryLabel = variant.label;
      row.primaryFits = variant.fits;
      row.piecesPerCarton = variant.piecesPerCarton;
      row.piecesPerPallet = variant.piecesPerCarton !== null
        ? variant.piecesPerCarton*row.cartonsPerPallet : null;
      rows.push(row);
    }
  }
  return rows;
}

/** Locked direction: the case dims are fixed; check the carton against them.
 *  With a primary level, the carton itself is first derived from (or checked
 *  against) the collation using the FIRST allowed primary orientation. */
export function checkLockedCase(project, rounding = '1mm'){
  const link = linkFor(project, 'tertiary');
  const sec = project.secondary, ter = project.tertiary;
  const step = ROUNDING[rounding] || 1;
  const variant = cartonVariants(project, step)[0];
  const child = {outer: variant.geo.outer, allowedOrientations: sec.allowedOrientations};
  const cavity = {L: ter.params.L, W: ter.params.W, H: ter.params.H};
  const fit = fitInto(child, cavity, sec.clearance, 'column');
  const caseGeo = styleById(ter.styleId).geometry(ter.params);
  const cartonVol = variant.geo.outer.L*variant.geo.outer.W*variant.geo.outer.H;
  const cand = {nx: '—', ny: '—', layers: fit.layers, o: fit.placements[0] ? fit.placements[0].orientation : '—'};
  const row = chainMetrics(project, cand, cavity, ter.params, caseGeo, cartonVol, link.count);
  row.capacity = fit.total;
  row.fits = fit.total >= link.count && variant.fits;
  row.arrangementLabel = `locked (${fit.label})`;
  row.cartonParams = variant.params;
  row.cartonOuter = variant.geo.outer;
  row.primaryOrientation = variant.orientation;
  row.primaryLabel = variant.label;
  row.primaryFits = variant.fits;
  row.piecesPerCarton = variant.piecesPerCarton;
  row.piecesPerPallet = variant.piecesPerCarton !== null
    ? variant.piecesPerCarton*row.cartonsPerPallet : null;
  return row;
}

/**
 * Everything the Carton + product 3D view needs for one table row: the
 * carton geometry, the collation result (real piece placements), and the
 * chosen envelope orientation into the carton.
 */
export function productNest(project, row){
  if(!project.primary) return null;
  const col = collate(project.primary.collation);
  const cartonGeo = styleById(project.secondary.styleId).geometry(row.cartonParams);
  return {
    cartonGeo,
    collation: project.primary.collation,
    result: col,
    orientation: row.primaryOrientation || project.primary.allowedOrientations[0],
    clearance: project.primary.clearance
  };
}

function chainMetrics(project, cand, cavity, caseParams, caseGeo, cartonVol, count){
  const p = project.pallet;
  const fit = fitInto(
    {outer: caseGeo.outer, allowedOrientations: project.tertiary.allowedOrientations},
    {L: p.L, W: p.W, H: p.maxH - p.baseH},
    project.tertiary.clearance,
    p.pattern
  );
  const loadH = fit.layers*caseGeo.outer.H;
  const cartonsPerPallet = fit.total*count;
  return {
    // identity
    nx: cand.nx, ny: cand.ny, nz: cand.layers, orientation: cand.o,
    arrangementLabel: `${cand.nx} × ${cand.ny} × ${cand.layers} ${cand.o}`,
    // the case
    cavity, caseParams,
    outer: caseGeo.outer,
    boardAreaM2: caseGeo.bbox.maxX*caseGeo.bbox.maxY/1e6,
    // the pallet
    casesPerLayer: fit.perLayer,
    caseLayers: fit.layers,
    casesPerPallet: fit.total,
    cartonsPerPallet,
    coveragePct: Math.round(fit.perLayer*caseGeo.outer.L*caseGeo.outer.W/(p.L*p.W)*100),
    // cube utilization: total carton volume over the LOAD envelope
    // (deck footprint x load height above the deck, wood excluded) —
    // the freight-driving number
    cubeUtilPct: loadH > 0 ? Math.round(cartonVol*cartonsPerPallet/(p.L*p.W*loadH)*100) : 0
  };
}

/**
 * Placements of the cartons inside a chosen (rounded) case cavity — via
 * fitInto, so the 3D nest view exercises the real containment path and
 * doubles as a post-rounding capacity check.
 * @returns {{placements: import('./containment.js').Placement[], capacity: number, cavity: Object}}
 */
export function nestArrangement(project, row){
  const sec = project.secondary;
  const cartonGeo = styleById(sec.styleId).geometry(sec.params);
  const child = {
    outer: cartonGeo.outer,
    allowedOrientations: typeof row.orientation === 'string' && row.orientation.length === 3
      ? [row.orientation] : sec.allowedOrientations
  };
  const fit = fitInto(child, row.cavity, sec.clearance, 'column');
  const count = project.links[0].count;
  return {placements: fit.placements.slice(0, Math.min(count, fit.placements.length)),
          capacity: fit.total, cavity: row.cavity, cartonGeo};
}
