/**
 * Thermoformed tray 2D — a standard orthographic multiview (TOP, FRONT,
 * RIGHT) of the tray the 3D view draws.
 *
 * NOT A DIELINE, for the same reasons tray3d.js is not a Geometry style: a
 * thermoformed part has no blank, no cut path and no creases, so there is
 * nothing to route through dieline2d.js's cut/crease renderer and nothing to
 * DXF. This is the product2d.js precedent one level up — a sibling module
 * with its own view, sharing dieline2d's already-exported zoom/pan state
 * (`view2d`/`apply2dView`) and the shared callout renderers (dim2d.js) rather
 * than inventing either again.
 *
 * THE DIMENSION THAT MATTERS. Overall L and W are the MAX CROSS-SECTION —
 * the flange, `trayOuter()`'s own result, read straight off the resolved
 * stage (`tray.outer`) rather than re-derived here. The tray is drafted, so
 * it is narrowest at the base and widest at the rim; the base is the number
 * a drawing most plausibly shows and the one that would silently undersize
 * every level above it (cookietray.js's trayOuter doc explains why). The
 * TAPERED BASE is still drawn AND dimensioned — but always LABELLED `BASE`,
 * so the taper reads as information rather than as a contradiction.
 *
 * EVERY CALLOUT IS NAMED. An unlabelled number beside another of similar
 * size is ambiguous no matter how correct it is: a bare 50 under an elevation
 * reads as an overall until something says CELL W, and 139/123 on adjacent
 * views read as a mistake until they say OVERALL/BASE. Only the envelope L/W
 * go bare, and only because they are what a reader assumes by default.
 *
 * Values a dimension line cannot letter at this scale — a 2.5mm flange or a
 * 3mm divider on a 139mm sheet — get a LEADER instead, and the ones that are
 * not linear at all (the draft angle) can only be leaders.
 *
 * Every value comes from the resolved parameter set (core/cookietray.js
 * `trayParams`) or the stage's envelope. Nothing here computes a dimension
 * and nothing measures the mesh — the 3D and 2D views are two readings of
 * one parameter set, so they cannot disagree.
 *
 * Third-angle arrangement, matching product2d.js: TOP above FRONT, RIGHT to
 * the right of FRONT. All lengths mm; the drawing frame is plain Y-down.
 */
import {fmtLen, fmtInputValue, fromMM} from '../core/units.js';
import {view2d, apply2dView} from './dieline2d.js';
import {dimLine, leader} from './dim2d.js';

/**
 * THE line vocabulary, and the only place it is defined.
 *
 * Dashed used to do double duty — hidden edges AND cell boundaries — so at
 * four cells the dividers were faint ghosts inside a strong outline, in the
 * one view where the cell layout is the whole point. Three types now, and the
 * CELL is the one that reads: solid, in the accent, with a wash so a cell is
 * a region and the divider between two of them is the unwashed land.
 *
 * Exported because the rail's 2D legend names these same three (app.js
 * LEGEND_2D). A legend is a claim about what is on screen; reading it off the
 * drawing's own vocabulary is what stops the claim and the ink diverging.
 */
export const TRAY_LINE_TYPES = [
  {id: 'outline', label: 'Outline',      color: 'var(--ink)',    w: 1,    dash: 0, fill: 'rgba(20,26,31,0.04)'},
  {id: 'cell',    label: 'Cell',         color: 'var(--accent)', w: 0.75, dash: 0, fill: 'rgba(15,110,119,0.07)'},
  {id: 'hidden',  label: 'Hidden edge',  color: 'var(--ink-3)',  w: 0.5,  dash: 1, fill: 'none'}
];
const LINE = Object.fromEntries(TRAY_LINE_TYPES.map(t => [t.id, t]));

/**
 * The placed geometry the three views are drawn from.
 *
 * `longAxis: 'Y'` rotates the whole part 90° in plan (tray3d.js applies it to
 * the group; trayOuter() applies it to the envelope), so the tray's own L and
 * the PLACED L are not the same axis. Everything below works in the placed
 * frame — the frame the envelope, the pallet solve and the 3D view all use —
 * with the tray's own axes mapped through that one rotation flag.
 */
