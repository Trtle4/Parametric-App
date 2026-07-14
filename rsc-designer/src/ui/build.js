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
import {refreshAll} from './notify.js';

export const project = newProject();
let unit = 'mm';
let rounding = '1mm';
let rows = [];
let selected = null;          // a row object, user-picked
// default sort: pieces per pallet, descending. Cases per pallet counts
// boxes on the deck; pieces per pallet counts product that actually ships.
// A case holding fewer cartons can pack MORE cases on a deck, so
// maximizing cases/pallet can ship LESS product — freight is paid to move
// product, not corrugated. Falls back to cartonsPerPallet in renderTable()
// when the chain has no piece concept at all (legacy carton-driven chain).
let sortKey = 'piecesPerPallet', sortDir = -1;

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Best row for each objective column — 'max' for pieces/cases (more is
 *  better), 'min' for board/film area (less material is better). Rows with
 *  a null value (no piece concept, no wrap) are ignored, never treated as
 *  a winning 0. Returns null (no badge) if every row is null for that key,
 *  OR if every non-null row ties — film area/pack, for one, is often the
 *  SAME for every case-arrangement candidate (it depends on the wrap, not
 *  the case), and badging one arbitrarily-first row as "the winner" of a
 *  tie that isn't actually a distinguishing comparison would misrepresent
 *  it as one. */
const BADGE_COLUMNS = {piecesPerPallet: 'max', casesPerPallet: 'max', boardAreaM2: 'min', filmAreaM2: 'min'};
function bestRows(rowList){
  const best = {};
  for(const key of Object.keys(BADGE_COLUMNS)){
    const mode = BADGE_COLUMNS[key];
    let winner = null, allTied = true, firstVal;
    for(const r of rowList){
      const v = r[key];
      if(v === null || v === undefined) continue;
      if(firstVal === undefined) firstVal = v; else if(v !== firstVal) allTied = false;
      if(winner === null || (mode === 'max' ? v > winner[key] : v < winner[key])) winner = r;
    }
    best[key] = allTied ? null : winner;
  }
  return best;
}

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
    // cases/pallet and pieces/pallet sit side by side deliberately: cases
    // counts boxes on the deck, pieces counts product that actually ships —
    // maximizing the former can ship LESS of the latter (a case that holds
    // fewer cartons packs more cases per deck), so the divergence needs to
    // be visible in adjacent columns, not just default-sorted apart.
    {key: 'casesPerPallet', label: `${outerCap}s/pallet`, txt: r => `${r.casesPerPallet} (${r.casesPerLayer}×${r.caseLayers})`},
    {key: 'piecesPerPallet', label: 'Pieces/pallet', txt: r => r.piecesPerPallet !== null && r.piecesPerPallet !== undefined ? r.piecesPerPallet : '—'},
    {key: 'cartonsPerPallet', label: outerKey === 'tertiary' ? `${childCap}s/pallet` : 'Units/pallet', txt: r => r.cartonsPerPallet},
    {key: 'coveragePct', label: 'Deck %', txt: r => r.coveragePct},
    {key: 'cubeUtilPct', label: 'Cube %', txt: r => r.cubeUtilPct}
  ];
}

export function initBuild(startUnit){
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

/**
 * THE one chain resolution: re-enumerate the outermost tier's candidates
 * (or check the locked dims) against the CURRENT project, render the table,
 * and — its own last step — run every registered display refresher
 * (notify.refreshAll). Every control that mutates the project calls this
 * (directly, or via app.js's projectChanged wrapper); nothing calls the
 * refreshers separately, so nothing can be missing from a hand-kept list.
 *
 * `preserveKey` is the candidate to try to re-select once the fresh rows
 * are in: defaults to whatever is CURRENTLY selected, so a rail edit
 * elsewhere never silently drops the operator's pick (this used to be a
 * separate reselectByKey() call bolted on by callers that remembered to —
 * loadProject and refreshPanel did, nothing else did). Pass an explicit key
 * (including null) to select something else instead — loadProject uses
 * this for the file's own saved selection, which "currently selected"
 * would be meaningless for before a load has happened.
 */
export function recompute(preserveKey){
  const key = preserveKey !== undefined ? preserveKey : getSelectedCandidateKey();
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
      // cases/pallet counts boxes on the deck; pieces/pallet counts product
      // that actually ships. Checked here in case a future change decouples
      // them, but today this can NEVER fire within one enumeration: every
      // row here holds the SAME cartons-per-case count (link.count) and the
      // same piecesPerCarton (fixed per project, not per candidate shape) —
      // only the CASE's shape varies row to row — so piecesPerPallet is an
      // exact constant multiple of casesPerPallet for every fitting row
      // (verified: the ratio locks at one value across every non-zero row).
      // The trade the prompt describes — a case holding fewer cartons but
      // fitting more of them on the deck — is real, but it's a comparison
      // across DIFFERENT cartons-per-case settings, which isn't what a
      // single candidateCases() call enumerates; it holds that count fixed
      // and varies the shape. Surfacing THAT trade would mean comparing
      // across count settings, not rows of one table — flagged, not built.
      const best = bestRows(rows);
      const disagree = best.piecesPerPallet && best.casesPerPallet && best.piecesPerPallet !== best.casesPerPallet;
      status.textContent = `${rows.length} candidate arrangements for ${link.count} ${childNoun}s — click a row to select` +
        (bad ? ` · ${bad} rows: ${childNoun} does NOT fit as configured` : '') +
        (disagree ? ` · Note: the pieces/pallet leader is NOT the ${outerNoun}s/pallet leader — maximizing ${outerNoun}s here would ship less product` : '');
      status.className = bad ? 'bnote bbad' : 'bnote';
    }
  }catch(e){
    rows = [];
    status.textContent = 'Error: ' + (e.message || e);
    status.className = 'bnote bbad';
  }
  renderTable();
  reselectByKey(key);
  refreshAll();
}

