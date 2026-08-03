/**
 * Pallet view: a standard GMA 48x40 4-way stringer pallet (render asset) +
 * instanced case rendering, with an optional double-stack (two unit loads).
 *
 * RENDER ONLY: this view draws the placements the chain already solved
 * (row.arr.cases.placements) — it does NOT pack the pallet itself. That is
 * the single source of truth: the Build table, the right-rail readout, the
 * 3D-Fold pallet depth, and this view all show the ONE count core computed,
 * so they can never diverge (a second in-view fitInto used to, stacking the
 * case at a pitch borrowed from an unrelated candidate row). The pallet
 * timber is the ONE shared render asset in render/palletmesh.js
 * (buildGmaPallet) — both pallet views build the SAME pallet from there.
 * PALLET_HEIGHT stays 127 mm. All lengths in mm.
 */
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

/**
 * Render the loaded pallet from the placements the chain ALREADY solved — no
 * packing here. `placements` is row.arr.cases.placements (the outermost tier's
 * positions on the deck, each {x,y,z,orientation}); `layers` and `effectiveH`
 * (row.caseLayers / row.unitStackH) give the load height for the double-stack
 * offset and vertical centring. One source of truth with the readout/table.
 * @param {import('../core/types.js').Geometry} geo   outermost tier's geometry (outer dims → box mesh)
 * @param {{L:number, W:number, maxH:number}} pallet  deck size (maxH unused here — height came from the fit)
 * @param {Array<{x:number,y:number,z:number,orientation:string}>} placements  solved case positions
 * @param {number} layers        solved layer count (row.caseLayers)
 * @param {number} [effectiveH]   per-unit stacking pitch (row.unitStackH); defaults to outer.H
 * @param {boolean} visible       whether the pallet view is active
 * @param {boolean} doubleStack   render a second unit load on top (two pallets high)
 */
export function buildPallet(geo, pallet, placements, layers, effectiveH, visible, doubleStack){
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

  const oneLoadH = ph + layers*sh;                     // pallet + its case stack (proud pitch)
  const nLoads = doubleStack ? 2 : 1;
  const shown = Math.min(placements.length, SHOWN_CAP);
  const caseGeo = placements.length > 0
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
        const p = placements[i];
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
}

export function showPallet(v){ if(palletGroup) palletGroup.visible = v; }