function placed(tray){
  const p = tray.params;
  const rot = p.longAxis === 'Y';
  return {
    p, rot,
    // THE handoff values, read not recomputed
    L: tray.outer.L, W: tray.outer.W, H: p.overallH,
    topL:    rot ? p.topW    : p.topL,        // rim, placed
    topW:    rot ? p.topL    : p.topW,
    bottomL: rot ? p.bottomW : p.bottomL,     // drafted base, placed
    bottomW: rot ? p.bottomL : p.bottomW,
    stripL:  rot ? p.stripW  : p.stripL,      // flange strip, placed
    // the cell run lies along the tray's own L, i.e. along placed W when rotated
    runAlongL: !rot
  };
}

/** The cell (pocket) mouths in placed plan coordinates, centred on (0, 0),
 *  y down. `nCells` rows walk across (the SAME uniform cellWid every row —
 *  only pocket COUNT varies row to row, never cell size — see
 *  cookietray.js), each split along its own length into `p.cols[row]`
 *  pockets, centred exactly as trayParams/tray3d.js centre a shorter row.
 *  Each cell carries its own `row`/`col` index so the dims below can find
 *  two adjacent pockets to measure a pitch from. */
function planCells(g){
  const {p} = g, out = [];
  const rowSpanMax = p.topL - 2*p.wall;
  let along0 = -p.topW/2 + p.wall;
  for(let r = 0; r < p.nCells; r++){
    const a0 = along0, a1 = a0 + p.cellWid;
    const colsInRow = p.cols[r];
    const rowSpan = colsInRow*p.cellLen + (colsInRow - 1)*p.colDivider;
    const rowB0 = -rowSpanMax/2 + (rowSpanMax - rowSpan)/2;
    for(let c = 0; c < colsInRow; c++){
      const b0 = rowB0 + c*(p.cellLen + p.colDivider), b1 = b0 + p.cellLen;
      out.push({
        ...(g.runAlongL ? {x0: b0, x1: b1, y0: a0, y1: a1} : {x0: a0, x1: a1, y0: b0, y1: b1}),
        row: r, col: c
      });
    }
    along0 += p.cellWid + p.divider;
  }
  return out;
}

/**
 * TOP: the flange outline (the dimensioned max cross-section), the rim inside
 * it, the drafted base as a hidden outline, and the cell mouths.
 *
 * The plan carries the cell geometry, because this is the view it reads in:
 * CELL L along the run, CELL W and PITCH across it, each INBOARD of the
 * overall on its own side. Tiers, outermost = overall, is the convention;
 * it also keeps the two ~equal numbers (cell length vs overall length) from
 * sitting on the same line where only the label separates them.
 */
