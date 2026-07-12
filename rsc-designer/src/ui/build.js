/**
 * The Build view: the configuration surface for the carton -> case -> pallet
 * chain. Owns its own DOM (inside #buildWrap), maintains the Project, runs
 * candidateCases, and renders the sortable comparison table. All Build
 * inputs are mm (labelled as such) regardless of the main display unit.
 *
 * Never auto-selects a winner: rows are ranked visibly, the engineer picks.
 */
import {newProject, candidateCases, checkLockedCase, nestArrangement, ROUNDING} from '../core/project.js';
import {styleById} from '../core/styles/index.js';
import {el} from './inputs.js';

export const project = newProject();
let rounding = '1mm';
let rows = [];
let selected = null;          // a row object, user-picked
let sortKey = 'cartonsPerPallet', sortDir = -1;
let onSelectCb = null;

// orientation checkbox groups: explicit axis mappings, no hidden defaults.
// "Inverted" occupies the same space as upright (the orientation model
// captures axis mapping, not flip parity) — recorded for future use.
const ORIENT_GROUPS = [
  {key: 'upright',  label: 'Upright (H vertical)',            orients: ['LWH', 'WLH'], default: true},
  {key: 'onSide',   label: 'On side (W vertical)',            orients: ['LHW', 'HLW'], default: false},
  {key: 'onEnd',    label: 'On end (L vertical)',             orients: ['WHL', 'HWL'], default: false},
  {key: 'inverted', label: 'Inverted (H vertical, flipped)',  orients: ['LWH', 'WLH'], default: false}
];

const html = String.raw;

