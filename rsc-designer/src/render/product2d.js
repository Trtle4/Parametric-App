/**
 * Product/piece 2D drawing — a standard orthographic multiview of the
 * PIECE ALONE (never the collation, the wrap, or anything above it; the
 * collation already has its own 3D representation and fill readout).
 *
 * This is deliberately NOT a dieline. A product has no blank, no cut, no
 * crease, and no material compensation, so it does not implement the
 * `Geometry` contract (core/types.js) and is never routed through
 * dieline2d.js's cut/crease renderer — a fake single-panel "cut path"
 * standing in for a piece is exactly the trap the film style nearly fell
 * into. A dieline is one flat blank; a multiview is 2-3 separate
 * projections of a solid. They cannot share a renderer, so this is its own
 * sibling module. dieline2d.js is not edited — this file only IMPORTS its
 * already-exported zoom/pan state (`view2d`/`apply2dView`) so the product
 * view shares the exact same interaction (scroll to zoom, drag to pan,
 * dblclick to reset) and the exact same <svg id="svg"> element, rather
 * than inventing a second, parallel zoom/pan mechanism.
 *
 * Third-angle arrangement: top view above the front view, side view to
 * the right of the front view — the same convention this drawing itself
 * follows. Every view is independently, fully dimensioned (some values
 * necessarily repeat across adjacent views — e.g. L appears on both FRONT
 * and TOP — which is correct multiview practice, not redundancy to
 * dedupe).
 */
import {fmtLen} from '../core/units.js';
import {view2d, apply2dView} from './dieline2d.js';

const DIM_C = 'var(--ink-2)';

/** Resolve the piece's own shape from whichever of the three primary-level
 *  input modes is active today — plain box, a box-piece collation, or a
 *  cylinder-piece collation — collapsing them into ONE small shape
 *  descriptor a renderer can draw without caring which mode produced it.
 *  Returns null if there's nothing to draw (no box and no collation
 *  piece configured yet). Plain-box content IS a product envelope and is
 *  drawn the same rectangular three-view as a box piece. */
export function resolveProductPiece(primary){
  if(!primary) return null;
  if(primary.box) return {kind: 'box', L: primary.box.L, W: primary.box.W, H: primary.box.H};
  const piece = primary.collation && primary.collation.piece;
  if(!piece) return null;
  return piece.kind === 'cylinder'
    ? {kind: 'cylinder', diameter: piece.diameter, thickness: piece.thickness}
    : {kind: 'box', L: piece.L, W: piece.W, H: piece.H};
}

/** Lay out the view tiles (world mm, Y-down) for a box piece: FRONT (L×H)
 *  at the origin, TOP (L×W) directly above it, SIDE (W×H) directly to its
 *  right — standard third-angle projection. `gap` separates tiles; each
 *  tile also carries its OWN two dimension callouts, placed on whichever
 *  of its four sides is empty (never the side an adjacent tile occupies),
 *  so nothing overlaps regardless of piece proportions. */
function boxLayout(L, W, H){
  const gap = Math.max(L, W, H)*0.32;
  const front = {name: 'FRONT', shape: 'rect', x: 0, y: 0, w: L, h: H,
    dims: [{orient: 'h', side: 'below', value: L}, {orient: 'v', side: 'left', value: H}]};
  const top = {name: 'TOP', shape: 'rect', x: 0, y: -(W + gap), w: L, h: W,
    dims: [{orient: 'h', side: 'above', value: L}, {orient: 'v', side: 'right', value: W}]};
  const side = {name: 'SIDE', shape: 'rect', x: L + gap, y: 0, w: W, h: H,
    dims: [{orient: 'h', side: 'above', value: W}, {orient: 'v', side: 'right', value: H}]};
  return {tiles: [front, top, side], caption: `box ${L} × ${W} × ${H}`};
}

/** Lay out the view tiles for a cylindrical piece: CROSS SECTION
 *  (diameter × thickness, a rectangle) with TOP (a diameter-only circle)
 *  above it. The circle carries a single ⌀ callout rather than a
 *  redundant width+height pair — a diameter is one value, not two. */
function cylinderLayout(d, t){
  const gap = Math.max(d, t)*0.32;
  const cross = {name: 'CROSS SECTION', shape: 'rect', x: 0, y: 0, w: d, h: t,
    dims: [{orient: 'h', side: 'below', value: d}, {orient: 'v', side: 'left', value: t}]};
  const top = {name: 'TOP', shape: 'circle', x: 0, y: -(d + gap), w: d, h: d,
    dims: [{orient: 'h', side: 'above', value: d, diameter: true}]};
  return {tiles: [cross, top], caption: `cylinder ⌀${d} × ${t}`};
}

function layoutFor(piece){
  return piece.kind === 'cylinder' ? cylinderLayout(piece.diameter, piece.thickness) : boxLayout(piece.L, piece.W, piece.H);
}