function topTile(g, x, y){
  const {p} = g, cx = g.L/2, cy = g.W/2;
  const shapes = [
    {kind: 'rect', line: 'outline', x: 0, y: 0, w: g.L, h: g.W, r: p.outerR},          // flange (max section)
    {kind: 'rect', line: 'outline', x: cx - g.topL/2, y: cy - g.topW/2,
     w: g.topL, h: g.topW, r: p.cornerR},                                              // rim
    {kind: 'rect', line: 'hidden', x: cx - g.bottomL/2, y: cy - g.bottomW/2,
     w: g.bottomL, h: g.bottomW, r: p.bottomCornerR}                                   // drafted base
  ];
  const cells = planCells(g);
  for(const c of cells)
    shapes.push({kind: 'rect', line: 'cell', x: cx + c.x0, y: cy + c.y0,
                 w: c.x1 - c.x0, h: c.y1 - c.y0});

  const runSide    = g.runAlongL ? 'above' : 'right';   // the axis the cells run along
  const acrossSide = g.runAlongL ? 'right' : 'above';
  const span = (side, a, b, rank, value, key, label) => side === 'above'
    ? {orient: 'h', x1: cx + a, x2: cx + b, side: 'above', rank, value, key, label}
    : {orient: 'v', y1: cy + a, y2: cy + b, side: 'right', rank, value, key, label};

  // CELL L/W are UNIFORM across the whole grid (only pocket COUNT varies
  // row to row — see cookietray.js), so these stay the same bare, single
  // callouts every tray has always shown, keyed cellLen/cellWid exactly as
  // every existing pin already reads.
  const c0 = cells[0];
  const runA = g.runAlongL ? c0.x0 : c0.y0, runB = g.runAlongL ? c0.x1 : c0.y1;
  const acrA = g.runAlongL ? c0.y0 : c0.x0, acrB = g.runAlongL ? c0.y1 : c0.x1;
  const dims = [span(runSide, runA, runB, 0, p.cellLen, 'cellLen', 'CELL L'),
                span(acrossSide, acrA, acrB, 0, p.cellWid, 'cellWid', 'CELL W')];
  let acrossTop = 1, runTop = 1;
  // ROW PITCH, centre to centre across the rows — the view of `divider`
  // the rail also shows. Measured from column 0 of the first two rows
  // (every row has at least one pocket), so this works whether the grid is
  // uniform or asymmetric.
  if(p.nCells > 1){
    const row0 = cells.find(c => c.row === 0 && c.col === 0);
    const row1 = cells.find(c => c.row === 1 && c.col === 0);
    const mid = c => g.runAlongL ? (c.y0 + c.y1)/2 : (c.x0 + c.x1)/2;
    dims.push(span(acrossSide, mid(row0), mid(row1), acrossTop, p.pitch, 'pitch', 'ROW PITCH'));
    acrossTop = 2;
  }
  // POCKET PITCH, centre to centre along a row's own pockets — only when at
  // least one row actually has more than one, measured from whichever row
  // has the most (guaranteed >= 2 pockets there).
  const widestRow = p.cols.indexOf(p.maxCols);
  if(p.maxCols > 1){
    const p0 = cells.find(c => c.row === widestRow && c.col === 0);
    const p1 = cells.find(c => c.row === widestRow && c.col === 1);
    const mid = c => g.runAlongL ? (c.x0 + c.x1)/2 : (c.y0 + c.y1)/2;
    dims.push(span(runSide, mid(p0), mid(p1), runTop, p.colPitch, 'colPitch', 'POCKET PITCH'));
    runTop = 2;
  }
  // the envelope, outermost on both sides and the only callouts left bare
  dims.push(g.runAlongL
    ? {orient: 'h', x1: 0, x2: g.L, side: 'above', rank: runTop, value: g.L, key: 'overallL'}
    : {orient: 'h', x1: 0, x2: g.L, side: 'above', rank: acrossTop, value: g.L, key: 'overallL'});
  dims.push(g.runAlongL
    ? {orient: 'v', y1: 0, y2: g.W, side: 'right', rank: acrossTop, value: g.W, key: 'overallW'}
    : {orient: 'v', y1: 0, y2: g.W, side: 'right', rank: runTop, value: g.W, key: 'overallW'});

  // FLANGE WIDTH — a 5mm land on a 139mm sheet: a leader, not a dimension
  // line whose two ticks would be further apart than the span they bound.
  const leaders = [{px: g.L - g.stripL/2, py: cy - g.topW/2 - (g.W - g.topW)/4,
                    dx: g.L*0.34, dy: -g.W*0.30, key: 'flange',
                    text: `FLANGE ${p.stripL === p.stripW ? '' : ''}`}];
  return {name: 'TOP', x, y, w: g.L, h: g.W, shapes, dims, leaders};
}

/**
 * An elevation: the silhouette seen along one horizontal axis.
 *
 * The outline is a real trapezoid — narrow at the base, wide at the rim —
 * because the draft is the fact the envelope depends on. Above the body the
 * flange steps out to the full outer width for its own thickness, and the lip
 * stands on top of it: three steps, the same three tray3d.js builds.
 *
 * Heights go on ONE side per view (drafting convention, and the reason the
 * old sheet read as inconsistent): FRONT carries them on the left, RIGHT
 * repeats the overall on its right. Below each elevation is the BASE — the
 * drafted width, in the view where the taper that produces it is visible.
 */
