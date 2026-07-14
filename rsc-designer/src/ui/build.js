/**
 * The Build view: the candidate comparison table ONLY. Enumerates every
 * arrangement of the outermost enabled tier (the case, or — with the case
 * disabled, Step 4 — the carton itself), runs each through to the pallet,
 * and lets the engineer pick. Never auto-selects a winner: rows are ranked
 * visibly, the choice belongs to the engineer.
 *
 * Every dimensional and packaging INPUT (style params, orientation,
 * clearance, child count/arrangement, locks) lives in the rails
 * (inputs.js/app.js) now — this module owns none of them. It reads the
 * live `project` (the single source of truth) and writes back only two
 * things: the rounding setting, and which candidate is currently selected.
 */
import {newProject, candidateCases, checkLockedCase, resolveChainShape, describeChain,
        linkFor, ROUNDING} from '../core/project.js';
import {fmtLen} from '../core/units.js';
import {el} from './inputs.js';

export const project = newProject();
let unit = 'mm';
let rounding = '1mm';
let rows = [];
let selected = null;          // a row object, user-picked
let sortKey = 'cartonsPerPallet', sortDir = -1;
let onSelectCb = null;

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** The link governing the outermost tier's own enumeration — 'tertiary'
 *  (the case) normally, or 'secondary' (the carton) once the case is
 *  disabled. The legacy bare-carton chain (project.primary === null,
 *  predates optional levels) is always case-enumerated. */
function outerLink(){
  const outerKey = project.primary ? resolveChainShape(project).outermost : 'tertiary';
  return {outerKey, link: linkFor(project, outerKey)};
}

function columns(){
  const {outerNoun, childNoun} = describeChain(project);
  const outerCap = cap(outerNoun), childCap = cap(childNoun);
  const {outerKey} = outerLink();
  return [
    {key: 'arrangementLabel', label: `${outerCap} fill`, txt: r => r.arrangementLabel},
    {key: 'primaryLabel', label: `Stacks in ${childNoun}`, txt: r => r.primaryLabel ? `${r.primaryLabel} (${r.primaryOrientation})` : '—'},
    {key: 'outerL', label: `${outerCap} outer L×W×H`, txt: r => `${fmtLen(r.outer.L, unit)} × ${fmtLen(r.outer.W, unit)} × ${fmtLen(r.outer.H, unit)}`, val: r => r.outer.L*r.outer.W*r.outer.H},
    {key: 'boardAreaM2', label: `Board m²/${outerNoun}`, txt: r => r.boardAreaM2.toFixed(3)},
    {key: 'filmAreaM2', label: 'Film m²/pack', txt: r => r.filmAreaM2 != null ? r.filmAreaM2.toFixed(4) : '—'},
    {key: 'filmKgPerPallet', label: 'Film kg/pallet', txt: r => r.filmKgPerPallet != null ? r.filmKgPerPallet.toFixed(2) : '—'},
    {key: 'casesPerPallet', label: `${outerCap}s/pallet`, txt: r => `${r.casesPerPallet} (${r.casesPerLayer}×${r.caseLayers})`},
    {key: 'cartonsPerPallet', label: outerKey === 'tertiary' ? `${childCap}s/pallet` : 'Units/pallet', txt: r => r.cartonsPerPallet},
    {key: 'piecesPerPallet', label: 'Pieces/pallet', txt: r => r.piecesPerPallet !== null && r.piecesPerPallet !== undefined ? r.piecesPerPallet : '—'},
    {key: 'coveragePct', label: 'Deck %', txt: r => r.coveragePct},
    {key: 'cubeUtilPct', label: 'Cube %', txt: r => r.cubeUtilPct}
  ];
}

