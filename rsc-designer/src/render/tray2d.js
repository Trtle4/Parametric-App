/**
 * Thermoformed tray 2D — a standard orthographic multiview (TOP, FRONT,
 * RIGHT) of the tray the 3D view draws.
 *
 * NOT A DIELINE, for the same reasons tray3d.js is not a Geometry style: a
 * thermoformed part has no blank, no cut path and no creases, so there is
 * nothing to route through dieline2d.js's cut/crease renderer and nothing to
 * DXF. This is the product2d.js precedent one level up — a sibling module
 * with its own view, sharing dieline2d's already-exported zoom/pan state
 * (`view2d`/`apply2dView`) and the shared callout renderer (dim2d.js) rather
 * than inventing either again.
 *
 * THE DIMENSION THAT MATTERS. Overall L and W are the MAX CROSS-SECTION —
 * the flange, `trayOuter()`'s own result, read straight off the resolved
 * stage (`tray.outer`) rather than re-derived here. The tray is drafted, so
 * it is narrowest at the base and widest at the rim; the base is the number
 * a drawing most plausibly shows and the one that would silently undersize
 * every level above it (cookietray.js's trayOuter doc explains why). The
 * TAPERED BASE is still drawn — as a hidden outline in plan and as the real
 * slope of the elevations — because a drawing that showed straight sides
 * would disagree with the part; it is just never the dimensioned extent.
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
import {dimLine} from './dim2d.js';

const HID = 'var(--ink-3)';        // hidden/internal outlines

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
    // the cell run lies along the tray's own L, i.e. along placed W when rotated
    runAlongL: !rot
  };
}

/** The cell mouths in placed plan coordinates, centred on (0, 0), y down.
 *  The run extent is `cellLen`; across the run the cells start one outer
 *  `wall` in from the rim and repeat at `cellWid + divider` — the same walk
 *  tray3d.js sweeps its troughs along, so plan and part agree by shape. */
function planCells(g){
  const {p} = g, out = [];
  for(let j = 0; j < p.nCells; j++){
    const a0 = -p.topW/2 + p.wall + j*(p.cellWid + p.divider), a1 = a0 + p.cellWid;
    out.push(g.runAlongL
      ? {x0: -p.cellLen/2, x1: p.cellLen/2, y0: a0, y1: a1}
      : {x0: a0, x1: a1, y0: -p.cellLen/2, y1: p.cellLen/2});
  }
  return out;
}

/** TOP: the flange outline (the dimensioned max cross-section), the rim
 *  inside it, the drafted base as a hidden outline, and the cell mouths. */
function topTile(g, x, y){
  const {p} = g, cx = g.L/2, cy = g.W/2;
  const shapes = [
    {kind: 'rect', x: 0, y: 0, w: g.L, h: g.W, r: p.outerR},                         // flange (max section)
    {kind: 'rect', x: cx - g.topL/2, y: cy - g.topW/2, w: g.topL, h: g.topW, r: p.cornerR},   // rim
    {kind: 'rect', hidden: true, x: cx - g.bottomL/2, y: cy - g.bottomW/2,
     w: g.bottomL, h: g.bottomW, r: p.bottomCornerR}                                  // drafted base
  ];
  const cells = planCells(g);
  for(const c of cells)
    shapes.push({kind: 'rect', hidden: true, x: cx + c.x0, y: cy + c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0});

  // CELL PITCH — centre to centre, across the run: the view of `divider` the
  // rail also shows. It goes INBOARD of the overall on the same side, the way
  // a drawing stacks a feature dimension under an envelope one. TOP's other
  // two sides are spoken for: below faces the FRONT view, left faces nothing
  // but would sit over the elevations' own height stack.
  const mids = cells.map(c => g.runAlongL ? (c.y0 + c.y1)/2 : (c.x0 + c.x1)/2);
  const pitch = cells.length > 1
    ? [g.runAlongL
        ? {orient: 'v', y1: cy + mids[0], y2: cy + mids[1], side: 'right', value: p.pitch, key: 'pitch'}
        : {orient: 'h', x1: cx + mids[0], x2: cx + mids[1], side: 'above', value: p.pitch, key: 'pitch'}]
    : [];
  const overallRank = cells.length > 1 ? 1 : 0;      // outboard of the pitch when there is one
  const dims = [
    ...pitch,
    {orient: 'h', x1: 0, x2: g.L, side: 'above', rank: g.runAlongL ? 0 : overallRank,
     value: g.L, key: 'overallL'},
    {orient: 'v', y1: 0, y2: g.W, side: 'right', rank: g.runAlongL ? overallRank : 0,
     value: g.W, key: 'overallW'}
  ];
  return {name: 'TOP', x, y, w: g.L, h: g.W, shapes, dims};
}