function elevation(g, name, x, y, across, wantRun){
  const {p} = g;
  const outer = across === 'L' ? g.L : g.W;
  const top   = across === 'L' ? g.topL : g.topW;
  const bot   = across === 'L' ? g.bottomL : g.bottomW;
  const bH = p.H, oH = g.H;                       // body height, overall height
  const hf = Math.max(0, bH - p.flangeT);         // flange underside
  const xAt = u => (bot/2) + (top/2 - bot/2)*(bH > 0 ? u/bH : 0);   // drafted edge
  const cx = outer/2;
  // tile-local: x centred on cx, y measured DOWN from the lip crown
  const P = (dx, u) => [cx + dx, oH - u];
  const shapes = [{kind: 'poly', line: 'outline', pts: [
    P(-bot/2, 0), P(bot/2, 0), P(xAt(hf), hf), P(outer/2, hf),
    P(outer/2, oH), P(-outer/2, oH), P(-outer/2, hf), P(-xAt(hf), hf)
  ]}];

  // The troughs, seen through the wall. Along the run a trough reads as ONE
  // rectangular recess per POCKET (its bottom is the cradle's lowest line,
  // seen end-on — every pocket shares the same UNIFORM cellH, but a row can
  // have several pockets side by side, each its own recess); ACROSS the run
  // each cell shows its real U cross-section — straight sides down to the
  // cradle arc — and the dividers as the land between them.
  //
  // yFloor is UNIFORM (one cellH for the whole tray — see cookietray.js:
  // the real grid keeps cell size the same everywhere, only pocket COUNT
  // varies), matching tray3d.js buildTray3d's identical rule.
  //
  // The cradle is drawn as a true SVG arc from cellWid/cradleR/depth — the
  // same parameters tray3d.js tessellates its swept profile from, in this
  // medium's own primitive. Not a second derivation of a VALUE: no dimension
  // is taken from it, and an arc of radius r is exactly the shape those
  // parameters describe (more exactly than the 10-segment polyline, in fact).
  const cells = planCells(g);
  const yRim = oH - p.H;
  const yFloor = yRim + p.cellH;
  if(wantRun){
    // one rectangle per pocket (every row's own pockets, seen end-on) —
    // overlapping pockets from different rows draw the same rectangle more
    // than once, which is harmless (identical geometry, same fill)
    const seen = new Set();
    for(const c of cells){
      const s = across === 'L' ? {a: c.x0, b: c.x1} : {a: c.y0, b: c.y1};
      const k = `${s.a.toFixed(3)}|${s.b.toFixed(3)}`;
      if(seen.has(k)) continue;
      seen.add(k);
      shapes.push({kind: 'rect', line: 'cell', x: cx + s.a, y: yRim, w: s.b - s.a, h: p.cellH});
    }
  }else{
    for(const c of cells){
      const s = across === 'L' ? {a: c.x0, b: c.x1} : {a: c.y0, b: c.y1};
      const half = (s.b - s.a)/2, c0 = cx + (s.a + s.b)/2;
      const r = Math.max(0.01, Math.min(p.cradleR, half, yFloor - yRim));
      const flat = half - r;
      shapes.push({kind: 'path', line: 'cell', d:
        `M ${c0 - half} ${yRim} L ${c0 - half} ${yFloor - r} ` +
        `A ${r} ${r} 0 0 0 ${c0 - flat} ${yFloor} L ${c0 + flat} ${yFloor} ` +
        `A ${r} ${r} 0 0 0 ${c0 + half} ${yFloor - r} L ${c0 + half} ${yRim}`});
    }
  }

  const isFront = across === 'L';
  // the base is the ONE callout with a fraction in it (a 5° draft off 129 is
  // 124.6, not 125), and the title block states it to the same precision —
  // rounding it here would put two different numbers for one edge on one sheet
  const dims = [{orient: 'h', x1: cx - bot/2, x2: cx + bot/2, side: 'below', rank: 0,
                 value: bot, exactVal: true, key: isFront ? 'baseL' : 'baseW', label: 'BASE'}];
  const leaders = [];
  if(isFront){
    // CELL DEPTH is uniform — one cellH for the whole tray (see
    // cookietray.js: the real grid varies pocket COUNT per row, never cell
    // size), so this stays the same bare callout every tray has always shown.
    // heights, stacked on the ONE free side: the feature inboard, the
    // envelope outboard
    dims.push({orient: 'v', y1: yRim, y2: yFloor, side: 'left', rank: 0,
               value: p.cellH, key: 'cellH', label: 'CELL DEPTH'});
    dims.push({orient: 'v', y1: 0, y2: oH, side: 'left', rank: 1,
               value: oH, key: 'overallH', label: 'OVERALL H'});
    // the DRAFT: an angle has no two ends to tick, so it can only be a leader
    leaders.push({px: cx + xAt(bH*0.45), py: oH - bH*0.45,
                  dx: outer*0.30, dy: oH*0.55, key: 'draft', angle: true});
    // the LIP, standing on the flange — 3mm on a 139mm sheet. It points UP and
    // RIGHT, into the empty band between this elevation and the plan above it:
    // the left of this view is the height stack, and a leader landing in it
    // collided with both callouts (measured on the first draft).
    leaders.push({px: cx + outer/2, py: (oH - bH)/2,
                  dx: outer*0.16, dy: -oH*0.85, key: 'lip', lip: true});
  }else{
    dims.push({orient: 'v', y1: 0, y2: oH, side: 'right', rank: 0,
               value: oH, key: 'overallH2', label: 'OVERALL H'});
    // the DIVIDER land between the first two across-positions, in the view
    // that shows it (a same-row channel divider with one row present; still
    // a real divider — same value, same land — when the first two entries
    // straddle a row boundary instead)
    const acrEdge = c => across === 'L' ? {a: c.x0, b: c.x1} : {a: c.y0, b: c.y1};
    // Two distinct dividers now exist — row-to-row (`divider`) and
    // pocket-to-pocket within a row (`colDivider`) — so which one this
    // adjacent pair actually straddles has to be read off their `row`
    // index, not assumed: cells[0]/cells[1] land in the same row (a
    // pocket divider) whenever row 0 has more than one pocket, and in
    // different rows (a row divider) otherwise.
    if(cells.length > 1){
      const sameRow = cells[1].row === cells[0].row;
      leaders.push({px: cx + (acrEdge(cells[0]).b + acrEdge(cells[1]).a)/2, py: yRim,
                    dx: 0, dy: -oH*0.75, key: sameRow ? 'colDivider' : 'divider',
                    divider: true, sameRow});
    }
  }
  return {name, x, y, w: outer, h: oH, shapes, dims, leaders};
}

