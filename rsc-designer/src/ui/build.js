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
import {newProject, candidateCases, checkLockedCase, ROUNDING, linkFor,
        verticalToOrientations, VERTICAL_CHOICES, TIER_NOUN, roundGirthEligible,
        resolveWrapAxis} from '../core/project.js';
import {collate, PRESETS} from '../core/collation.js';
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
 *  solver freedom (checkbox). Used at every level. `vertState` is the
 *  ACTUAL current {axis, mayRotate} derived from the level's own
 *  allowedOrientations (see orientationsToVertical) — never a hardcoded
 *  default, so re-rendering this panel from a loaded project reflects
 *  what was actually loaded instead of silently resetting to H-up. */
function vertControl(idp, vertState, disabledAxes = [], disabledReason = ''){
  return html`
  <div class="brow"><label>Vertical axis</label>
    <select id="${idp}Vert">${VERTICAL_CHOICES.map(c => {
      const dis = disabledAxes.includes(c.axis);
      return `<option value="${c.axis}"${c.axis === vertState.axis ? ' selected' : ''}${dis ? ` disabled title="${disabledReason}"` : ''}>${c.label} · ${c.codes}${dis ? ' — disabled' : ''}</option>`;
    }).join('')}</select></div>
  <div class="brow bchk"><label><input type="checkbox" id="${idp}Rot"${vertState.mayRotate ? ' checked' : ''}> May rotate about vertical (90° in plan)</label></div>`;
}

/** Inverse of verticalToOrientations: recover {axis, mayRotate} from an
 *  allowedOrientations list, so the Build panel can be rebuilt from ANY
 *  project state (loaded from a file, a slot, an autosave) and still show
 *  the orientation the project actually has, not always H-up/may-rotate. */
function orientationsToVertical(list){
  const pairs = {H: ['LWH', 'WLH'], L: ['WHL', 'HWL'], W: ['LHW', 'HLW']};
  for(const axis of ['H', 'L', 'W']){
    const [a, b] = pairs[axis];
    if(list.length === 1 && list[0] === a) return {axis, mayRotate: false};
    if(list.length >= 2 && list.includes(a) && list.includes(b)) return {axis, mayRotate: true};
  }
  for(const axis of ['H', 'L', 'W'])
    if(list.includes(pairs[axis][0])) return {axis, mayRotate: list.length > 1};
  return {axis: 'H', mayRotate: true};
}

const html = String.raw;
const lenVal = mm => fmtInputValue(fromMM(mm, unit), unit);
const U = () => `<span class="bunit">${unit}</span>`;
const cap = s => s[0].toUpperCase() + s.slice(1);

/** Every child-count/arrangement label is DERIVED from the actual Link
 *  (parent/child tier names) via TIER_NOUN, never a hardcoded per-level
 *  string — so "Cartons/case" and "Wraps/carton" come from the same code. */
const countLabel = link => `${cap(TIER_NOUN[link.child])}s / ${TIER_NOUN[link.parent]}`;
const arrLabel = link => `Arrangement (${TIER_NOUN[link.child]}s in ${TIER_NOUN[link.parent]})`;

/** Uniform child-count + arrangement control block for a Link. `presets` are
 *  just convenience shortcuts (typed values always work via "custom").
 *  defNx/defNy/defNz are fallbacks used only when the link's own
 *  arrangement is 'auto' — an explicit link shows its ACTUAL grid, not
 *  the placeholder defaults, so re-rendering from a loaded project is
 *  faithful to what was loaded. */