/** One dimension line + two end-ticks + centered label — visually
 *  identical to dieline2d.js's own dimH/dimV (same tick size, stroke, mono
 *  font, muted blue-grey), reproduced here rather than imported because
 *  dieline2d's versions are private closures over ITS OWN world-to-svg
 *  flip; this module's coordinate space is plain Y-down (no flip needed),
 *  and it draws one dimension per VIEW TILE rather than one shared
 *  row/column for the whole drawing. */
function dimLine(orient, x1, y1, x2, y2, val, dimFS, dw, tick){
  if(orient === 'h'){
    if(x2 - x1 < dimFS*0.9) return '';
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y1}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<line x1="${x1}" y1="${y1 - tick}" x2="${x1}" y2="${y1 + tick}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<line x1="${x2}" y1="${y1 - tick}" x2="${x2}" y2="${y1 + tick}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
      `<text x="${(x1 + x2)/2}" y="${y1 - dimFS*0.45}" fill="${DIM_C}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle">${val}</text>`;
  }
  if(y2 - y1 < dimFS*0.9) return '';
  const cy = (y1 + y2)/2, tx = x1 - dimFS*0.45;
  return `<line x1="${x1}" y1="${y1}" x2="${x1}" y2="${y2}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<line x1="${x1 - tick}" y1="${y1}" x2="${x1 + tick}" y2="${y1}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<line x1="${x1 - tick}" y1="${y2}" x2="${x1 + tick}" y2="${y2}" stroke="${DIM_C}" stroke-width="${dw}"/>` +
    `<text x="${tx}" y="${cy}" fill="${DIM_C}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle" transform="rotate(-90 ${tx} ${cy})">${val}</text>`;
}

/** @param {SVGElement} svg
 *  @param {{kind:'box',L:number,W:number,H:number}|{kind:'cylinder',diameter:number,thickness:number}} piece  mm
 *  @param {'mm'|'in'} unit  display unit for labels only
 *  @returns {{w:number,h:number}} overall drawing extents, mm */
export function drawProduct2d(svg, piece, unit){
  const {tiles, caption} = layoutFor(piece);
  const fmt = v => fmtLen(v, unit);

  const minX = Math.min(...tiles.map(t => t.x)), maxX = Math.max(...tiles.map(t => t.x + t.w));
  const minY = Math.min(...tiles.map(t => t.y)), maxY = Math.max(...tiles.map(t => t.y + t.h));
  const w = maxX - minX, h = maxY - minY;
  const m = Math.max(w, h)*0.22 + (unit === 'mm' ? 24 : 25.4);
  const capH = m*0.6;                                     // room for the caption above everything
  const VW = w + 2*m, VH = h + 2*m + capH;
  const ox = m - minX, oy = m - minY + capH;               // world -> svg translation

  const strokeW = Math.max(VW, VH)/460;
  const dimFS = strokeW*9, dw = strokeW*0.7, tick = dimFS*0.5;
  const off = Math.max(w, h)*0.06 + dimFS*1.6;             // dimension line clearance from its tile

  let body = '';
  for(const t of tiles){
    const x = t.x + ox, y = t.y + oy;
    const nameY = y - strokeW*3;
    body += `<text x="${x}" y="${nameY}" fill="var(--muted)" font-family="var(--mono)" font-size="${strokeW*10}" letter-spacing="0.08em">${t.name}</text>`;
    if(t.shape === 'circle'){
      const r = t.w/2;
      body += `<circle cx="${x + r}" cy="${y + r}" r="${r}" fill="rgba(20,26,31,0.04)" stroke="var(--ink)" stroke-width="${strokeW}"/>` +
        `<line x1="${x}" y1="${y + r}" x2="${x + t.w}" y2="${y + r}" stroke="var(--ink)" stroke-width="${strokeW*0.6}" stroke-dasharray="${strokeW*3} ${strokeW*2}"/>` +
        `<line x1="${x + r}" y1="${y}" x2="${x + r}" y2="${y + t.h}" stroke="var(--ink)" stroke-width="${strokeW*0.6}" stroke-dasharray="${strokeW*3} ${strokeW*2}"/>`;
    }else{
      body += `<rect x="${x}" y="${y}" width="${t.w}" height="${t.h}" fill="rgba(20,26,31,0.04)" stroke="var(--ink)" stroke-width="${strokeW}"/>`;
    }
    for(const d of t.dims){
      const val = d.diameter ? `⌀${fmt(d.value)}` : fmt(d.value);
      if(d.orient === 'h'){
        const dy = d.side === 'below' ? y + t.h + off : y - off;
        body += dimLine('h', x, dy, x + t.w, dy, val, dimFS, dw, tick);
      }else{
        const dx = d.side === 'right' ? x + t.w + off : x - off;
        body += dimLine('v', dx, y, dx, y + t.h, val, dimFS, dw, tick);
      }
    }
  }

  const overall = `<text x="${VW/2}" y="${capH*0.62}" fill="var(--muted)" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle">${caption} ${unit}</text>`;

  view2d.base = [0, 0, VW, VH];
  apply2dView(svg);
  svg.innerHTML = `${body}${overall}`;

  return {w, h};
}