function layoutFor(tray, fmt, unit){
  const g = placed(tray), p = g.p;
  const gap = Math.max(g.L, g.W, g.H)*0.32;

  const front = elevation(g, 'FRONT', 0, 0, 'L', g.runAlongL);
  const top   = topTile(g, 0, -(g.W + gap));
  const right = elevation(g, 'RIGHT', g.L + gap, 0, 'W', !g.runAlongL);
  return {tiles: [front, top, right], g, p};
}

/**
 * The TITLE BLOCK rows — the pallet sheet's own pattern (export/palletpdf.js):
 * an eyebrow label over a mono value, grouped and ruled, in the same design
 * tokens. The two documents are meant to read as one family, so the layout is
 * borrowed rather than reinvented.
 *
 * COMPOSITION ONLY, exactly as that sheet's doc insists: every number here is
 * already-resolved and merely formatted. `exact` is the rail's own
 * fmtInputValue rather than the callouts' whole-mm fmtLen — a 2.5mm flange
 * rounds to "3" under fmtLen, and a block that restates a PARAMETER has to
 * read the same as the field the user typed it into.
 *
 * MATERIAL, not "gauge": a thermoformed part is drawn from a sheet of some
 * starting gauge, and this model does not carry one — it carries the wall,
 * floor and divider thicknesses. Naming the row for what the model actually
 * knows beats printing a plausible number the model never had.
 */
function titleRows(tray, g, p, fmt, exact, unit, dateStr){
  const rows = [
    ['Part', 'Thermoformed sizing tray'],
    ['Overall (max section)', `${fmt(g.L)} × ${fmt(g.W)} × ${fmt(g.H)} ${unit}`]
  ];
  // the drawing dimensions the TRAY; the chain hands the wrap an envelope that
  // also covers product standing proud of the cells. State both when they
  // differ, exactly as the 3D depth's HUD does, so the two can never read as a
  // contradiction (tray3d.js's `outer` doc carries the same note).
  if(tray.proud)
    rows.push(['Envelope (proud product)',
               `${fmt(tray.outer.L)} × ${fmt(tray.outer.W)} × ${fmt(tray.outer.H)} ${unit}`]);
  // Cell size (L x W x D, cradle) is UNIFORM across the whole tray — only
  // pocket COUNT varies row to row, via `p.cols` (see cookietray.js) — so
  // there is exactly one size row, not one per row of the grid.
  const gridded = p.maxCols > 1 || p.cols.some(c => c !== p.cols[0]);
  rows.push(
    ['Base (drafted)', `${exact(g.bottomL)} × ${exact(g.bottomW)} ${unit}`],
    ['Cells', `${p.nCells} × ${tray.perCell} = ${tray.total} products` +
              (gridded ? ` · pockets/row ${p.cols.join('+')}` : '')]
  );
  rows.push(['Cell L × W × D',
    `${fmt(p.cellLen)} × ${fmt(p.cellWid)} × ${fmt(p.cellH)} ${unit}` +
      ` · cradle R ${exact(p.cradleR)}` +
      (p.nCells > 1 ? ` · row pitch ${fmt(p.pitch)}` : '') +
      (p.maxCols > 1 ? ` · pocket pitch ${fmt(p.colPitch)}` : '')
  ]);
  rows.push(
    ['Material', `wall ${exact(p.wall)} · divider ${exact(p.divider)}` +
                 (p.maxCols > 1 ? ` · pocket divider ${exact(p.colDivider)}` : '') +
                 ` · floor ${exact(p.floor)} ${unit}`],
    ['Rim', `flange ${exact(p.stripL)} × ${exact(p.stripW)}, ${exact(p.flangeT)} thick` +
            ` · lip ${exact(p.lipH)} ${unit}`],
    ['Draft', `${p.effectiveDraftDeg.toFixed(1)}°`],
    ['Units · scale · date', `${unit} · NTS · ${dateStr}`]
  );
  return rows;
}

