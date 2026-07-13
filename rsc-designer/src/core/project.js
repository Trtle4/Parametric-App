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
      // the flow wrap around the collation. null = bare envelope (legacy).
      // Seal values are editable defaults, not conventions.
      wrap: {
        styleId: 'flowwrap',
        params: {sealType: 'fin', finHeight: 8, finSealBand: 5, finTreatment: 'folded',
                 lapOverlap: 12, endSealWidth: 10, endSealBleed: 3,
                 girthBasis: 'rectangular', roundDiameter: 0, gauge: 30, density: 0.92},
        locked: false
      },
      // H up, rotation allowed: product is often orientation-free in plan,
      // but which face is UP stays a hard user constraint (verticalToOrientations)
      allowedOrientations: ['LWH', 'WLH'],
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

/**
 * Resolve user intent — "which child axis points up" + "may the solver
 * rotate it in plan" — into the orientation set containment consumes.
 * Which face is up is a HARD CONSTRAINT (print, product settle, closure),
 * never an optimization variable; in-plan rotation is the only freedom the
 * solver may be granted, and only explicitly.
 * @param {'H'|'L'|'W'} verticalAxis  child dimension that points up
 * @param {boolean} mayRotate         solver may turn the child 90° in plan
 */
export function verticalToOrientations(verticalAxis, mayRotate){
  const pairs = {H: ['LWH', 'WLH'], L: ['WHL', 'HWL'], W: ['LHW', 'HLW']};
  const pair = pairs[verticalAxis];
  if(!pair) throw new Error(`unknown vertical axis "${verticalAxis}"`);
  return mayRotate ? [...pair] : [pair[0]];
}

/** Plain-language labels for the vertical-axis choice, code alongside. */
export const VERTICAL_CHOICES = [
  {axis: 'H', label: 'H up — upright, as designed', codes: 'LWH·WLH'},
  {axis: 'L', label: 'L up — on end',               codes: 'WHL·HWL'},
  {axis: 'W', label: 'W up — on side',              codes: 'LHW·HLW'}
];

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

  // the wrap (if any) sits between the collation and the carton: it takes
  // the envelope as content and hands up its seal-compensated outer
  let wrapGeo = null, wrapFits = true;
  if(prim.wrap){
    const wp = {...prim.wrap.params};
    // round girth basis is only meaningful when the wrap tube cross-section
    // is a single circle: cylindrical piece, one stack, running along the
    // pack length (stackAxis X). Anything else falls back to rectangular.
    if(wp.girthBasis === 'round'){
      const c = prim.collation;
      if(c.piece.kind === 'cylinder' && c.nx === 1 && c.ny === 1 && c.stackAxis === 'X')
        wp.roundDiameter = c.piece.diameter;
      else wp.girthBasis = 'rectangular';
    }
    if(prim.wrap.locked){
      // locked wrap: content dims are user-fixed; check the envelope fits
      wrapFits = col.envelope.L <= wp.L && col.envelope.W <= wp.W && col.envelope.H <= wp.H;
    }else{
      wp.L = col.envelope.L; wp.W = col.envelope.W; wp.H = col.envelope.H;
    }
    wrapGeo = styleById(prim.wrap.styleId).geometry(wp);
  }
  const content = wrapGeo ? wrapGeo.outer : col.envelope;

  // ONE variant: the vertical axis is user-locked and the orientation set
  // already encodes whether in-plan rotation is allowed — the solver picks
  // within that set only, never across vertical axes
  const child = {outer: content, allowedOrientations: prim.allowedOrientations};
  let params, fits = true, capacity = null, chosen;
  if(link.locked){
    params = sec.params;                                        // user-fixed carton
    const chk = fitInto(child, {L: params.L, W: params.W, H: params.H}, prim.clearance, 'column');
    capacity = chk.total; fits = chk.total >= link.count;
    chosen = chk.placements[0] ? chk.placements[0].orientation : prim.allowedOrientations[0];
  }else{
    const solved = solveParent(child, link.count, prim.clearance);
    const cavity = roundCavityUp(solved.cavity, step);
    params = {...sec.params, L: cavity.L, W: cavity.W, H: cavity.H};
    chosen = solved.arrangement.placements[0]
      ? solved.arrangement.placements[0].orientation : prim.allowedOrientations[0];
  }
  return [{
    params, geo: styleById(sec.styleId).geometry(params),
    orientation: chosen, label: orientationLabel(prim.collation.stackAxis, chosen),
    piecesPerCarton, fits: fits && wrapFits, capacity,
    wrapGeo, wrapFits, wrapsPerCarton: prim.wrap ? link.count : null
  }];
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
      if(variant.wrapGeo){
        // film cost columns — board vs film trade against each other.
        // fillEfficiency and film numbers NEVER touch cube utilization.
        const film = variant.wrapGeo.meta.film;
        row.filmAreaM2 = film.filmAreaM2;
        row.filmKgPerPallet = (film.massPer1000g/1000)*variant.wrapsPerCarton*row.cartonsPerPallet/1000;
        row.wrapOuter = variant.wrapGeo.outer;
      }else{
        row.filmAreaM2 = null; row.filmKgPerPallet = null; row.wrapOuter = null;
      }
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
  if(variant.wrapGeo){
    const film = variant.wrapGeo.meta.film;
    row.filmAreaM2 = film.filmAreaM2;
    row.filmKgPerPallet = (film.massPer1000g/1000)*variant.wrapsPerCarton*row.cartonsPerPallet/1000;
    row.wrapOuter = variant.wrapGeo.outer;
  }else{
    row.filmAreaM2 = null; row.filmKgPerPallet = null; row.wrapOuter = null;
  }
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

