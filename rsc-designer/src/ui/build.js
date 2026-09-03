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
        linkFor, defaultCandidate, ROUNDING, deckCoveragePct} from '../core/project.js';
import {fmtMoney} from '../core/cost.js';
import {fmtLen} from '../core/units.js';
import {layerPlanGeometry} from '../core/layerplan.js';
import {layerPlanSVG} from '../render/layerplan2d.js';
import {el} from './inputs.js';
import {refreshAll} from './notify.js';

export const project = newProject();
let unit = 'mm';
let rounding = '1mm';
let rows = [];
let selected = null;          // a row object, user-picked
let cycleListener = null;     // 3D arrows' UI updater (set by app.js), called on every renderTable
// default sort: pieces per pallet, descending. Cases per pallet counts
// boxes on the deck; pieces per pallet counts product that actually ships.
// A case holding fewer cartons can pack MORE cases on a deck, so
// maximizing cases/pallet can ship LESS product — freight is paid to move
// product, not corrugated. Falls back to cartonsPerPallet in renderTable()
// when the chain has no piece concept at all (legacy carton-driven chain).
let sortKey = 'piecesPerPallet', sortDir = -1;
// DISPLAY cap: with a cartons-per-case range the evaluated set can be large, so
// show only the top N candidates by cartons/pallet (the ranking priority).
// Applied AFTER complete evaluation and only when exceeded, so the best
// candidate is always present and nothing viable is ever silently dropped from
// the analysis — the cap only trims the tail of the DISPLAY. No remainder is
// shown (no "N of M total", no page 2): narrow/widen the range to reshape the
// set. Bump this one constant to change the cap. Single-count chains produce
// far fewer than this, so the default path is untouched (order preserved).
const CANDIDATE_CAP = 50;

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
const BADGE_COLUMNS = {piecesPerPallet: 'max', casesPerPallet: 'max', boardAreaM2: 'min',
                       filmAreaM2: 'min', costPer1000: 'min'};