/** @param {SVGElement} svg
 *  @param {Object} tray  a resolved tray stage: {params, outer, proud, ...}
 *  @param {'mm'|'in'} unit  display unit for labels only
 *  @param {string} dateStr  the sheet's date stamp, from the app's ONE stamper
 *  @returns {{w:number,h:number}} overall drawing extents, mm */
export function drawTray2d(svg, tray, unit, dateStr){
  const fmt = v => fmtLen(v, unit);
  const exact = v => fmtInputValue(fromMM(v, unit), unit);
  const {tiles, g, p} = layoutFor(tray, fmt, unit);

  const minX = Math.min(...tiles.map(t => t.x)), maxX = Math.max(...tiles.map(t => t.x + t.w));
  const minY = Math.min(...tiles.map(t => t.y)), maxY = Math.max(...tiles.map(t => t.y + t.h));
  const w = maxX - minX, h = maxY - minY;
  // the margin has to hold the deepest DIMENSION TIER, not just a fixed
  // fraction: three tiers of callouts outside a view need room, and a sheet
  // sized for one would clip the outermost — value-correct and invisible.
  const m = Math.max(w, h)*0.30 + (unit === 'mm' ? 24 : 25.4);
  const rows = titleRows(tray, g, p, fmt, exact, unit, dateStr);
  // ONE scale for the whole sheet, taken from the DRAWING area before the
  // title block is added. Sizing the block from one strokeW and lettering it
  // from another is the two-computation bug in miniature: the band reserved
  // 10 rows and the renderer drew 10 taller ones, so the last row fell off
  // the sheet (measured: content to 614.4 on a 603.9 sheet).
  const DW = w + 2*m, DH = h + 2*m;
  const strokeW = Math.max(DW, DH)/460;
  const rowH = strokeW*13;
  const blockH = rows.length*rowH + strokeW*34;            // title block band, at the foot
  // a HEADER band at the head, for the same reason a printed sheet has one:
  // the app floats its view-switch pill over the top of the canvas, and the
  // outermost callout — the overall length — was landing under it
  const padTop = strokeW*30;
  const VW = DW, VH = DH + blockH + padTop;
  const ox = m - minX, oy = m - minY + padTop;             // world -> svg translation

  const dimFS = strokeW*9, dw = strokeW*0.7, tick = dimFS*0.5;
  const off = Math.max(w, h)*0.06 + dimFS*1.6;
  const step = dimFS*2.8;                                  // one dimension tier

  let body = '';
  const styleOf = id => {
    const t = LINE[id] || LINE.outline;
    return `stroke="${t.color}" stroke-width="${strokeW*t.w}" fill="${t.fill}"` +
      (t.dash ? ` stroke-dasharray="${strokeW*3} ${strokeW*2}"` : '');
  };

  for(const t of tiles){
    const x = t.x + ox, y = t.y + oy;
    body += `<text x="${x}" y="${y - strokeW*3}" fill="var(--muted)" font-family="var(--mono)" ` +
      `font-size="${strokeW*10}" letter-spacing="0.08em">${t.name}</text>`;
    for(const s of t.shapes){
      const stroke = styleOf(s.line);
      if(s.kind === 'rect'){
        if(s.w <= 0 || s.h <= 0) continue;
        const r = s.r ? ` rx="${Math.min(s.r, s.w/2, s.h/2)}"` : '';
        body += `<rect x="${x + s.x}" y="${y + s.y}" width="${s.w}" height="${s.h}"${r} ${stroke}/>`;
      }else if(s.kind === 'path'){
        body += `<path transform="translate(${x} ${y})" d="${s.d}" ${stroke}/>`;
      }else{
        body += `<polygon points="${s.pts.map(q => `${x + q[0]},${y + q[1]}`).join(' ')}" ${stroke}/>`;
      }
    }
    for(const d of t.dims){
      const clear = off + (d.rank || 0)*step;              // stacked tiers step outward
      const o = {key: d.key, label: d.label};
      const shown = (d.exactVal ? exact : fmt)(d.value);
      if(d.orient === 'h'){
        const dy = d.side === 'below' ? y + t.h + clear : y - clear;
        body += dimLine('h', x + d.x1, dy, x + d.x2, dy, shown, dimFS, dw, tick, o);
      }else{
        const dx = d.side === 'right' ? x + t.w + clear : x - clear;
        body += dimLine('v', dx, y + d.y1, dx, y + d.y2, shown, dimFS, dw, tick, o);
      }
    }
    for(const l of t.leaders){
      const text = l.angle    ? `DRAFT ${p.effectiveDraftDeg.toFixed(1)}°`
                 : l.divider  ? (l.sameRow ? `POCKET DIVIDER ${exact(p.colDivider)}`
                                            : `ROW DIVIDER ${exact(p.divider)}`)
                 : l.lip      ? `LIP ${exact(p.lipH)}`
                 : `FLANGE ${exact(p.stripL)}`;
      body += leader(x + l.px, y + l.py, x + l.px + l.dx, y + l.py + l.dy,
                     text, dimFS, dw, {key: l.key});
    }
  }

  /* ---- title block: the pallet sheet's pattern, at the foot of the sheet --- */
  const bTop = VH - blockH, bx = m*0.5, bw = VW - m;
  const eb = strokeW*7.2, val = strokeW*9.4;
  body += `<line x1="${bx}" y1="${bTop}" x2="${bx + bw}" y2="${bTop}" ` +
    `stroke="var(--line)" stroke-width="${strokeW*0.7}"/>`;
  body += `<text class="tray2dTB" x="${bx}" y="${bTop + strokeW*13}" fill="var(--accent)" ` +
    `font-family="var(--mono)" font-size="${eb}" letter-spacing="0.14em">TRAY · MULTIVIEW (THIRD ANGLE)</text>`;
  rows.forEach(([k, v], i) => {
    const ry = bTop + strokeW*28 + i*rowH;
    // AUTO-FIT the value against its own label. The block is one mono type at
    // a known size, so both widths are computable rather than hoped for; a
    // long row (the cell line) otherwise runs straight through its own label,
    // which is what the first draft did. Shrinking the value is the right
    // give: the label is fixed vocabulary, the value is the content.
    const labelW = k.length*eb*0.66, room = bw - labelW - strokeW*6;
    const vfs = Math.min(val, room/Math.max(1, v.length*0.62));
    body += `<text class="tray2dTB" x="${bx}" y="${ry}" fill="var(--ink-3)" font-family="var(--mono)" ` +
      `font-size="${eb}" letter-spacing="0.1em">${k.toUpperCase()}</text>`;
    body += `<text class="tray2dTB" data-tb="${k}" x="${bx + bw}" y="${ry}" fill="var(--ink)" ` +
      `font-family="var(--mono)" font-size="${vfs}" text-anchor="end">${v}</text>`;
  });

  /* ---- line-type legend: three types are in play, so the sheet names them -- */
  const lx = bx, ly = bTop - strokeW*8;
  let lcur = lx;
  for(const t of TRAY_LINE_TYPES){
    const seg = strokeW*11;
    body += `<line class="tray2dKey" x1="${lcur}" y1="${ly}" x2="${lcur + seg}" y2="${ly}" ` +
      `stroke="${t.color}" stroke-width="${strokeW*Math.max(t.w, 0.7)}"` +
      (t.dash ? ` stroke-dasharray="${strokeW*3} ${strokeW*2}"` : '') + '/>';
    body += `<text class="tray2dKey" x="${lcur + seg + strokeW*3}" y="${ly + eb*0.36}" ` +
      `fill="var(--ink-3)" font-family="var(--mono)" font-size="${eb}">${t.label}</text>`;
    lcur += seg + strokeW*3 + t.label.length*eb*0.62 + strokeW*10;
  }

  view2d.base = [0, 0, VW, VH];
  apply2dView(svg);
  svg.innerHTML = body;
  return {w, h};
}
