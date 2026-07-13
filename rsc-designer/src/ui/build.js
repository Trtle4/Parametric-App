/**
 * The Build view: the configuration surface for the
 * collation -> carton -> case -> pallet chain. Owns its own DOM (inside
 * #buildWrap), maintains the Project, runs candidateCases, and renders the
 * sortable comparison table.
 *
 * Length inputs follow the app's unit toggle (mm/in); values are converted
 * in place on switch and read back to mm. Counts and grid numbers are
 * dimensionless and never convert.
 *
 * Never auto-selects a winner: rows are ranked visibly, the engineer picks.
 */
import {newProject, candidateCases, checkLockedCase, nestArrangement, productNest, ROUNDING, linkFor,
        verticalToOrientations, VERTICAL_CHOICES} from '../core/project.js';
import {collate, PRESETS} from '../core/collation.js';
import {styleById} from '../core/styles/index.js';
import {toMM, fromMM, fmtInputValue, fmtLen} from '../core/units.js';
import {el} from './inputs.js';

export const project = newProject();
let unit = 'mm';
let rounding = '1mm';
let rows = [];
let selected = null;          // a row object, user-picked
let sortKey = 'cartonsPerPallet', sortDir = -1;
let onSelectCb = null;

// ids of LENGTH inputs (unit-convertible); counts, film gauge (µm) and
// density (g/cm³) stay in their own units and never convert
const LEN_IDS = ['bpL', 'bpW', 'bpH', 'bpD', 'bpT', 'bsg', 'bpg',
                 'bwFinH', 'bwBand', 'bwLap', 'bwEndW', 'bwBleed', 'bwL', 'bwW', 'bwH',
                 'bpWall', 'bpBetween', 'bpHead',
                 'bCal', 'bCL', 'bCW', 'bCH',
                 'bWall', 'bBetween', 'bcHead',
                 'bTCal', 'bTGlue', 'bTSlot', 'bTL', 'bTW', 'bTH',
                 'btWall', 'btBetween'];

/** Uniform two-part orientation control: vertical axis is a hard constraint
 *  (single select, plain language + codes), in-plan rotation is the only
 *  solver freedom (checkbox). Used at every level. */
function vertControl(idp, defAxis, disabledAxes = [], disabledReason = ''){
  return html`
  <div class="brow"><label>Vertical axis</label>
    <select id="${idp}Vert">${VERTICAL_CHOICES.map(c => {
      const dis = disabledAxes.includes(c.axis);
      return `<option value="${c.axis}"${c.axis === defAxis ? ' selected' : ''}${dis ? ` disabled title="${disabledReason}"` : ''}>${c.label} · ${c.codes}${dis ? ' — disabled' : ''}</option>`;
    }).join('')}</select></div>
  <div class="brow bchk"><label><input type="checkbox" id="${idp}Rot" checked> May rotate about vertical (90° in plan)</label></div>`;
}

const html = String.raw;
const lenVal = mm => fmtInputValue(fromMM(mm, unit), unit);
const U = () => `<span class="bunit">${unit}</span>`;