function renderTable(){
  const cols = columns();
  const tbl = el('bTable');
  // pieces/pallet is meaningless (always null) for the legacy carton-driven
  // chain (no content/primary stage at all) — fall back to cartonsPerPallet
  // for THIS render rather than sorting by a column that's all em-dashes.
  // Doesn't touch the stored sortKey: a chain shape that DOES have pieces
  // still gets the pieces-based default.
  const noPieces = rows.length > 0 && rows.every(r => r.piecesPerPallet == null);
  const effectiveSortKey = (sortKey === 'piecesPerPallet' && noPieces) ? 'cartonsPerPallet' : sortKey;
  // per-objective winners (Prompt 19, Part C): when one row wins everything
  // that should be obvious; when four different rows win, that's the
  // tradeoff the table exists to surface, not a single number to hand over.
  const best = bestRows(rows);
  const sorted = [...rows].sort((a, b) => {
    const col = cols.find(c => c.key === effectiveSortKey);
    const va = col && col.val ? col.val(a) : a[effectiveSortKey], vb = col && col.val ? col.val(b) : b[effectiveSortKey];
    return (va < vb ? -1 : va > vb ? 1 : 0)*sortDir;
  });
  tbl.innerHTML =
    `<thead><tr>${cols.map(c =>
      `<th data-k="${c.key}">${c.label}${c.key === effectiveSortKey ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${sorted.map(r =>
      `<tr data-i="${rows.indexOf(r)}" class="${r === selected ? 'bsel' : ''}${r.primaryFits === false ? ' bmisfit' : ''}">${
        cols.map(c => {
          const isWin = BADGE_COLUMNS[c.key] && best[c.key] === r;
          return `<td${isWin ? ' class="bwin"' : ''}>${isWin ? '★ ' : ''}${c.txt(r)}</td>`;
        }).join('')}</tr>`).join('')}</tbody>`;
  tbl.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if(sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
    renderTable();
  }));
  tbl.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
    selected = rows[+tr.dataset.i];
    el('bUse').disabled = false;
    renderTable();
    // the rows themselves didn't change, just which one is picked — no
    // need to re-enumerate, but every display bound to "the selected
    // candidate" (the rails' dims boxes, the 2D/3D views, the DXF export)
    // still needs to hear about it
    refreshAll();
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
 *  scratch, re-selecting the candidate the save file named (rather than
 *  whatever happened to be selected before the load, which recompute()'s
 *  own default would otherwise try to preserve). */
export function loadProject({project: loadedProject, rounding: loadedRounding, selectedCandidate}){
  Object.assign(project, loadedProject);
  if(loadedRounding) rounding = loadedRounding;
  recompute(selectedCandidate);
}

/** Re-select the candidate row matching `key` (nx/ny/nz/orientation) if the
 *  freshly recomputed rows still contain a match — called from recompute()
 *  itself, never separately, so nothing can recompute without also trying
 *  to preserve the selection. */
function reselectByKey(key){
  if(!key || !rows.length) return;
  const match = rows.length === 1 ? rows[0] : rows.find(r =>
    r.nx === key.nx && r.ny === key.ny && r.nz === key.nz && r.orientation === key.orientation);
  if(match){
    selected = match;
    el('bUse').disabled = false;
    renderTable();
  }
}

/** Recompute the table FROM the current project (without replacing it),
 *  preserving the picked candidate — recompute()'s own default behavior
 *  now, so this is a thin, documented named entry point for "the Build tab
 *  was just shown" rather than a second reselection path. */
export function refreshPanel(){
  recompute();
}
