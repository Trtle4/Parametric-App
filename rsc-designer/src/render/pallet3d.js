/**
 * Pallet view: a standard GMA 48x40 4-way stringer pallet (render asset) +
 * instanced case rendering, with an optional double-stack (two unit loads).
 *
 * One consumer of core/containment.js: the deck is a fixed cavity, the case
 * outer envelope is the child, and cases may rotate about the vertical axis
 * only. The pallet timber itself is the ONE shared render asset in
 * render/palletmesh.js (buildGmaPallet) — both this view and the 3D-Fold
 * pallet-depth view build the SAME pallet from there. RENDER ONLY — the fit
 * math (palletStats/fitInto) is unchanged; PALLET_HEIGHT stays 127 mm so the
 * load-height budget the chain reads is identical. All lengths in mm.
 */
import {fitInto} from '../core/containment.js';
import {getPivot, setCamSpan, kraft, roundedBoxGeo} from './fold3d.js';
import {buildGmaPallet, PALLET_HEIGHT} from './palletmesh.js';

const CASE_GAP = 2;                                  // visual seam between cases
const SHOWN_CAP = 4000;                              // instancing cap for absurd inputs

// re-exported so existing consumers (app.js, the chain height budget) keep
// importing the deck-assembly height from here, even though the pallet mesh
// and PALLET_HEIGHT now live in palletmesh.js
export {PALLET_HEIGHT};

let palletGroup = null;

/** Effective per-unit stacking height. For an OPEN tray whose contents stand
 *  proud of its walls, the layer pitch must reserve the taller of the two —
 *  the chain already computes this (row.unitStackH) and threads it in here, so
 *  the render stacks at the same pitch and layers never interpenetrate. Falls
 *  back to outer.H when no effective height is supplied (every closed style). */
const stackHeightOf = (geo, effectiveH) => (effectiveH && effectiveH > 0) ? effectiveH : geo.outer.H;

/** Pure pallet-fit stats (no rendering) — the cheap path the always-visible
 *  readout + BCT use on every recompute. Same fitInto call buildPallet makes,
 *  so the numbers match the 3D view exactly. */
export function palletStats(geo, pallet, pattern, effectiveH){
  const arr = fitInto(
    {outer: {...geo.outer, H: stackHeightOf(geo, effectiveH)}, allowedOrientations: ['LWH', 'WLH'], styleId: geo.meta.style},
    {L: pallet.L, W: pallet.W, H: pallet.maxH - PALLET_HEIGHT},
    {wall: 0, between: 0},
    pattern
  );
  return {
    label: arr.label, perLayer: arr.perLayer, layers: arr.layers, total: arr.total,
    coveragePct: Math.round(arr.perLayer*geo.outer.L*geo.outer.W/(pallet.L*pallet.W)*100)
  };
}

/**
 * @param {import('../core/types.js').Geometry} geo   style output (outer dims consumed)
 * @param {{L:number, W:number, maxH:number}} pallet  deck size + height budget, mm
 * @param {'optimal'|'column'|'interlock'} pattern
 * @param {boolean} visible whether the pallet view is active
 * @param {boolean} doubleStack render a second unit load on top (two pallets high)
 * @param {number} [effectiveH] per-unit stacking height (row.unitStackH) — the
 *        proud-content height for an open tray; defaults to outer.H (closed)
 * @returns {{label:string, perLayer:number, layers:number, total:number, coveragePct:number}}
 */
export function buildPallet(geo, pallet, pattern, visible, doubleStack, effectiveH){
  const pivot = getPivot();
  if(palletGroup){
    pivot.remove(palletGroup);
    palletGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); });
  }
  palletGroup = new THREE.Group();

  const ol = geo.outer.L, ow = geo.outer.W, oh = geo.outer.H;
  const sh = stackHeightOf(geo, effectiveH);           // layer pitch (>= oh for a proud open tray)
  const ph = PALLET_HEIGHT;
  const pl = pallet.L, pw = pallet.W;

  // containment does the layout: fixed cavity above the deck, cases rotate
  // about the vertical axis only, flush stacking (zero clearance). The fit
  // uses the EFFECTIVE height so proud-content layers reserve their full pitch.
  const arr = fitInto(
    {outer: {...geo.outer, H: sh}, allowedOrientations: ['LWH', 'WLH'], styleId: geo.meta.style},
    {L: pl, W: pw, H: pallet.maxH - ph},
    {wall: 0, between: 0},
    pattern
  );

  const oneLoadH = ph + arr.layers*sh;                 // pallet + its case stack (proud pitch)
  const nLoads = doubleStack ? 2 : 1;
  const shown = Math.min(arr.total, SHOWN_CAP);
  const caseGeo = arr.total > 0
    ? roundedBoxGeo(ol - CASE_GAP, oh - CASE_GAP, ow - CASE_GAP, Math.min(4, geo.meta.caliper*1.6), 2)
    : null;

  for(let u = 0; u < nLoads; u++){
    const yBase = u*oneLoadH;                           // second unit load sits on top of the first
    const timber = buildGmaPallet(pl, pw);
    timber.position.y = yBase;
    palletGroup.add(timber);

    if(caseGeo){
      const inst = new THREE.InstancedMesh(caseGeo, kraft, shown);
      const M = new THREE.Matrix4(), R = new THREE.Matrix4().makeRotationY(Math.PI/2);
      for(let i = 0; i < shown; i++){
        const p = arr.placements[i];
        if(p.orientation === 'WLH') M.copy(R); else M.identity();   // 90° about vertical
        M.setPosition(p.x, yBase + ph + p.z, p.y);                  // containment (x,y,z) -> world (x,z,y)
        inst.setMatrixAt(i, M);
      }
      palletGroup.add(inst);
    }
  }

  const totalH = nLoads*oneLoadH;
  palletGroup.position.y = -totalH/2;                  // centre vertically for orbit
  palletGroup.visible = visible;
  pivot.add(palletGroup);
  setCamSpan(Math.max(pl, pw, totalH)*0.85);

  return {
    label: arr.label,
    perLayer: arr.perLayer,
    layers: arr.layers,
    total: arr.total,
    coveragePct: Math.round(arr.perLayer*ol*ow/(pl*pw)*100)
  };
}

export function showPallet(v){ if(palletGroup) palletGroup.visible = v; }