export function initBuild(onSelect, startUnit){
  onSelectCb = onSelect;
  unit = startUnit || 'mm';
  const col = project.primary.collation;
  const tp = project.tertiary.params;
  el('buildWrap').innerHTML = html`
  <div class="bpanel">
    <div class="bcols">
      <fieldset><legend>Product · collation</legend>
        <div class="brow"><label>Piece</label>
          <select id="bKind"><option value="box">Box</option><option value="cylinder">Cylinder (round)</option></select></div>
        <div class="brow" id="bBoxDims"><label>L</label><input id="bpL" type="number" value="${lenVal(col.piece.L)}">${U()}
          <label>W</label><input id="bpW" type="number" value="${lenVal(col.piece.W)}">${U()}
          <label>H</label><input id="bpH" type="number" value="${lenVal(col.piece.H)}">${U()}</div>
        <div class="brow" id="bCylDims" style="display:none"><label>Dia</label><input id="bpD" type="number" value="${lenVal(50)}">${U()}
          <label>Thick</label><input id="bpT" type="number" value="${lenVal(6)}">${U()}</div>
        <div class="brow"><label>Preset</label>
          <select id="bPreset">${PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}</select></div>
        <div class="brow"><label>Per stack</label><input id="bPer" type="number" min="1" value="${col.perStack}" class="bshort">
          <label>Axis</label><select id="bAxis"><option>X</option><option>Y</option><option selected>Z</option></select>
          <label>Stacks</label><input id="bnx" type="number" min="1" value="${col.nx}" class="bshort"> ×
          <input id="bny" type="number" min="1" value="${col.ny}" class="bshort"></div>
        <div class="brow"><label>Stack gap</label><input id="bsg" type="number" step="0.5" value="${lenVal(col.stackGap)}">${U()}
          <label>Piece gap</label><input id="bpg" type="number" step="0.5" value="${lenVal(col.pieceGap)}">${U()}</div>
        <div class="brow bnote" id="bEnvInfo"></div>
      </fieldset>
      <fieldset><legend>Flow wrap</legend>
        <div class="brow"><label>Long. seal</label>
          <select id="bwSeal"><option value="fin" selected>Fin</option><option value="lap">Lap</option></select>
          <label>Treatment</label>
          <select id="bwTreat"><option value="folded" selected>Folded down</option><option value="standing">Standing</option></select></div>
        <div class="brow"><label>Fin height</label><input id="bwFinH" type="number" step="0.5" value="${lenVal(8)}">${U()}
          <label>Seal band</label><input id="bwBand" type="number" step="0.5" value="${lenVal(5)}">${U()}</div>
        <div class="brow"><label>Lap overlap</label><input id="bwLap" type="number" step="0.5" value="${lenVal(12)}">${U()}</div>
        <div class="brow"><label>End seal</label><input id="bwEndW" type="number" step="0.5" value="${lenVal(10)}">${U()}
          <label>Bleed</label><input id="bwBleed" type="number" step="0.5" value="${lenVal(3)}">${U()}</div>
        <div class="brow"><label>Girth basis</label>
          <select id="bwBasis"><option value="rectangular" selected>Rectangular 2(W+H)</option>
            <option value="round" id="bwBasisRound">Round π·d (cylindrical slug only)</option></select></div>
        <div class="brow"><label>Film gauge</label><input id="bwGauge" type="number" step="1" value="30"><span>µm</span>
          <label>Density</label><input id="bwDens" type="number" step="0.01" value="0.92"><span>g/cm³</span></div>
        <div class="brow bnote">Seal values are editable defaults — review. Gauge/density are film substance, not caliper.</div>
        <div class="brow bchk"><label><input type="checkbox" id="bwLock"> Lock wrap content dims (check fit only)</label></div>
        <div class="brow" id="bwLockDims" style="display:none"><label>L</label><input id="bwL" type="number" value="${lenVal(90)}">${U()}
          <label>W</label><input id="bwW" type="number" value="${lenVal(50)}">${U()}
          <label>H</label><input id="bwH" type="number" value="${lenVal(120)}">${U()}</div>
      </fieldset>
      <fieldset><legend>Carton content</legend>
        ${vertControl('bp', 'H')}
        <div class="brow"><label>Clearance wall</label><input id="bpWall" type="number" step="0.1" value="${lenVal(0)}">${U()}
          <label>between</label><input id="bpBetween" type="number" step="0.1" value="${lenVal(0)}">${U()}</div>
        <div class="brow"><label>Headspace</label><input id="bpHead" type="number" step="0.5" value="${lenVal(0)}">${U()}</div>
        <div class="brow bnote">Clearances default 0 — review. Headspace is a design decision, not a fit tolerance.</div>
        <div class="brow"><label>Carton caliper</label><input id="bCal" type="number" step="0.001" value="${lenVal(project.secondary.params.caliper)}">${U()}</div>
        <div class="brow bchk"><label><input type="checkbox" id="bCLock"> Lock carton dims (check fit only)</label></div>
        <div class="brow" id="bCLockDims" style="display:none"><label>L</label><input id="bCL" type="number" value="${lenVal(100)}">${U()}
          <label>W</label><input id="bCW" type="number" value="${lenVal(100)}">${U()}
          <label>H</label><input id="bCH" type="number" value="${lenVal(60)}">${U()}</div>
      </fieldset>
      <fieldset><legend>Case content</legend>
        ${vertControl('bs', 'H')}
        <div class="brow"><label>Cartons/case</label>
          <select id="bCountSel"><option>12</option><option>24</option><option>36</option><option value="custom">custom</option></select>
          <input id="bCount" type="number" min="1" value="12" style="display:none"></div>
        <div class="brow"><label>Arrangement</label>
          <select id="bArr"><option value="auto">auto</option><option value="explicit">nx × ny × nz</option></select>
          <span id="bArrN" style="display:none">
            <input id="bNx" type="number" min="1" value="4" class="bshort"> ×
            <input id="bNy" type="number" min="1" value="3" class="bshort"> ×
            <input id="bNz" type="number" min="1" value="1" class="bshort"></span></div>
        <div class="brow"><label>Clearance wall</label><input id="bWall" type="number" step="0.1" value="${lenVal(1.5)}">${U()}
          <label>between</label><input id="bBetween" type="number" step="0.1" value="${lenVal(0)}">${U()}</div>
        <div class="brow"><label>Headspace</label><input id="bcHead" type="number" step="0.5" value="${lenVal(0)}">${U()}</div>
        <div class="brow bnote">Clearance defaults are placeholders to review, not truth.
          Cartons bear on the case floor (bottom 0).</div>
        <div class="brow"><label>Round cavities up to</label>
          <select id="bRound">${Object.keys(ROUNDING).map(k => `<option${k === rounding ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      </fieldset>
      <fieldset><legend>Case (FEFCO 201) · on pallet</legend>
        ${vertControl('bt', 'H', ['L', 'W'], 'A shipper does not go on the pallet on its side — say so explicitly if you genuinely need this')}
        <div class="brow"><label>Pallet clearance wall</label><input id="btWall" type="number" step="0.1" value="${lenVal(0)}">${U()}
          <label>between</label><input id="btBetween" type="number" step="0.1" value="${lenVal(0)}">${U()}</div>
        <div class="brow"><label>Caliper</label><input id="bTCal" type="number" step="0.1" value="${lenVal(tp.caliper)}">${U()}</div>
        <div class="brow"><label>Glue flap</label><input id="bTGlue" type="number" value="${lenVal(tp.glue)}">${U()}
          <label>Slot</label><input id="bTSlot" type="number" step="0.5" value="${lenVal(tp.slot)}">${U()}</div>
        <div class="brow bchk"><label><input type="checkbox" id="bLock"> Lock case dims (check fit only)</label></div>
        <div class="brow" id="bLockDims" style="display:none"><label>L</label><input id="bTL" type="number" value="${lenVal(407)}">${U()}
          <label>W</label><input id="bTW" type="number" value="${lenVal(186)}">${U()}
          <label>H</label><input id="bTH" type="number" value="${lenVal(152)}">${U()}</div>
        <div class="brow"><button class="btn bapply" id="bUse" disabled>Use selected as case</button></div>
      </fieldset>
    </div>
    <div id="bStatus" class="bnote"></div>
    <div class="btablewrap"><table id="bTable"></table></div>
  </div>`;

  const rewire = ids => ids.forEach(id => el(id).addEventListener('input', recompute));
  rewire(LEN_IDS.concat(['bPer', 'bnx', 'bny', 'bCount', 'bNx', 'bNy', 'bNz', 'bwGauge', 'bwDens']));
  ['bpVert', 'bpRot', 'bsVert', 'bsRot', 'btVert', 'btRot', 'bwSeal', 'bwTreat', 'bwBasis']
    .forEach(id => el(id).addEventListener('change', recompute));
  el('bwLock').addEventListener('change', () => {
    el('bwLockDims').style.display = el('bwLock').checked ? '' : 'none';
    recompute();
  });
  el('bKind').addEventListener('change', () => {
    const cyl = el('bKind').value === 'cylinder';
    el('bBoxDims').style.display = cyl ? 'none' : '';
    el('bCylDims').style.display = cyl ? '' : 'none';
    el('bwBasisRound').disabled = !cyl;         // round girth: cylindrical only
    if(!cyl && el('bwBasis').value === 'round') el('bwBasis').value = 'rectangular';
    recompute();
  });
  el('bwBasisRound').disabled = true;           // default piece is a box
  el('bPreset').addEventListener('change', () => {
    const p = PRESETS.find(x => x.id === el('bPreset').value);
    if(p){
      if(p.set.perStack !== undefined) el('bPer').value = p.set.perStack;
      if(p.set.stackAxis) el('bAxis').value = p.set.stackAxis;
      if(p.set.nx !== undefined) el('bnx').value = p.set.nx;
      if(p.set.ny !== undefined) el('bny').value = p.set.ny;
    }
    recompute();
  });
  el('bAxis').addEventListener('change', recompute);
  el('bCountSel').addEventListener('change', () => {
    const custom = el('bCountSel').value === 'custom';
    el('bCount').style.display = custom ? '' : 'none';
    if(!custom) el('bCount').value = el('bCountSel').value;
    recompute();
  });
  el('bArr').addEventListener('change', () => {
    el('bArrN').style.display = el('bArr').value === 'explicit' ? '' : 'none';
    recompute();
  });
  el('bRound').addEventListener('change', () => { rounding = el('bRound').value; recompute(); });
  el('bLock').addEventListener('change', () => {
    el('bLockDims').style.display = el('bLock').checked ? '' : 'none';
    recompute();
  });
  el('bCLock').addEventListener('change', () => {
    el('bCLockDims').style.display = el('bCLock').checked ? '' : 'none';
    recompute();
  });
  recompute();
}

/** Convert every length field in place when the app unit toggle changes. */
export function onUnitsChanged(next){
  if(next === unit) return;
  const k = next === 'in' ? 1/25.4 : 25.4;
  for(const id of LEN_IDS){
    const e = el(id); if(!e) continue;
    e.value = fmtInputValue((+e.value || 0)*k, next);
  }
  unit = next;
  document.querySelectorAll('#buildWrap .bunit').forEach(s => s.textContent = unit);
  recompute();
}

function readIntoProject(){
  const n = id => toMM(+el(id).value || 0, unit);      // length, -> mm
  const c = id => Math.max(1, Math.round(+el(id).value || 1)); // count
  const prim = project.primary, sec = project.secondary, ter = project.tertiary;
  const caseLink = linkFor(project, 'tertiary'), cartonLink = linkFor(project, 'secondary');

  prim.collation = {
    piece: el('bKind').value === 'cylinder'
      ? {kind: 'cylinder', diameter: n('bpD'), thickness: n('bpT')}
      : {kind: 'box', L: n('bpL'), W: n('bpW'), H: n('bpH')},
    perStack: c('bPer'), stackAxis: el('bAxis').value,
    nx: c('bnx'), ny: c('bny'),
    stackGap: n('bsg'), pieceGap: n('bpg')
  };
  // vertical axis is a hard user constraint at every level; rotation is
  // the only solver freedom, granted explicitly per level
  prim.allowedOrientations = verticalToOrientations(el('bpVert').value, el('bpRot').checked);
  prim.clearance = {wall: n('bpWall'), between: n('bpBetween'), bottom: 0, top: n('bpHead'), betweenZ: 0};
  prim.wrap = {
    styleId: 'flowwrap',
    params: {
      sealType: el('bwSeal').value, finTreatment: el('bwTreat').value,
      finHeight: n('bwFinH'), finSealBand: n('bwBand'), lapOverlap: n('bwLap'),
      endSealWidth: n('bwEndW'), endSealBleed: n('bwBleed'),
      girthBasis: el('bwBasis').value, roundDiameter: 0,
      gauge: +el('bwGauge').value || 0, density: +el('bwDens').value || 0,
      L: n('bwL'), W: n('bwW'), H: n('bwH')          // used only when locked
    },
    locked: el('bwLock').checked
  };

  sec.params = {...sec.params, caliper: n('bCal')};
  cartonLink.locked = el('bCLock').checked;
  if(cartonLink.locked) sec.params = {...sec.params, L: n('bCL'), W: n('bCW'), H: n('bCH')};

  sec.allowedOrientations = verticalToOrientations(el('bsVert').value, el('bsRot').checked);
  sec.clearance = {wall: n('bWall'), between: n('bBetween'), bottom: 0, top: n('bcHead'), betweenZ: 0};
  ter.allowedOrientations = verticalToOrientations(el('btVert').value, el('btRot').checked);
  ter.clearance = {wall: n('btWall'), between: n('btBetween')};
  ter.params = {...ter.params, caliper: n('bTCal'), glue: n('bTGlue'), slot: n('bTSlot')};
  caseLink.count = c('bCount');
  caseLink.locked = el('bLock').checked;
  caseLink.arrangement = el('bArr').value === 'auto' ? 'auto'
    : {nx: c('bNx'), ny: c('bNy'), nz: c('bNz')};
  if(caseLink.locked) ter.params = {...ter.params, L: n('bTL'), W: n('bTW'), H: n('bTH')};
}

export function recompute(){
  readIntoProject();
  const caseLink = linkFor(project, 'tertiary');
  const status = el('bStatus');
  selected = null; el('bUse').disabled = true;
  let envInfo = '';
  try{
    if(project.primary.allowedOrientations.length === 0)
      throw new Error('select at least one envelope orientation');
    const col = collate(project.primary.collation);
    envInfo = `Envelope ${fmtLen(col.envelope.L, unit)} × ${fmtLen(col.envelope.W, unit)} × ${fmtLen(col.envelope.H, unit)} ${unit}` +
      ` · ${col.count} pieces · fill ${Math.round(col.fillEfficiency*100)}% (informational — never feeds pallet numbers)`;
    if(caseLink.locked){
      const row = checkLockedCase(project, rounding);
      rows = [row];
      status.textContent = row.fits
        ? `Locked case holds ${row.capacity} cartons (${caseLink.count} required) — OK`
        : `Locked case: holds ${row.capacity} of ${caseLink.count} cartons` +
          (row.primaryFits ? '' : '; collation does not fit the carton') + ' — DOES NOT FIT';
      status.className = row.fits ? 'bnote' : 'bnote bbad';
    }else{
      rows = candidateCases(project, rounding);
      const bad = rows.filter(r => !r.primaryFits).length;
      status.textContent = `${rows.length} candidate arrangements for ${caseLink.count} cartons — click a row to select` +
        (bad ? ` · ${bad} rows: collation does NOT fit the locked carton` : '');
      status.className = bad ? 'bnote bbad' : 'bnote';
    }
  }catch(e){
    rows = [];
    status.textContent = 'Error: ' + (e.message || e);
    status.className = 'bnote bbad';
  }
  el('bEnvInfo').textContent = envInfo;
  renderTable();
  if(onSelectCb) onSelectCb(null);
}

const COLS = [
  {key: 'arrangementLabel', label: 'Case fill', txt: r => r.arrangementLabel},
  {key: 'primaryLabel', label: 'Stacks in carton', txt: r => r.primaryLabel ? `${r.primaryLabel} (${r.primaryOrientation})` : '—'},
  {key: 'outerL',  label: 'Case outer L×W×H', txt: r => `${fmtLen(r.outer.L, unit)} × ${fmtLen(r.outer.W, unit)} × ${fmtLen(r.outer.H, unit)}`, val: r => r.outer.L*r.outer.W*r.outer.H},
  {key: 'boardAreaM2', label: 'Board m²/case', txt: r => r.boardAreaM2.toFixed(3)},
  {key: 'filmAreaM2', label: 'Film m²/pack', txt: r => r.filmAreaM2 != null ? r.filmAreaM2.toFixed(4) : '—'},
  {key: 'filmKgPerPallet', label: 'Film kg/pallet', txt: r => r.filmKgPerPallet != null ? r.filmKgPerPallet.toFixed(2) : '—'},
  {key: 'casesPerPallet', label: 'Cases/pallet', txt: r => `${r.casesPerPallet} (${r.casesPerLayer}×${r.caseLayers})`},
  {key: 'cartonsPerPallet', label: 'Cartons/pallet', txt: r => r.cartonsPerPallet},
  {key: 'piecesPerPallet', label: 'Pieces/pallet', txt: r => r.piecesPerPallet !== null && r.piecesPerPallet !== undefined ? r.piecesPerPallet : '—'},
  {key: 'coveragePct', label: 'Deck %', txt: r => r.coveragePct},
  {key: 'cubeUtilPct', label: 'Cube %', txt: r => r.cubeUtilPct}
];

function renderTable(){
  const tbl = el('bTable');
  const sorted = [...rows].sort((a, b) => {
    const col = COLS.find(c => c.key === sortKey);
    const va = col && col.val ? col.val(a) : a[sortKey], vb = col && col.val ? col.val(b) : b[sortKey];
    return (va < vb ? -1 : va > vb ? 1 : 0)*sortDir;
  });
  tbl.innerHTML =
    `<thead><tr>${COLS.map(c =>
      `<th data-k="${c.key}">${c.label}${c.key === sortKey ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${sorted.map(r =>
      `<tr data-i="${rows.indexOf(r)}" class="${r === selected ? 'bsel' : ''}${r.primaryFits === false ? ' bmisfit' : ''}">${
        COLS.map(c => `<td>${c.txt(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  tbl.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if(sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
    renderTable();
  }));
  tbl.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
    selected = rows[+tr.dataset.i];
    el('bUse').disabled = false;
    renderTable();
    if(onSelectCb) onSelectCb(selected);
  }));
}

export const getSelected = () => selected;
export const getRows = () => rows;
export const getNest = () => {
  if(!selected) return null;
  const arr = nestArrangement(project, selected);
  const caseGeo = styleById(project.tertiary.styleId).geometry(selected.caseParams);
  return {caseGeo, cartonGeo: arr.cartonGeo, placements: arr.placements};
};
export const getProductNest = () => selected ? productNest(project, selected) : null;