export function initBuild(onSelect, startUnit){
  onSelectCb = onSelect;
  unit = startUnit || 'mm';
  el('buildWrap').innerHTML =
    `<div class="bpanel">
      <div class="brow"><label>Round cavities up to</label>
        <select id="bRound">${Object.keys(ROUNDING).map(k => `<option${k === rounding ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      <div id="bStatus" class="bnote"></div>
      <div class="btablewrap"><table id="bTable"></table></div>
      <div class="brow"><button class="btn bapply" id="bUse" disabled>View selected</button></div>
    </div>`;
  el('bRound').addEventListener('change', () => { rounding = el('bRound').value; recompute(); });
  recompute();
}

/** The table's length-bearing columns (case/carton outer) just re-render in
 *  the new unit on the next recompute — there are no editable length
 *  FIELDS left in this panel to convert in place. */
export function onUnitsChanged(next){
  unit = next;
  recompute();
}

export function recompute(){
  const status = el('bStatus');
  selected = null; if(el('bUse')) el('bUse').disabled = true;
  const {outerNoun, childNoun} = describeChain(project);
  const {link} = outerLink();

  try{
    if(link.locked){
      const row = checkLockedCase(project, rounding);
      rows = [row];
      status.textContent = row.fits
        ? `Locked ${outerNoun} holds ${row.capacity} ${childNoun}s (${link.count} required) — OK`
        : `Locked ${outerNoun}: holds ${row.capacity} of ${link.count} ${childNoun}s` +
          (row.primaryFits ? '' : `; ${childNoun} does not fit as configured`) + ' — DOES NOT FIT';
      status.className = row.fits ? 'bnote' : 'bnote bbad';
    }else{
      rows = candidateCases(project, rounding);
      const bad = rows.filter(r => !r.primaryFits).length;
      status.textContent = `${rows.length} candidate arrangements for ${link.count} ${childNoun}s — click a row to select` +
        (bad ? ` · ${bad} rows: ${childNoun} does NOT fit as configured` : '');
      status.className = bad ? 'bnote bbad' : 'bnote';
    }
  }catch(e){
    rows = [];
    status.textContent = 'Error: ' + (e.message || e);
    status.className = 'bnote bbad';
  }
  renderTable();
  if(onSelectCb) onSelectCb(null);
}

function renderTable(){
  const cols = columns();
  const tbl = el('bTable');
  const sorted = [...rows].sort((a, b) => {
    const col = cols.find(c => c.key === sortKey);
    const va = col && col.val ? col.val(a) : a[sortKey], vb = col && col.val ? col.val(b) : b[sortKey];
    return (va < vb ? -1 : va > vb ? 1 : 0)*sortDir;
  });
  tbl.innerHTML =
    `<thead><tr>${cols.map(c =>
      `<th data-k="${c.key}">${c.label}${c.key === sortKey ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${sorted.map(r =>
      `<tr data-i="${rows.indexOf(r)}" class="${r === selected ? 'bsel' : ''}${r.primaryFits === false ? ' bmisfit' : ''}">${
        cols.map(c => `<td>${c.txt(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
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
export const getRounding = () => rounding;

/** A stable, re-derivable identifier for the currently-selected candidate
 *  row (nx/ny/nz/orientation) — never the row itself, which carries
 *  derived geometry/placements that the save document must not contain. */
export function getSelectedCandidateKey(){
  if(!selected) return null;
  return {nx: selected.nx, ny: selected.ny, nz: selected.nz, orientation: selected.orientation};
}

/** Load a project wholesale: replace the live model's fields (project is a
 *  module-level const, so this mutates it in place — anyone holding the
 *  exported reference sees the update) and recompute the table from
 *  scratch. Then re-select the candidate the save file named, if the
 *  freshly recomputed rows still contain a match. */
export function loadProject({project: loadedProject, rounding: loadedRounding, selectedCandidate}){
  Object.assign(project, loadedProject);
  if(loadedRounding) rounding = loadedRounding;
  recompute();
  reselectByKey(selectedCandidate);
}

/** Re-select the candidate row matching `key` (nx/ny/nz/orientation) if the
 *  freshly recomputed rows still contain a match — the single re-selection
 *  path shared by loadProject and refreshPanel. */
function reselectByKey(key){
  if(!key || !rows.length) return;
  const match = rows.length === 1 ? rows[0] : rows.find(r =>
    r.nx === key.nx && r.ny === key.ny && r.nz === key.nz && r.orientation === key.orientation);
  if(match){
    selected = match;
    el('bUse').disabled = false;
    renderTable();
    if(onSelectCb) onSelectCb(selected);
  }
}

/** Recompute the table FROM the current project (without replacing it),
 *  preserving the picked candidate. Called when the Build tab is shown, so
 *  it reflects edits made in the rails rather than showing a stale table. */
export function refreshPanel(){
  const key = getSelectedCandidateKey();
  recompute();
  reselectByKey(key);
}