function countArrangementControl(idp, link, presets, defNx, defNy, defNz){
  const explicit = link.arrangement !== 'auto';
  const nx = explicit ? link.arrangement.nx : defNx;
  const ny = explicit ? link.arrangement.ny : defNy;
  const nz = explicit ? link.arrangement.nz : defNz;
  return html`
  <div class="brow"><label>${countLabel(link)}</label>
    <select id="${idp}CountSel">${presets.map(p => `<option${p === link.count ? ' selected' : ''}>${p}</option>`).join('')}<option value="custom"${presets.includes(link.count) ? '' : ' selected'}>custom</option></select>
    <input id="${idp}Count" type="number" min="1" value="${link.count}" style="display:${presets.includes(link.count) ? 'none' : ''}"></div>
  <div class="brow"><label>${arrLabel(link)}</label>
    <select id="${idp}Arr"><option value="auto"${explicit ? '' : ' selected'}>auto</option><option value="explicit"${explicit ? ' selected' : ''}>nx × ny × nz</option></select>
    <span id="${idp}ArrN" style="display:${explicit ? '' : 'none'}">
      <input id="${idp}Nx" type="number" min="1" value="${nx}" class="bshort"> ×
      <input id="${idp}Ny" type="number" min="1" value="${ny}" class="bshort"> ×
      <input id="${idp}Nz" type="number" min="1" value="${nz}" class="bshort"></span></div>`;
}

/** When arrangement is explicit, the count field would otherwise sit there
 *  silently ignored (the grid determines the real count) — disable it and
 *  show the derived total instead, so the UI never displays a number the
 *  model isn't actually using. */
function syncCountWithArrangement(idp){
  const arr = el(idp + 'Arr').value;
  const countSel = el(idp + 'CountSel'), countInput = el(idp + 'Count');
  const explicit = arr === 'explicit';
  countSel.disabled = explicit; countInput.disabled = explicit;
  if(explicit){
    const total = Math.max(1, +el(idp + 'Nx').value || 1)*Math.max(1, +el(idp + 'Ny').value || 1)*Math.max(1, +el(idp + 'Nz').value || 1);
    countSel.style.display = 'none'; countInput.style.display = ''; countInput.value = total;
  }else{
    const custom = countSel.value === 'custom';
    countSel.style.display = ''; countInput.style.display = custom ? '' : 'none';
  }
}