export function initBuild(onSelect){
  onSelectCb = onSelect;
  const sec = project.secondary, ter = project.tertiary;
  const sp = sec.params, tp = ter.params;
  el('buildWrap').innerHTML = html`
  <div class="bpanel">
    <div class="bcols">
      <fieldset><legend>Carton (ECMA A6120)</legend>
        <div class="brow"><label>L</label><input id="bL" type="number" value="${sp.L}"><span>mm</span>
          <label>W</label><input id="bW" type="number" value="${sp.W}"><span>mm</span>
          <label>H</label><input id="bH" type="number" value="${sp.H}"><span>mm</span></div>
        <div class="brow"><label>Caliper</label><input id="bCal" type="number" step="0.001" value="${sp.caliper}"><span>mm</span></div>
        <div class="brow bnote">Other carton params follow the A6120 style view.</div>
        <div class="brow"><label>Orientations</label></div>
        ${ORIENT_GROUPS.map(o => html`<div class="brow bchk"><label><input type="checkbox" id="bo_${o.key}" ${o.default ? 'checked' : ''}> ${o.label}</label></div>`).join('')}
      </fieldset>
      <fieldset><legend>Case content</legend>
        <div class="brow"><label>Cartons/case</label>
          <select id="bCountSel"><option>12</option><option>24</option><option>36</option><option value="custom">custom</option></select>
          <input id="bCount" type="number" min="1" value="12" style="display:none"></div>
        <div class="brow"><label>Arrangement</label>
          <select id="bArr"><option value="auto">auto</option><option value="explicit">nx × ny × nz</option></select>
          <span id="bArrN" style="display:none">
            <input id="bNx" type="number" min="1" value="4" class="bshort"> ×
            <input id="bNy" type="number" min="1" value="3" class="bshort"> ×
            <input id="bNz" type="number" min="1" value="1" class="bshort"></span></div>
        <div class="brow"><label>Clearance wall</label><input id="bWall" type="number" step="0.1" value="1.5"><span>mm</span>
          <label>between</label><input id="bBetween" type="number" step="0.1" value="0"><span>mm</span></div>
        <div class="brow bnote">Clearance defaults are placeholders to review, not truth.
          Vertical is non-uniform: cartons bear on the case floor (0), no headspace (0).</div>
        <div class="brow"><label>Round cavity up to</label>
          <select id="bRound">${Object.keys(ROUNDING).map(k => `<option${k === rounding ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      </fieldset>
      <fieldset><legend>Case (FEFCO 201)</legend>
        <div class="brow"><label>Caliper</label><input id="bTCal" type="number" step="0.1" value="${tp.caliper}"><span>mm</span></div>
        <div class="brow"><label>Glue flap</label><input id="bTGlue" type="number" value="${tp.glue}"><span>mm</span>
          <label>Slot</label><input id="bTSlot" type="number" step="0.5" value="${tp.slot}"><span>mm</span></div>
        <div class="brow bchk"><label><input type="checkbox" id="bLock"> Lock case dims (check fit only)</label></div>
        <div class="brow" id="bLockDims" style="display:none"><label>L</label><input id="bTL" type="number" value="407"><span>mm</span>
          <label>W</label><input id="bTW" type="number" value="186"><span>mm</span>
          <label>H</label><input id="bTH" type="number" value="152"><span>mm</span></div>
        <div class="brow"><button class="btn bapply" id="bUse" disabled>Use selected as case</button></div>
      </fieldset>
    </div>
    <div id="bStatus" class="bnote"></div>
    <div class="btablewrap"><table id="bTable"></table></div>
  </div>`;

  const rewire = ids => ids.forEach(id => el(id).addEventListener('input', recompute));
  rewire(['bL', 'bW', 'bH', 'bCal', 'bCount', 'bWall', 'bBetween', 'bNx', 'bNy', 'bNz', 'bTCal', 'bTGlue', 'bTSlot', 'bTL', 'bTW', 'bTH']);
  ORIENT_GROUPS.forEach(o => el('bo_' + o.key).addEventListener('change', recompute));
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
  recompute();
}

function readIntoProject(){
  const n = id => +el(id).value || 0;
  const sec = project.secondary, ter = project.tertiary, link = project.links[0];
  sec.params = {...sec.params, L: n('bL'), W: n('bW'), H: n('bH'), caliper: n('bCal')};
  const orients = [];
  for(const o of ORIENT_GROUPS)
    if(el('bo_' + o.key).checked) for(const s of o.orients) if(!orients.includes(s)) orients.push(s);
  sec.allowedOrientations = orients;
  sec.clearance = {wall: n('bWall'), between: n('bBetween'), bottom: 0, top: 0, betweenZ: 0};
  ter.params = {...ter.params, caliper: n('bTCal'), glue: n('bTGlue'), slot: n('bTSlot')};
  link.count = Math.max(1, Math.round(n('bCount')));
  link.locked = el('bLock').checked;
  link.arrangement = el('bArr').value === 'auto' ? 'auto'
    : {nx: Math.max(1, n('bNx')), ny: Math.max(1, n('bNy')), nz: Math.max(1, n('bNz'))};
  if(link.locked) ter.params = {...ter.params, L: n('bTL'), W: n('bTW'), H: n('bTH')};
}

export function recompute(){
  readIntoProject();
  const link = project.links[0];
  const status = el('bStatus');
  selected = null; el('bUse').disabled = true;
  try{
    if(project.secondary.allowedOrientations.length === 0)
      throw new Error('select at least one carton orientation');
    if(link.locked){
      const row = checkLockedCase(project, rounding);
      rows = [row];
      status.textContent = row.fits
        ? `Locked case holds ${row.capacity} cartons (${link.count} required) — OK`
        : `Locked case holds only ${row.capacity} of ${link.count} cartons — DOES NOT FIT`;
      status.className = row.fits ? 'bnote' : 'bnote bbad';
    }else{
      rows = candidateCases(project, rounding);
      status.textContent = `${rows.length} candidate arrangements for ${link.count} cartons — click a row to select`;
      status.className = 'bnote';
    }
  }catch(e){
    rows = [];
    status.textContent = 'Error: ' + (e.message || e);
    status.className = 'bnote bbad';
  }
  renderTable();
  if(onSelectCb) onSelectCb(null);
}

const COLS = [
  {key: 'arrangementLabel', label: 'Arrangement', txt: r => r.arrangementLabel},
  {key: 'outerL',  label: 'Case outer L×W×H (mm)', txt: r => `${r.outer.L.toFixed(1)} × ${r.outer.W.toFixed(1)} × ${r.outer.H.toFixed(1)}`, val: r => r.outer.L*r.outer.W*r.outer.H},
  {key: 'boardAreaM2', label: 'Board m²/case', txt: r => r.boardAreaM2.toFixed(3)},
  {key: 'casesPerPallet', label: 'Cases/pallet', txt: r => `${r.casesPerPallet} (${r.casesPerLayer}×${r.caseLayers})`},
  {key: 'cartonsPerPallet', label: 'Cartons/pallet', txt: r => r.cartonsPerPallet},
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
    `<tbody>${sorted.map((r, i) =>
      `<tr data-i="${rows.indexOf(r)}"${r === selected ? ' class="bsel"' : ''}>${
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
export const getNest = () => {
  if(!selected) return null;
  const arr = nestArrangement(project, selected);
  const caseGeo = styleById(project.tertiary.styleId).geometry(selected.caseParams);
  return {caseGeo, cartonGeo: arr.cartonGeo, placements: arr.placements};
};