/**
 * An elevation: the silhouette seen along one horizontal axis.
 *
 * The outline is a real trapezoid — narrow at the base, wide at the rim —
 * because the draft is the fact the envelope depends on. Above the body the
 * flange steps out to the full outer width for its own thickness, and the lip
 * stands on top of it: three steps, the same three tray3d.js builds.
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
  const shapes = [{kind: 'poly', pts: [
    P(-bot/2, 0), P(bot/2, 0), P(xAt(hf), hf), P(outer/2, hf),
    P(outer/2, oH), P(-outer/2, oH), P(-outer/2, hf), P(-xAt(hf), hf)
  ]}];

  // The troughs, seen through the wall. Along the run a trough reads as ONE
  // rectangular recess (its bottom is the cradle's lowest line, seen end-on);
  // ACROSS the run each cell shows its real U cross-section — straight sides
  // down to the cradle arc — and the dividers as the land between them. Which
  // one this elevation gets follows the placed run axis.
  //
  // The cradle is drawn as a true SVG arc from cellWid/cradleR/depth — the
  // same parameters tray3d.js tessellates its swept profile from, in this
  // medium's own primitive. Not a second derivation of a VALUE: no dimension
  // is taken from it, and an arc of radius r is exactly the shape those
  // parameters describe (more exactly than the 10-segment polyline, in fact).
  const cells = planCells(g);
  const spans = wantRun
    ? [{a: -p.cellLen/2, b: p.cellLen/2}]
    : cells.map(c => (across === 'L' ? {a: c.x0, b: c.x1} : {a: c.y0, b: c.y1}));
  const yRim = oH - p.H, yFloor = oH - p.floor;
  for(const s of spans){
    if(wantRun){
      shapes.push({kind: 'rect', hidden: true, x: cx + s.a, y: yRim, w: s.b - s.a, h: p.H - p.floor});
      continue;
    }
    const half = (s.b - s.a)/2, c0 = cx + (s.a + s.b)/2;
    const r = Math.max(0.01, Math.min(p.cradleR, half, yFloor - yRim));
    const flat = half - r;
    shapes.push({kind: 'path', hidden: true, d:
      `M ${c0 - half} ${yRim} L ${c0 - half} ${yFloor - r} ` +
      `A ${r} ${r} 0 0 0 ${c0 - flat} ${yFloor} L ${c0 + flat} ${yFloor} ` +
      `A ${r} ${r} 0 0 0 ${c0 + half} ${yFloor - r} L ${c0 + half} ${yRim}`});
  }

  const dims = [];
  if(wantRun) dims.push({orient: 'h', x1: cx - p.cellLen/2, x2: cx + p.cellLen/2,
                         side: 'below', value: p.cellLen, key: 'cellLen'});
  else if(spans.length) dims.push({orient: 'h', x1: cx + spans[0].a, x2: cx + spans[0].b,
                                   side: 'below', value: p.cellWid, key: 'cellWid'});
  return {name, x, y, w: outer, h: oH, shapes, dims};
}

function layoutFor(tray, fmt, unit){
  const g = placed(tray), p = g.p;
  const exact = v => fmtInputValue(fromMM(v, unit), unit);
  const gap = Math.max(g.L, g.W, g.H)*0.32;

  const front = elevation(g, 'FRONT', 0, 0, 'L', g.runAlongL);
  const top   = topTile(g, 0, -(g.W + gap));
  const right = elevation(g, 'RIGHT', g.L + gap, 0, 'W', !g.runAlongL);

  // Heights go on the FRONT view's free (left) side, STACKED the way a drawing
  // stacks them: the feature (trough depth, from the rim down to the cell
  // floor) inboard at rank 0, the overall outboard at rank 1. Both on the
  // OUTSIDE of the pair — a callout parked in the gap between two views reads
  // as belonging to whichever it happens to sit nearer, which is the FRONT
  // view, not the one it dimensions. RIGHT repeats the overall height on its
  // own right side, which is correct multiview practice.
  front.dims.push({orient: 'v', y1: g.H - p.H, y2: g.H - p.floor, side: 'left',
                   value: p.cellH, key: 'cellH'});
  front.dims.push({orient: 'v', y1: 0, y2: g.H, side: 'left', rank: 1, value: g.H, key: 'overallH'});
  right.dims.push({orient: 'h', x1: 0, x2: g.W, side: 'above', value: g.W});
  right.dims.push({orient: 'v', y1: 0, y2: g.H, side: 'right', value: g.H});

  const cells = `${p.nCells} cell${p.nCells === 1 ? '' : 's'}`;
  // the drawing dimensions the TRAY; the chain hands the wrap an envelope that
  // also covers product standing proud of the cells. Say both when they differ,
  // exactly as the 3D depth's HUD does, so the two can never read as a
  // contradiction (tray3d.js's `outer` doc carries the same note).
  const caption = `tray ${fmt(g.L)} × ${fmt(g.W)} × ${fmt(g.H)} ${unit} · ${cells}` +
    (tray.proud ? ` · envelope ${fmt(tray.outer.H)} ${unit} tall over proud product` : '');

  // NOTES — the values a callout could not letter legibly at this scale (a
  // 2.5mm flange against a 139mm tray) plus the BASE, stated as the base so it
  // can never be mistaken for the headline envelope dims. Drafting practice:
  // small and non-geometric values belong in a notes block, not on a leader
  // that overlaps the part. `effectiveDraftDeg` is the angle the tray actually
  // has — trayParams reduces it when the wall is too thin to take the full one.
  // NOTE the formatter: `exact` (the rail's own fmtInputValue), not the
  // callouts' whole-mm fmtLen. A 2.5mm flange rounds to "3" under fmtLen, and
  // a note that restates a PARAMETER has to read the same as the field the
  // user typed it into — the callouts dimension drawn geometry, these restate
  // inputs. Same values, the precision each is for.
  const notes = [
    `wall ${exact(p.wall)} · divider ${exact(p.divider)}`,
    `flange ${exact(p.stripL)} × ${exact(p.stripW)}, ${exact(p.flangeT)} thick · lip ${exact(p.lipH)}`,
    `draft ${p.effectiveDraftDeg.toFixed(1)}° · cradle R ${exact(p.cradleR)}`,
    `base (drafted, not the envelope) ${exact(g.bottomL)} × ${exact(g.bottomW)} ${unit}`
  ];
  return {tiles: [front, top, right], caption, notes};
}

/** @param {SVGElement} svg
 *  @param {Object} tray  a resolved tray stage: {params, outer, proud, ...}
 *  @param {'mm'|'in'} unit  display unit for labels only
 *  @returns {{w:number,h:number}} overall drawing extents, mm */