export function initBuild(onSelect, startUnit){
  onSelectCb = onSelect;
  unit = startUnit || 'mm';
  const prim = project.primary, sec = project.secondary, ter = project.tertiary;
  const col = prim.collation;
  const wp = prim.wrap.params;
  const tp = ter.params;
  const cartonLink = linkFor(project, 'secondary'), caseLink = linkFor(project, 'tertiary');
  // every "value"/"selected"/visibility below is derived from the ACTUAL
  // project state, never a hardcoded literal — initBuild() is called again
  // on every load (file, slot, autosave), and a hardcoded default here
  // would silently discard whatever was loaded the moment the panel
  // re-renders, even though `project` itself was updated correctly first.
  const isCyl = col.piece.kind === 'cylinder';
  const boxP = isCyl ? {L: 90, W: 50, H: 20} : col.piece;
  const cylP = isCyl ? col.piece : {diameter: 50, thickness: 6};
  const pVert = orientationsToVertical(prim.allowedOrientations);
  const sVert = orientationsToVertical(sec.allowedOrientations);
  const tVert = orientationsToVertical(ter.allowedOrientations);
  el('buildWrap').innerHTML = html`
  <div class="bpanel">
    <div class="bcols">
      <fieldset><legend>Product · collation</legend>
        <div class="brow"><label>Piece</label>
          <select id="bKind"><option value="box"${isCyl ? '' : ' selected'}>Box</option><option value="cylinder"${isCyl ? ' selected' : ''}>Cylinder (round)</option></select></div>
        <div class="brow" id="bBoxDims" style="display:${isCyl ? 'none' : ''}"><label>L</label><input id="bpL" type="number" value="${lenVal(boxP.L)}">${U()}
          <label>W</label><input id="bpW" type="number" value="${lenVal(boxP.W)}">${U()}
          <label>H</label><input id="bpH" type="number" value="${lenVal(boxP.H)}">${U()}</div>
        <div class="brow" id="bCylDims" style="display:${isCyl ? '' : 'none'}"><label>Dia</label><input id="bpD" type="number" value="${lenVal(cylP.diameter)}">${U()}
          <label>Thick</label><input id="bpT" type="number" value="${lenVal(cylP.thickness)}">${U()}</div>
        <div class="brow"><label>Preset</label>
          <select id="bPreset">${PRESETS.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}</select></div>
        <div class="brow"><label>Per stack</label><input id="bPer" type="number" min="1" value="${col.perStack}" class="bshort">
          <label>Axis</label><select id="bAxis">${['X', 'Y', 'Z'].map(a => `<option${a === col.stackAxis ? ' selected' : ''}>${a}</option>`).join('')}</select>
          <label>Stacks</label><input id="bnx" type="number" min="1" value="${col.nx}" class="bshort"> ×
          <input id="bny" type="number" min="1" value="${col.ny}" class="bshort"></div>
        <div class="brow"><label>Stack gap</label><input id="bsg" type="number" step="0.5" value="${lenVal(col.stackGap)}">${U()}
          <label>Piece gap</label><input id="bpg" type="number" step="0.5" value="${lenVal(col.pieceGap)}">${U()}</div>
        <div class="brow bnote" id="bEnvInfo"></div>
      </fieldset>
      <fieldset><legend>Flow wrap</legend>
        <div class="brow"><label>Long. seal</label>
          <select id="bwSeal"><option value="fin"${wp.sealType === 'fin' ? ' selected' : ''}>Fin</option><option value="lap"${wp.sealType === 'lap' ? ' selected' : ''}>Lap</option></select>
          <label>Treatment</label>
          <select id="bwTreat"><option value="folded"${wp.finTreatment === 'folded' ? ' selected' : ''}>Folded down</option><option value="standing"${wp.finTreatment === 'standing' ? ' selected' : ''}>Standing</option></select></div>
        <div class="brow"><label>Fin height</label><input id="bwFinH" type="number" step="0.5" value="${lenVal(wp.finHeight)}">${U()}
          <label>Seal band</label><input id="bwBand" type="number" step="0.5" value="${lenVal(wp.finSealBand)}">${U()}
          <label>Fin face</label>
          <select id="bwFace">${['back', 'top', 'front'].map(f => `<option value="${f}"${wp.finFace === f ? ' selected' : ''}>${cap(f)}</option>`).join('')}</select></div>
        <div class="brow"><label>Lap overlap</label><input id="bwLap" type="number" step="0.5" value="${lenVal(wp.lapOverlap)}">${U()}</div>
        <div class="brow"><label>End seal</label><input id="bwEndW" type="number" step="0.5" value="${lenVal(wp.endSealWidth)}">${U()}
          <label>Bleed</label><input id="bwBleed" type="number" step="0.5" value="${lenVal(wp.endSealBleed)}">${U()}</div>
        <div class="brow"><label>Girth basis</label>
          <select id="bwBasis"><option value="rectangular"${wp.girthBasis === 'rectangular' ? ' selected' : ''}>Rectangular 2(W+H)</option>
            <option value="round" id="bwBasisRound"${wp.girthBasis === 'round' ? ' selected' : ''}>Round π·d (cylindrical slug only)</option></select></div>
        <div class="brow"><label>Machine direction</label>
          <select id="bwAxis"><option value="auto"${prim.wrap.wrapAxis === 'auto' ? ' selected' : ''}>Auto (longer of L/W)</option>
            <option value="L"${prim.wrap.wrapAxis === 'L' ? ' selected' : ''}>L</option><option value="W"${prim.wrap.wrapAxis === 'W' ? ' selected' : ''}>W</option></select></div>
        <div class="brow bnote">The axis the pack travels along through the wrapper — never H (a
          horizontal flow wrapper cannot feed vertically; that is a different machine). End seals sit
          at the two ends of this axis; the fin runs along it on the chosen face.</div>
        <div class="brow"><label>Film gauge</label><input id="bwGauge" type="number" step="1" value="${wp.gauge}"><span>µm</span>
          <label>Density</label><input id="bwDens" type="number" step="0.01" value="${wp.density}"><span>g/cm³</span></div>
        <div class="brow bnote">Seal values are editable defaults — review. Gauge/density are film substance, not caliper.</div>
        <div class="brow bchk"><label><input type="checkbox" id="bwLock"${prim.wrap.locked ? ' checked' : ''}> Lock wrap content dims (check fit only)</label></div>
        <div class="brow" id="bwLockDims" style="display:${prim.wrap.locked ? '' : 'none'}"><label>L</label><input id="bwL" type="number" value="${lenVal(wp.L)}">${U()}
          <label>W</label><input id="bwW" type="number" value="${lenVal(wp.W)}">${U()}
          <label>H</label><input id="bwH" type="number" value="${lenVal(wp.H)}">${U()}</div>
      </fieldset>
      <fieldset><legend>Carton content</legend>
        ${vertControl('bp', pVert)}
        ${countArrangementControl('bp', cartonLink, [1, 2, 4, 6, 8], 2, 1, 1)}
        <div class="brow"><label>Clearance wall</label><input id="bpWall" type="number" step="0.1" value="${lenVal(prim.clearance.wall)}">${U()}
          <label>between</label><input id="bpBetween" type="number" step="0.1" value="${lenVal(prim.clearance.between)}">${U()}</div>
        <div class="brow"><label>Headspace</label><input id="bpHead" type="number" step="0.5" value="${lenVal(prim.clearance.top)}">${U()}</div>
        <div class="brow bnote">Clearances default 0 — review. Headspace is a design decision, not a fit tolerance.</div>
        <div class="brow"><label>Carton caliper</label><input id="bCal" type="number" step="0.001" value="${lenVal(sec.params.caliper)}">${U()}</div>
        <div class="brow bchk"><label><input type="checkbox" id="bCLock"${cartonLink.locked ? ' checked' : ''}> Lock carton dims (check fit only)</label></div>
        <div class="brow" id="bCLockDims" style="display:${cartonLink.locked ? '' : 'none'}"><label>L</label><input id="bCL" type="number" value="${lenVal(sec.params.L)}">${U()}
          <label>W</label><input id="bCW" type="number" value="${lenVal(sec.params.W)}">${U()}
          <label>H</label><input id="bCH" type="number" value="${lenVal(sec.params.H)}">${U()}</div>
      </fieldset>
      <fieldset><legend>Case content</legend>
        ${vertControl('bs', sVert)}
        ${countArrangementControl('bs', caseLink, [12, 24, 36], 4, 3, 1)}
        <div class="brow"><label>Clearance wall</label><input id="bWall" type="number" step="0.1" value="${lenVal(sec.clearance.wall)}">${U()}
          <label>between</label><input id="bBetween" type="number" step="0.1" value="${lenVal(sec.clearance.between)}">${U()}</div>
        <div class="brow"><label>Headspace</label><input id="bcHead" type="number" step="0.5" value="${lenVal(sec.clearance.top)}">${U()}</div>
        <div class="brow bnote">Clearance defaults are placeholders to review, not truth.
          Cartons bear on the case floor (bottom 0).</div>
        <div class="brow"><label>Round cavities up to</label>
          <select id="bRound">${Object.keys(ROUNDING).map(k => `<option${k === rounding ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      </fieldset>
      <fieldset><legend>Case (FEFCO 201) · on pallet</legend>
        ${vertControl('bt', tVert, ['L', 'W'], 'A shipper does not go on the pallet on its side — say so explicitly if you genuinely need this')}
        <div class="brow"><label>Pallet clearance wall</label><input id="btWall" type="number" step="0.1" value="${lenVal(ter.clearance.wall)}">${U()}
          <label>between</label><input id="btBetween" type="number" step="0.1" value="${lenVal(ter.clearance.between)}">${U()}</div>
        <div class="brow"><label>Caliper</label><input id="bTCal" type="number" step="0.1" value="${lenVal(tp.caliper)}">${U()}</div>
        <div class="brow"><label>Glue flap</label><input id="bTGlue" type="number" value="${lenVal(tp.glue)}">${U()}
          <label>Slot</label><input id="bTSlot" type="number" step="0.5" value="${lenVal(tp.slot)}">${U()}</div>
        <div class="brow bchk"><label><input type="checkbox" id="bLock"${caseLink.locked ? ' checked' : ''}> Lock case dims (check fit only)</label></div>
        <div class="brow" id="bLockDims" style="display:${caseLink.locked ? '' : 'none'}"><label>L</label><input id="bTL" type="number" value="${lenVal(tp.L)}">${U()}
          <label>W</label><input id="bTW" type="number" value="${lenVal(tp.W)}">${U()}
          <label>H</label><input id="bTH" type="number" value="${lenVal(tp.H)}">${U()}</div>
        <div class="brow"><button class="btn bapply" id="bUse" disabled>Use selected as case</button></div>
      </fieldset>
    </div>
    <div id="bStatus" class="bnote"></div>
    <div class="btablewrap"><table id="bTable"></table></div>
  </div>`;

  const rewire = ids => ids.forEach(id => el(id).addEventListener('input', recompute));
  rewire(LEN_IDS.concat(['bPer', 'bnx', 'bny', 'bwGauge', 'bwDens', 'bpCount', 'bsCount']));
  // nx/ny/nz also refresh the (disabled, derived) count display so it never
  // shows a stale total while the fields are being edited
  ['bp', 'bs'].forEach(idp => ['Nx', 'Ny', 'Nz'].forEach(k =>
    el(idp + k).addEventListener('input', () => { syncCountWithArrangement(idp); recompute(); })));
  ['bpVert', 'bpRot', 'bsVert', 'bsRot', 'btVert', 'btRot', 'bwSeal', 'bwTreat', 'bwFace', 'bwBasis', 'bwAxis']
    .forEach(id => el(id).addEventListener('change', recompute));
  el('bwLock').addEventListener('change', () => {
    el('bwLockDims').style.display = el('bwLock').checked ? '' : 'none';
    recompute();
  });
  el('bKind').addEventListener('change', () => {
    const cyl = el('bKind').value === 'cylinder';
    el('bBoxDims').style.display = cyl ? 'none' : '';
    el('bCylDims').style.display = cyl ? '' : 'none';
    recompute();   // round-girth eligibility is centrally re-checked in recompute()
  });
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

  // uniform child-count + arrangement wiring, shared by the carton (bp) and
  // case (bs) levels — same behavior, derived labels, nothing hardcoded per level
  ['bp', 'bs'].forEach(idp => {
    el(idp + 'CountSel').addEventListener('change', () => {
      const custom = el(idp + 'CountSel').value === 'custom';
      el(idp + 'Count').style.display = custom ? '' : 'none';
      if(!custom) el(idp + 'Count').value = el(idp + 'CountSel').value;
      recompute();
    });
    el(idp + 'Arr').addEventListener('change', () => {
      el(idp + 'ArrN').style.display = el(idp + 'Arr').value === 'explicit' ? '' : 'none';
      syncCountWithArrangement(idp);
      recompute();
    });
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
  syncCountWithArrangement('bp'); syncCountWithArrangement('bs');
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
      sealType: el('bwSeal').value, finTreatment: el('bwTreat').value, finFace: el('bwFace').value,
      finHeight: n('bwFinH'), finSealBand: n('bwBand'), lapOverlap: n('bwLap'),
      endSealWidth: n('bwEndW'), endSealBleed: n('bwBleed'),
      girthBasis: el('bwBasis').value, roundDiameter: 0,
      gauge: +el('bwGauge').value || 0, density: +el('bwDens').value || 0,
      L: n('bwL'), W: n('bwW'), H: n('bwH')          // used only when locked
    },
    wrapAxis: el('bwAxis').value,
    locked: el('bwLock').checked
  };

  sec.params = {...sec.params, caliper: n('bCal')};
  cartonLink.locked = el('bCLock').checked;
  cartonLink.count = c('bpCount');
  cartonLink.arrangement = el('bpArr').value === 'auto' ? 'auto'
    : {nx: c('bpNx'), ny: c('bpNy'), nz: c('bpNz')};
  if(cartonLink.locked) sec.params = {...sec.params, L: n('bCL'), W: n('bCW'), H: n('bCH')};

  sec.allowedOrientations = verticalToOrientations(el('bsVert').value, el('bsRot').checked);
  sec.clearance = {wall: n('bWall'), between: n('bBetween'), bottom: 0, top: n('bcHead'), betweenZ: 0};
  ter.allowedOrientations = verticalToOrientations(el('btVert').value, el('btRot').checked);
  ter.clearance = {wall: n('btWall'), between: n('btBetween')};
  ter.params = {...ter.params, caliper: n('bTCal'), glue: n('bTGlue'), slot: n('bTSlot')};
  caseLink.count = c('bsCount');
  caseLink.locked = el('bLock').checked;
  caseLink.arrangement = el('bsArr').value === 'auto' ? 'auto'
    : {nx: c('bsNx'), ny: c('bsNy'), nz: c('bsNz')};
  if(caseLink.locked) ter.params = {...ter.params, L: n('bTL'), W: n('bTW'), H: n('bTH')};
}

export function recompute(){
  readIntoProject();
  const caseLink = linkFor(project, 'tertiary');
  const status = el('bStatus');
  selected = null; el('bUse').disabled = true;

  // Bug 2: round girth is only valid for a single cylindrical slug wrapped
  // along its own axis. Grey the option out whenever the current collation
  // can't support it, and if a stale 'round' selection is now invalid
  // (nx/ny/axis edited after the fact), fall back to rectangular and say
  // so — never compute silently. The eligibility check needs the RESOLVED
  // wrapAxis, the same one cartonVariants uses, so the two can never disagree.
  const wrapAxisResolved = resolveWrapAxis(collate(project.primary.collation).envelope, project.primary.wrap.wrapAxis);
  const eligible = roundGirthEligible(project.primary.collation, wrapAxisResolved);
  el('bwBasisRound').disabled = !eligible;
  let girthWarning = '';
  if(!eligible && el('bwBasis').value === 'round'){
    el('bwBasis').value = 'rectangular';
    project.primary.wrap.params.girthBasis = 'rectangular';
    girthWarning = 'Round girth needs a single cylindrical slug (1 stack, 1×1, along the pack length) — reverted to rectangular.';
  }

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
          (row.primaryFits ? '' : '; collation/wrap does not fit as configured') + ' — DOES NOT FIT';
      status.className = row.fits ? 'bnote' : 'bnote bbad';
    }else{
      rows = candidateCases(project, rounding);
      const bad = rows.filter(r => !r.primaryFits).length;
      status.textContent = `${rows.length} candidate arrangements for ${caseLink.count} cartons — click a row to select` +
        (bad ? ` · ${bad} rows: collation/wrap does NOT fit as configured` : '');
      status.className = bad ? 'bnote bbad' : 'bnote';
    }
    if(girthWarning) status.textContent += ' · ' + girthWarning;
    if(girthWarning) status.className = 'bnote bbad';
  }catch(e){
    rows = [];
    status.textContent = 'Error: ' + (e.message || e) + (girthWarning ? ' · ' + girthWarning : '');
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
 *  exported reference sees the update) and rebuild the whole Build panel
 *  from scratch, exactly like the first initBuild() call did, so every
 *  field reflects the loaded values instead of readIntoProject() clobbering
 *  them on the next recompute. Then re-select the candidate the save file
 *  named, if the freshly recomputed rows still contain a match. */
export function loadProject({project: loadedProject, rounding: loadedRounding, selectedCandidate}){
  Object.assign(project, loadedProject);
  if(loadedRounding) rounding = loadedRounding;
  initBuild(onSelectCb, unit);
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

/** Rebuild the Build panel's fields FROM the current project (without
 *  replacing the project), preserving the picked candidate. Called when the
 *  Build tab is shown, so its fields reflect edits made in the rails rather
 *  than reading stale DOM back over them on the next recompute. */
export function refreshPanel(){
  const key = getSelectedCandidateKey();
  initBuild(onSelectCb, unit);
  reselectByKey(key);
}