/* ---------------- hierarchy assembly for the 3D cascade view ------------
 * The full chain's Arrangements composed for rendering. Every placement here
 * comes from the model's own solvers (collate / solveParent / fitInto) — the
 * same calls the chain already makes. The chain DISCARDS two of these
 * (wraps-in-carton from solveParent in cartonVariants; cases-on-pallet from
 * fitInto in chainMetrics); this re-exposes them the way nestArrangement()
 * already re-exposes cartons-in-case. No new packaging math; the renderer
 * consumes placements only.
 */

/** Wraps arranged inside one carton (solveParent Arrangement), plus the seal
 *  descriptor and pieces the renderer needs to draw a wrap as a wrap. */
export function wrapsInCarton(project, row){
  const prim = project.primary;
  if(!prim || !prim.wrap) return null;
  const link = linkFor(project, 'secondary');
  const col = collate(prim.collation);
  const wp = {...prim.wrap.params};
  if(wp.girthBasis === 'round'){
    const c = prim.collation;
    if(c.piece.kind === 'cylinder' && c.nx === 1 && c.ny === 1 && c.stackAxis === 'X') wp.roundDiameter = c.piece.diameter;
    else wp.girthBasis = 'rectangular';
  }
  wp.L = col.envelope.L; wp.W = col.envelope.W; wp.H = col.envelope.H;
  const wrapGeo = styleById(prim.wrap.styleId).geometry(wp);
  const cartonGeo = styleById(project.secondary.styleId).geometry(row.cartonParams);
  const child = {outer: wrapGeo.outer, allowedOrientations: prim.allowedOrientations};
  const solved = solveParent(child, link.count, prim.clearance);
  return {
    cartonGeo, wrapGeo,
    placements: solved.arrangement.placements,      // wraps inside the carton
    envelope: col.envelope,
    pieces: col.placements,                         // pieces inside the wrap envelope
    piece: prim.collation.piece,
    stackAxis: prim.collation.stackAxis,
    seals: {sealType: wp.sealType, finTreatment: wp.finTreatment, finHeight: wp.finHeight,
            endSealWidth: wp.endSealWidth},
    counts: {wrapsPerCarton: link.count, piecesPerWrap: col.count}
  };
}

/** Cartons arranged inside the case for a chosen row. Unlike the legacy
 *  nestArrangement (which fits the UNSOLVED secondary.params), this fits the
 *  row's own SOLVED carton — the only one consistent with row.cavity. */
export function cartonsInCase(project, row){
  const cartonGeo = styleById(project.secondary.styleId).geometry(row.cartonParams);
  const child = {
    outer: cartonGeo.outer,
    allowedOrientations: typeof row.orientation === 'string' && row.orientation.length === 3
      ? [row.orientation] : project.secondary.allowedOrientations
  };
  const fit = fitInto(child, row.cavity, project.secondary.clearance, 'column');
  return {cartonGeo, placements: fit.placements, count: fit.total};
}

/** Cases arranged on the pallet (fitInto Arrangement) for the chosen row. */
export function casesOnPallet(project, row){
  const p = project.pallet;
  const caseGeo = styleById(project.tertiary.styleId).geometry(row.caseParams);
  const fit = fitInto(
    {outer: caseGeo.outer, allowedOrientations: project.tertiary.allowedOrientations},
    {L: p.L, W: p.W, H: p.maxH - p.baseH},
    project.tertiary.clearance,
    p.pattern
  );
  return {caseGeo, placements: fit.placements, count: fit.total,
          deck: {L: p.L, W: p.W, baseH: p.baseH}};
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