export function drawTray2d(svg, tray, unit){
  const fmt = v => fmtLen(v, unit);
  const {tiles, caption, notes} = layoutFor(tray, fmt, unit);

  const minX = Math.min(...tiles.map(t => t.x)), maxX = Math.max(...tiles.map(t => t.x + t.w));
  const minY = Math.min(...tiles.map(t => t.y)), maxY = Math.max(...tiles.map(t => t.y + t.h));
  const w = maxX - minX, h = maxY - minY;
  const m = Math.max(w, h)*0.22 + (unit === 'mm' ? 24 : 25.4);
  const capH = m*0.6;
  const VW = w + 2*m, VH = h + 2*m + capH;
  const ox = m - minX, oy = m - minY + capH;

  const strokeW = Math.max(VW, VH)/460;
  const dimFS = strokeW*9, dw = strokeW*0.7, tick = dimFS*0.5;
  const off = Math.max(w, h)*0.06 + dimFS*1.6;
  const dash = `stroke-dasharray="${strokeW*3} ${strokeW*2}"`;

  let body = '';
  for(const t of tiles){
    const x = t.x + ox, y = t.y + oy;
    body += `<text x="${x}" y="${y - strokeW*3}" fill="var(--muted)" font-family="var(--mono)" ` +
      `font-size="${strokeW*10}" letter-spacing="0.08em">${t.name}</text>`;
    for(const s of t.shapes){
      const stroke = s.hidden
        ? `stroke="${HID}" stroke-width="${strokeW*0.6}" ${dash} fill="none"`
        : `stroke="var(--ink)" stroke-width="${strokeW}" fill="rgba(20,26,31,0.04)"`;
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
      const val = fmt(d.value);
      const clear = off + (d.rank || 0)*dimFS*2.8;      // stacked callouts step outward
      if(d.orient === 'h'){
        const dy = d.side === 'below' ? y + t.h + clear : y - clear;
        body += dimLine('h', x + d.x1, dy, x + d.x2, dy, val, dimFS, dw, tick, d.key);
      }else{
        const dx = d.side === 'right' ? x + t.w + clear : x - clear;
        body += dimLine('v', dx, y + d.y1, dx, y + d.y2, val, dimFS, dw, tick, d.key);
      }
    }
  }

  body += `<text x="${VW/2}" y="${capH*0.62}" fill="var(--muted)" font-family="var(--mono)" ` +
    `font-size="${dimFS}" text-anchor="middle">${caption}</text>`;
  // NOTES, wrapped to the sheet. SVG does not wrap text, and an over-long line
  // is CLIPPED at the viewBox edge — value-correct and invisible, the exact
  // failure mode the blank GRID fields had. So the notes are packed into lines
  // that fit: monospace at `fs` is ~0.6*fs per character, which is a bound
  // rather than a guess for the one font family this drawing uses. The block
  // sits under the lowest callout, growing upward, so more notes never push
  // into the drawing.
  const nfs = dimFS*0.85, perChar = nfs*0.6, maxChars = Math.max(20, Math.floor((VW - 2*nfs)/perChar));
  const lines = [];
  for(const n of notes){
    const last = lines[lines.length - 1];
    if(last && (last.length + 3 + n.length) <= maxChars) lines[lines.length - 1] = `${last}  ·  ${n}`;
    else lines.push(n);
  }
  lines.forEach((ln, i) => {
    const yb = VH - nfs*0.8 - (lines.length - 1 - i)*nfs*1.35;
    body += `<text class="tray2dNote" x="${VW/2}" y="${yb}" fill="var(--ink-3)" ` +
      `font-family="var(--mono)" font-size="${nfs}" text-anchor="middle">${ln}</text>`;
  });

  view2d.base = [0, 0, VW, VH];
  apply2dView(svg);
  svg.innerHTML = body;
  return {w, h};
}