function bestRows(rowList){
  const best = {};
  // read through the COLUMN's own accessor, the same one the table sorts by,
  // so a column whose value is not a bare row field (cost lives on row.cost)
  // can be badged at all — reading r[key] here silently skipped it.
  const cols = columns();
  for(const key of Object.keys(BADGE_COLUMNS)){
    const mode = BADGE_COLUMNS[key];
    const col = cols.find(c => c.key === key);
    const read = col && col.val ? col.val : (r => r[key]);
    let winner = null, allTied = true, firstVal;
    for(const r of rowList){
      const v = read(r);
      if(v === Infinity) continue;
      if(v === null || v === undefined) continue;
      if(firstVal === undefined) firstVal = v; else if(v !== firstVal) allTied = false;
      if(winner === null || (mode === 'max' ? v > read(winner) : v < read(winner))) winner = r;
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

/** Has this candidate a complete material cost? The pallet term is the one
 *  that can go missing on an otherwise valid row (nothing fits the deck). */
const costable = r => !!(r.cost && r.cost.per1000Packs != null && !r.cost.missing.includes('pallet'));

function columns(){
  const {outerNoun, childNoun} = describeChain(project);
  const outerCap = cap(outerNoun), childCap = cap(childNoun);
  const {outerKey} = outerLink();
  return [
    {key: 'arrangementLabel', label: `${outerCap} fill`, txt: r => r.arrangementLabel},
    // which of the child's axes stands vertical in this candidate (o[2]). The
    // vertical axis is a comparison variable now (L/W/H multi-select), so the
    // table ranks across BOTH arrangement AND standing orientation — this column
    // names the axis so rows from different axes are told apart at a glance.
    {key: 'verticalAxis', label: 'Vertical', txt: r => ({H: 'H-up', L: 'L-up', W: 'W-up'}[(r.orientation || '')[2]] || '—'), val: r => (r.orientation || '')[2]},
    // the candidate's own cartons-per-case count — varies row to row once the
    // count is a range, so it's shown explicitly. (Wraps-per-carton gets the
    // same treatment in a later pass; a "Wraps/carton" column slots in here.)
    {key: 'cartonsPerCase', label: `${childCap}s/${outerNoun}`, txt: r => r.cartonsPerCase != null ? r.cartonsPerCase : '—', val: r => r.cartonsPerCase},
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
    // MATERIAL COST, per 1000 packs rather than per pack: a pack's board is
    // fractions of a cent and would round to a column of identical zeros,
    // while per-1000 is the unit a purchasing conversation already uses.
    // Reads row.cost — the chain's one derivation — so this column and the
    // rate panel can never show different money. Badged 'min': unlike the
    // count columns, less is better, and THIS is the column's point — a
    // candidate that uses more board but palletizes better can now be
    // compared on cost rather than only on count.
    {key: 'costPer1000', label: '$/1000 packs',
     // a candidate that palletizes NOTHING has no pallet trip to share and no
     // packs shipped to share it over, so its material cost is not comparable
     // with the rest — it reads '—' and sorts last rather than showing a
     // materials-only figure that looks competitive beside complete ones
     txt: r => costable(r) ? fmtMoney(r.cost.per1000Packs) : '—',
     val: r => costable(r) ? r.cost.per1000Packs : Infinity},
    {key: 'coveragePct', label: 'Deck %', txt: r => r.coveragePct},
    {key: 'cubeUtilPct', label: 'Cube %', txt: r => r.cubeUtilPct}
  ];
}

export function initBuild(startUnit){
  unit = startUnit || 'mm';
  el('buildWrap').innerHTML =
    `<div class="bpanel" id="bCasePanel">
      <div class="brow"><label>Round cavities up to</label>
        <select id="bRound">${Object.keys(ROUNDING).map(k => `<option${k === rounding ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      <div id="bStatus" class="bnote"></div>
      <div class="btablewrap"><table id="bTable"></table></div>
      <div class="brow"><button class="btn bapply" id="bUse" disabled>View selected</button></div>
    </div>
    <div class="bpanel" id="bPatternPanel" style="display:none">
      <div class="brow bpviewrow">
        <label>View</label>
        <div class="seg bpviewtoggle" id="bPatternViewToggle">
          <button type="button" class="on" data-view="table">Table</button>
          <button type="button" data-view="thumbs">Thumbnails</button>
        </div>
      </div>
      <div id="bPatternStatus" class="bnote"></div>
      <div class="btablewrap" id="bPatternTableWrap"><table id="bPatternTable"></table></div>
      <div class="bpthumbgrid" id="bPatternThumbs" style="display:none"></div>
    </div>`;
  el('bRound').addEventListener('change', () => { rounding = el('bRound').value; recompute(); });
  for(const btn of el('bPatternViewToggle').querySelectorAll('button'))
    btn.addEventListener('click', () => setPatternView(btn.dataset.view));
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
      // The evaluation is complete (every count × arrangement × axis solved);
      // the DISPLAY is capped to the top CANDIDATE_CAP by cartons/pallet — the
      // ranking priority — so the best is always shown and no viable option is
      // dropped from the analysis, only from the list's tail. No remainder is
      // reported (see CANDIDATE_CAP). Single-count chains produce fewer than the
      // cap, so `rows` is untouched then (same order as before this feature).
      const capped = rows.length > CANDIDATE_CAP;
      if(capped)
        rows = [...rows].sort((a, b) => (b.cartonsPerPallet || 0) - (a.cartonsPerPallet || 0)).slice(0, CANDIDATE_CAP);
      const bad = rows.filter(r => !r.primaryFits).length;
      // cases/pallet counts boxes on the deck; pieces/pallet counts product that
      // ships. With a cartons-per-case RANGE these genuinely diverge — a case
      // holding fewer cartons can fit more cases on the deck yet ship less
      // product — so the note below is now a real comparison across counts, not
      // a can't-happen guard. (pieces/pallet is a fixed multiple of
      // cartons/pallet, so ranking by either is the same order.)
      const best = bestRows(rows);
      const disagree = best.piecesPerPallet && best.casesPerPallet && best.piecesPerPallet !== best.casesPerPallet;
      const ranged = link.arrangement === 'auto' && link.countMax > link.count;
      const countLabel = ranged ? `${link.count}–${link.countMax}` : `${link.count}`;
      status.textContent =
        `${rows.length} candidate${rows.length === 1 ? '' : 's'} for ${countLabel} ${childNoun}s/${outerNoun}` +
        (ranged ? ` — ${capped ? `top ${CANDIDATE_CAP}, ` : ''}ranked by ${childNoun}s/pallet · click a row to select` : ' — click a row to select') +
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
  renderPatternPanel();   // stays fresh even while hidden, so switching setMode('pattern') never shows a stale list
  refreshAll();
}

/** THE ordered candidate list — `rows` sorted by the table's LIVE sort key and
 *  direction. The one source both the Build table AND the 3D cycle arrows read,
 *  so the arrows step in exactly the order the table shows; re-sorting the table
 *  re-orders the arrows too, with no parallel rank order to drift. */
function sortedRows(){
  const cols = columns();
  // pieces/pallet is meaningless (always null) for the legacy carton-driven
  // chain (no content/primary stage at all) — fall back to cartonsPerPallet
  // for THIS render rather than sorting by a column that's all em-dashes.
  // Doesn't touch the stored sortKey: a chain shape that DOES have pieces
  // still gets the pieces-based default.
  const noPieces = rows.length > 0 && rows.every(r => r.piecesPerPallet == null);
  const effectiveSortKey = (sortKey === 'piecesPerPallet' && noPieces) ? 'cartonsPerPallet' : sortKey;
  const col = cols.find(c => c.key === effectiveSortKey);
  return {effectiveSortKey, sorted: [...rows].sort((a, b) => {
    const va = col && col.val ? col.val(a) : a[effectiveSortKey], vb = col && col.val ? col.val(b) : b[effectiveSortKey];
    return (va < vb ? -1 : va > vb ? 1 : 0)*sortDir;
  })};
}

/**
 * Generic candidate-comparison table DOM builder — thead/tbody markup,
 * header-click sort wiring, row-click select wiring. Shared by the case/
 * carton candidate table (renderTable, below) and the pallet-pattern table
 * (renderPatternPanel, further below) so the app has ONE table-rendering
 * mechanism, not two that can drift apart. Each caller supplies its own
 * rows/columns/selection state and is called back on sort/select; this
 * function owns none of it.
 * @param {HTMLTableElement} tbl
 * @param {Object[]} cols  {key, label, txt(row)}
 * @param {Object[]} displayRows  rows in the order to render (pre-sorted by the caller)
 * @param {Object} opts
 * @param {string} [opts.sortKey]  the column key currently sorted (indicator arrow); omit for none
 * @param {number} [opts.sortDir]
 * @param {(row)=>boolean} [opts.isSelected]
 * @param {(row)=>boolean} [opts.isMisfit]
 * @param {(row, col)=>boolean} [opts.isWinner]  star-badges a cell
 * @param {(key)=>void} [opts.onHeaderClick]  omit to make headers unclickable (no re-sort)
 * @param {(row, index)=>void} opts.onRowClick
 */
function renderCandidateTable(tbl, cols, displayRows, opts){
  const {sortKey, sortDir = -1, isSelected = () => false, isMisfit = () => false,
         isWinner = () => false, onHeaderClick, onRowClick} = opts;
  tbl.innerHTML =
    `<thead><tr>${cols.map(c =>
      `<th${onHeaderClick ? ` data-k="${c.key}"` : ''}${c.hint ? ` title="${c.hint}"` : ''}>${c.label}${c.key === sortKey ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${displayRows.map((r, i) =>
      `<tr data-i="${i}" class="${isSelected(r) ? 'bsel' : ''}${isMisfit(r) ? ' bmisfit' : ''}">${
        cols.map(c => {
          const isWin = isWinner(r, c);
          return `<td${isWin ? ' class="bwin"' : ''}>${isWin ? '★ ' : ''}${c.txt(r, i)}</td>`;
        }).join('')}</tr>`).join('')}</tbody>`;
  if(onHeaderClick) tbl.querySelectorAll('th').forEach(th => th.addEventListener('click', () => onHeaderClick(th.dataset.k)));
  tbl.querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => onRowClick(displayRows[+tr.dataset.i], +tr.dataset.i)));
}

function renderTable(){
  const cols = columns();
  const tbl = el('bTable');
  const {effectiveSortKey, sorted} = sortedRows();
  // per-objective winners (Prompt 19, Part C): when one row wins everything
  // that should be obvious; when four different rows win, that's the
  // tradeoff the table exists to surface, not a single number to hand over.
  const best = bestRows(rows);
  renderCandidateTable(tbl, cols, sorted, {
    sortKey: effectiveSortKey, sortDir,
    isSelected: r => r === selected,
    isMisfit: r => r.primaryFits === false,
    isWinner: (r, c) => !!(BADGE_COLUMNS[c.key] && best[c.key] === r),
    onHeaderClick: k => {
      if(sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
      renderTable();
    },
    onRowClick: r => {
      selected = r;
      el('bUse').disabled = false;
      renderTable();
      // the rows themselves didn't change, just which one is picked — no
      // need to re-enumerate, but every display bound to "the selected
      // candidate" (the rails' dims boxes, the 2D/3D views, the DXF export)
      // still needs to hear about it
      refreshAll();
    }
  });
  // the 3D cycle arrows' "N of M" + enable state track the table's live order
  // and selection — renderTable() is the one choke point for both (recompute,
  // re-sort, row-click, reselect, step all end here), so one call keeps them in
  // lockstep, re-sort included (which never runs refreshAll).
  if(cycleListener) cycleListener();
}

/* ---- 3D candidate cycling: a SECOND control onto the selection state ------
 * The prev/next arrows in the 3D view step through the SAME sortedRows() the
 * table shows, and committing is identical to a row click — one index into one
 * ordered list drives the table highlight, the "N of M" readout, and the
 * project's active candidate together. No new packing, no parallel list. */

/** Register the 3D arrows' UI updater; build.js calls it on every renderTable
 *  (so it fires on re-sort too, which doesn't go through refreshAll). */
export function setCycleListener(fn){ cycleListener = fn; }

/** The candidate currently ON SCREEN: the user's pick, or — before any pick —
 *  the same default resolveActiveRow() renders, so the arrows' position matches
 *  what's shown from the first frame. */
function shownRow(){ return selected || (rows.length ? defaultCandidate(rows) : null); }

/** {pos, total, label} for the arrows: pos is the 1-based place of the shown
 *  candidate in the current sort (0 when there are none), total the count,
 *  label its identity ("12 in 2×2×3 · L-up"). The count leads because it can
 *  vary between adjacent candidates that share a grid — so cycling across counts
 *  is visibly distinct even when the arrangement looks the same. */
export function getCycleState(){
  const {sorted} = sortedRows();
  const cur = shownRow();
  const i = cur ? sorted.indexOf(cur) : -1;
  const axis = cur ? ({H: 'H', L: 'L', W: 'W'}[(cur.orientation || '')[2]] || '?') : '';
  return {pos: i < 0 ? 0 : i + 1, total: sorted.length,
          label: cur ? `${cur.cartonsPerCase} in ${cur.nx}×${cur.ny}×${cur.nz} · ${axis}-up` : ''};
}

/** Move the selection `delta` places along the current sort and COMMIT it,
 *  exactly as clicking that row would. Clamps at the ends (no wrap). */
export function stepCandidate(delta){
  const {sorted} = sortedRows();
  if(!sorted.length) return;
  const cur = shownRow();
  const base = cur ? sorted.indexOf(cur) : -1;
  const next = Math.max(0, Math.min(sorted.length - 1, base + delta));
  if(sorted[next] === selected) return;           // already there (e.g. clamped at an end)
  selected = sorted[next];
  if(el('bUse')) el('bUse').disabled = false;
  renderTable();                                   // moves the table highlight + updates the arrows
  refreshAll();                                    // commits: 3D/2D/pallet/readouts/DXF follow
}

export const getSelected = () => selected;
export const getRows = () => rows;
export const getRounding = () => rounding;

/* ---- pallet-pattern cycling: the SAME arrows, one depth further out ------
 * At pallet depth the prev/next arrows step project.pallet.patternIndex
 * through the ACTIVE row's ranked pattern list (palletpatterns.js via
 * chainMetrics — the list every consumer reads; no parallel list). The
 * index is project state (a committed design decision, like the selected
 * candidate); stepping refreshes every registered display. Clamps at the
 * ends, no wrap — same contract as stepCandidate. */

/** The active row's ranked pattern list + the clamped current index. */
function patternState(){
  const row = shownRow();
  const list = (row && row.patternList) || [];
  const raw = project.pallet.patternIndex > 0 ? Math.floor(project.pallet.patternIndex) : 0;
  return {list, index: Math.max(0, Math.min(list.length - 1, raw))};
}

/** Test hook: the pallet-pattern table's own data, read the same way
 *  renderPatternPanel() does — the active row's ranked pattern list and
 *  the clamped current index into it. Lets a pin assert the RENDERED
 *  table's row content against the exact same source the renderer reads,
 *  without re-deriving palletPatternList a second time. */
export function getPatternRows(){ return patternState().list; }
export function getPatternIndex(){ return patternState().index; }

/** {pos, total, label} for the arrows at pallet depth: the selected
 *  pattern's 1-based rank, the family-filtered list size, and its identity
 *  ("60 · 5 × 2 grid"). Count leads, like the case-cycle label. */
export function getPatternCycleState(){
  const {list, index} = patternState();
  const cand = list[index];
  return {pos: list.length ? index + 1 : 0, total: list.length,
          label: cand ? `${cand.total} · ${cand.label}` : ''};
}

/** Step the pattern selection and COMMIT it — every display registered with
 *  the ONE notifier follows (readout, BCT, 3D render, dims). */
export function stepPattern(delta){
  const {list, index} = patternState();
  if(!list.length) return;
  const next = Math.max(0, Math.min(list.length - 1, index + delta));
  if(next === index && project.pallet.patternIndex === index) return;   // clamped at an end
  project.pallet.patternIndex = next;
  if(cycleListener) cycleListener();               // arrows' N-of-M updates even before the refresh lands
  refreshAll();                                    // commits: readout/BCT/3D/dims follow
}

/* ---- pallet-pattern COMPARISON TABLE ---------------------------------
 * Build's pallet-level counterpart to the case/carton candidate table
 * above — same table mechanism (renderCandidateTable), same "click a row
 * to select" idiom, but ONE row per palletpatterns.js candidate, in that
 * module's own ranked order (no re-sort: the '#' column IS the row's
 * position, so re-sorting would make that column lie). Selecting a row
 * writes project.pallet.patternIndex directly — the SAME field
 * stepPattern() above already writes and applyPatternSelection() already
 * reads (see project.js) — never a second, view-local "which pattern is
 * picked" that could disagree with the one the cycle arrows/BCT/3D/trailer
 * already follow. */

/** Efficiency denominator, stated once, read everywhere this column is
 *  labelled: `utilization` (palletpatterns.js) is volumetric fill against
 *  the FULL max-load-height cavity (project.pallet.maxH - baseH), not
 *  against each candidate's own achieved stack height — a shorter stack
 *  in a taller budget reads as LOWER cube efficiency here, on purpose,
 *  since the deck is committed to the max height regardless of how full a
 *  given pattern happens to leave it. The header/hint below is the one
 *  place that convention is named. */
const CUBE_EFF_HINT = 'against the max load height budget, not the achieved stack height';

function patternColumns(){
  const row = shownRow();
  const outer = row ? row.outer : null;
  const perPalletMultiplier = row ? row.perPalletMultiplier : 1;
  // "cartons per pallet" only means something when a carton actually sits
  // in this chain — a wrap feeding the case directly has none to count.
  // Reads the SAME fact the case table's own column label switches on
  // (outerKey/childNoun), never re-derives whether a carton exists.
  const cartonInChain = project.secondary.enabled !== false;
  return [
    {key: 'index', label: '#', txt: (r, i) => i + 1},
    {key: 'family', label: 'Family', txt: r => r.family},
    {key: 'perLayer', label: 'Per layer', txt: r => r.perLayer},
    {key: 'layers', label: 'Layers', txt: r => r.layers},
    {key: 'total', label: 'Cases/pallet', txt: r => r.total},
    {key: 'cartonsPerPallet', label: 'Cartons/pallet',
     txt: r => cartonInChain ? r.total*perPalletMultiplier : '—'},
    {key: 'areaEff', label: `Area eff. %`, hint: 'top-layer footprint against the whole deck area',
     txt: r => outer ? `${deckCoveragePct(r, outer, project.pallet)}%` : '—'},
    {key: 'cubeEff', label: `Cube eff. %`, hint: CUBE_EFF_HINT,
     txt: r => `${Math.round(r.utilization*100)}%`},
    {key: 'lenUnused', label: 'Length unused',
     txt: r => fmtLen(Math.max(0, project.pallet.L - r.envelope.L), unit)},
    {key: 'widUnused', label: 'Width unused',
     txt: r => fmtLen(Math.max(0, project.pallet.W - r.envelope.W), unit)},
    {key: 'overhang', label: 'Overhang',
     txt: r => r.loadOverhang ? `${fmtLen(r.loadOverhang.L, unit)} × ${fmtLen(r.loadOverhang.W, unit)}` : '—'},
    {key: 'interlockable', label: 'Interlockable',
     txt: r => r.interlockable ? 'yes' : 'no'}
  ];
}

/** ONE writer for "which pattern is selected", called from BOTH the table's
 *  row click and the thumbnail grid's card click — never two independent
 *  click handlers that both happen to write project.pallet.patternIndex,
 *  which is exactly the kind of duplication CLAUDE.md warns diverges. */
function selectPattern(i){
  project.pallet.patternIndex = i;
  renderPatternPanel();
  if(cycleListener) cycleListener();
  refreshAll();
}

/** THUMBNAILS. A cache keyed by the CANDIDATE OBJECT itself, not its index —
 *  a fresh solve (case dims, deck size, clearance... anything that changes
 *  the pattern list) hands back brand-new candidate objects, so a WeakMap
 *  invalidates itself by construction: an old list's entries are simply
 *  unreachable once nothing still references those objects, never a stale
 *  hit keyed by a recycled index. Built LAZILY relative to the view the
 *  panel is actually showing — nothing here runs while the table is up;
 *  the first switch to Thumbnails builds every visible candidate's SVG in
 *  one pass (each one is a few KB of pure vector math, no 3D capture, so
 *  that pass is cheap even at this list's usual size), and reselecting a
 *  candidate afterward reuses the cached markup instead of rebuilding it. */
const thumbCache = new WeakMap();

function thumbSVGFor(cand, outer){
  let svg = thumbCache.get(cand);
  if(svg == null){
    const geo = layerPlanGeometry(cand.build(), outer);
    svg = layerPlanSVG(geo, project.pallet, {width: 168, height: 128});
    thumbCache.set(cand, svg);
  }
  return svg;
}

function renderPatternThumbs(list, index, outer){
  const host = el('bPatternThumbs');
  if(!host) return;
  if(!outer){ host.innerHTML = ''; return; }
  host.innerHTML = list.map((cand, i) =>
    `<div class="bpthumb${i === index ? ' bpthumb-sel' : ''}" data-i="${i}" tabindex="0" role="button" ` +
      `aria-label="Pattern ${i + 1}: ${cand.label}, ${cand.total} cases">` +
      thumbSVGFor(cand, outer) +
      `<div class="bpthumb-cap">#${i + 1} · ${cand.total}</div></div>`
  ).join('');
  for(const card of host.querySelectorAll('.bpthumb')){
    const i = +card.dataset.i;
    const pick = () => selectPattern(i);
    card.addEventListener('click', pick);
    card.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); pick(); } });
  }
}

/** 'table' | 'thumbs' — an inline view toggle INSIDE the pattern panel,
 *  never a modal: no overlay, no focus trap, no scroll lock, and the 3D
 *  canvas is untouched by either state (see CLAUDE.md's own note on why
 *  this repo's convention for a secondary view is always an in-place panel
 *  swap, matching build.js's own case/pattern setMode() one level up). */
let patternView = 'table';

function setPatternView(next){
  if(patternView === next) return;
  patternView = next;
  const toggle = el('bPatternViewToggle');
  if(toggle) for(const btn of toggle.querySelectorAll('button'))
    btn.classList.toggle('on', btn.dataset.view === next);
  renderPatternPanel();
}
export const getPatternView = () => patternView;

/** Renders whichever of table/thumbnails is active, from ONE status line and
 *  ONE read of the pattern list/index/case-outer — table and thumbnails can
 *  never show a different candidate SET or a different SELECTED one, since
 *  both branches read the same `list`/`index`/`outer` computed once here. */
function renderPatternPanel(){
  const tableWrap = el('bPatternTableWrap'), thumbHost = el('bPatternThumbs');
  const tbl = el('bPatternTable');
  const status = el('bPatternStatus');
  if(!tbl) return;
  const {list, index} = patternState();
  if(tableWrap) tableWrap.style.display = patternView === 'table' ? '' : 'none';
  if(thumbHost) thumbHost.style.display = patternView === 'thumbs' ? '' : 'none';
  if(!list.length){
    tbl.innerHTML = '';
    if(thumbHost) thumbHost.innerHTML = '';
    if(status){ status.textContent = 'No pallet pattern fits the active case.'; status.className = 'bnote bbad'; }
    return;
  }
  if(status){
    status.textContent = `${list.length} pallet pattern${list.length === 1 ? '' : 's'} for the active case — ` +
      (patternView === 'table' ? 'click a row to select' : 'click a thumbnail to select');
    status.className = 'bnote';
  }
  const selectedCand = list[index];
  if(patternView === 'table'){
    const cols = patternColumns();
    renderCandidateTable(tbl, cols, list, {
      isSelected: r => r === selectedCand,
      onRowClick: (r, i) => selectPattern(i)
    });
  }else{
    const row = shownRow();
    renderPatternThumbs(list, index, row ? row.outer : null);
  }
}

let mode = 'case';   // 'case' | 'pattern' — which comparison table Build shows

/** Switch which comparison table Build shows. build.js owns no notion of
 *  "active level" itself (that's app.js's concept) — the caller decides
 *  when to call this (entering Build, or changing level while Build is
 *  already the visible tab). A no-op when already in that mode, so
 *  re-entering the SAME mode never re-renders needlessly. */
export function setMode(next){
  if(mode === next) return;
  mode = next;
  const caseEl = el('bCasePanel'), patEl = el('bPatternPanel');
  if(caseEl) caseEl.style.display = mode === 'case' ? '' : 'none';
  if(patEl) patEl.style.display = mode === 'pattern' ? '' : 'none';
  if(mode === 'pattern') renderPatternPanel();
}
export const getMode = () => mode;

/** A stable, re-derivable identifier for the currently-selected candidate
 *  row (nx/ny/nz/orientation) — never the row itself, which carries
 *  derived geometry/placements that the save document must not contain. */
export function getSelectedCandidateKey(){
  if(!selected) return null;
  return {nx: selected.nx, ny: selected.ny, nz: selected.nz, orientation: selected.orientation,
          cartonsPerCase: selected.cartonsPerCase};
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
    r.nx === key.nx && r.ny === key.ny && r.nz === key.nz && r.orientation === key.orientation &&
    (key.cartonsPerCase === undefined || r.cartonsPerCase === key.cartonsPerCase));
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
