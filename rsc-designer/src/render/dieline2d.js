/**
 * 2D dieline renderer. Draws a style Geometry (mm) into an <svg>, with
 * zoom/pan state. Display strings are formatted in the caller's unit;
 * geometry stays mm throughout.
 */
import {fmtLen} from '../core/units.js';

const esc = s => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// zoom/pan state + base viewBox — mutated by app.js event wiring, same as before
export const view2d = {z: 1, panX: 0, panY: 0, base: [0, 0, 1000, 1000]};

export function apply2dView(svg){
  const VW = view2d.base[2], VH = view2d.base[3];
  const vw = VW/view2d.z, vh = VH/view2d.z;
  view2d.panX = Math.max(-(VW - vw)/2, Math.min((VW - vw)/2, view2d.panX));
  view2d.panY = Math.max(-(VH - vh)/2, Math.min((VH - vh)/2, view2d.panY));
  svg.setAttribute('viewBox', `${((VW - vw)/2 + view2d.panX).toFixed(2)} ${((VH - vh)/2 + view2d.panY).toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`);
}

/**
 * Style-agnostic: everything drawn beyond the cut/crease paths comes from
 * the style's generic meta annotations (labels, hDims, vDims, print).
 * @param {SVGElement} svg
 * @param {import('../core/types.js').Geometry} g
 * @param {'mm'|'in'} unit    display unit for labels only
 * @param {string} printText
 * @returns {{w:number, h:number}} blank extents, mm
 */
export function draw2d(svg, g, unit, printText){
  // margin: the mm constant matches the old per-unit margins exactly
  // (old: +24 in mm mode, +1 inch = +25.4 mm in inch mode)
  const m = Math.max(g.bbox.maxX, g.bbox.maxY)*0.14 + (unit === 'mm' ? 24 : 25.4);
  const w = g.bbox.maxX, h = g.bbox.maxY;
  const VW = w + 2*m, VH = h + 2*m;
  const fx = x => x - g.bbox.minX + m;              // world x -> svg x
  const fy = y => (g.bbox.maxY - y) + m;            // world y -> svg y (flip)
  const fmt = v => fmtLen(v, unit);

  const pts = g.cut.map(pt => `${fx(pt[0]).toFixed(2)},${fy(pt[1]).toFixed(2)}`).join(' ');
  const strokeW = Math.max(VW, VH)/460;

  let creases = '';
  g.crease.forEach(c => {
    creases += `<line x1="${fx(c[0]).toFixed(2)}" y1="${fy(c[1]).toFixed(2)}" x2="${fx(c[2]).toFixed(2)}" y2="${fy(c[3]).toFixed(2)}" stroke="var(--crease)" stroke-width="${strokeW}" stroke-dasharray="${strokeW*4} ${strokeW*3}"/>`;
  });

  // Seal zones and bleed (style-provided, generic — no styleId check): the
  // SAME g.meta.sealZones the artwork exporter draws from (export/
  // artwork.js), styled identically (bleed amber/dashed, seal zones pink/
  // solid) so the 2D view and the artwork template can never show two
  // different pictures of the same annotation data. `ends`/`fin` span the
  // full opposite axis (a seal band runs edge-to-edge); `bleeds` likewise.
  const sz = g.meta.sealZones || {};
  const ZONE_LABEL = {ends: 'END SEAL', bleeds: 'BLEED', fin: 'FIN SEAL'};
  let zones = '', zoneLabels = '';
  const zoneFS = strokeW*8;
  // `ends`/`bleeds` zones are narrow COLUMNS (endSealBleed/endSealWidth are
  // typically single-digit-to-low-double-digit mm) — horizontal text would
  // overflow into the neighbouring zone and collide (confirmed: BLEED and
  // END SEAL rendered on top of each other before this rotated). `fin`
  // zones are full-width rows, so their label stays horizontal.
  const zoneLabelV = (x, y, text) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#9aa6b2" font-family="var(--mono)" font-size="${zoneFS}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-90 ${x.toFixed(1)} ${y.toFixed(1)})">${text}</text>`;
  const zoneLabelH = (x, y, text) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#9aa6b2" font-family="var(--mono)" font-size="${zoneFS}" text-anchor="middle" dominant-baseline="middle">${text}</text>`;
  for(const b of sz.bleeds || []){
    const x = fx(b.x0), y = fy(h), rw = b.x1 - b.x0;
    zones += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${rw.toFixed(2)}" height="${h.toFixed(2)}" fill="#f5a62333" stroke="#f5a623" stroke-width="${strokeW*0.7}" stroke-dasharray="${strokeW*3} ${strokeW*2}"/>`;
    zoneLabels += zoneLabelV(x + rw/2, fy(h/2), ZONE_LABEL.bleeds);
  }
  for(const e of sz.ends || []){
    const x = fx(e.x0), y = fy(h), rw = e.x1 - e.x0;
    zones += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${rw.toFixed(2)}" height="${h.toFixed(2)}" fill="#e5484d22" stroke="#e5484d" stroke-width="${strokeW*0.7}"/>`;
    zoneLabels += zoneLabelV(x + rw/2, fy(h/2), ZONE_LABEL.ends);
  }
  for(const f of sz.fin || []){
    const x = fx(0), y = fy(f.y1), rh = f.y1 - f.y0;
    zones += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${rh.toFixed(2)}" fill="#e5484d22" stroke="#e5484d" stroke-width="${strokeW*0.7}"/>`;
    zoneLabels += zoneLabelH(fx(w/2), y + rh/2, ZONE_LABEL.fin);
  }

  // Fold/panel-boundary REFERENCES (style-provided, generic — no styleId
  // check): g.meta.refLines are explicitly NOT creases (a film is never
  // scored; a rigid style has none today). Styled distinctly from the
  // crease layer above — grey and a different dash rhythm, never
  // var(--crease)/blue — so a reference line can never be mistaken for an
  // actual fold, on screen or at a glance.
  let refs = '';
  (g.meta.refLines || []).forEach(r => {
    refs += `<line x1="${fx(r[0]).toFixed(2)}" y1="${fy(r[1]).toFixed(2)}" x2="${fx(r[2]).toFixed(2)}" y2="${fy(r[3]).toFixed(2)}" stroke="#8593a1" stroke-width="${strokeW*0.7}" stroke-dasharray="${strokeW*2.5} ${strokeW*1.5}"/>`;
  });

  // panel labels (style-provided)
  const labels = (g.meta.labels || []).map(l =>
    `<text x="${fx(l.x).toFixed(1)}" y="${fy(l.y).toFixed(1)}" fill="#9aa6b2" font-family="var(--mono)" font-size="${strokeW*11}" text-anchor="middle" dominant-baseline="middle">${esc(l.text)}</text>`
  ).join('');

  // free print text on the style's print panel
  let printTxt = '';
  const pr = g.meta.print;
  if(printText && pr){
    const cx = fx((pr.x0 + pr.x1)/2);
    const cy = fy((pr.y0 + pr.y1)/2) + strokeW*16;
    const maxW = (pr.x1 - pr.x0)*0.86;
    let fs = Math.min(strokeW*14, (pr.y1 - pr.y0)*0.28);
    // crude width fit: ~0.62em average glyph width
    if(printText.length*fs*0.62 > maxW) fs = maxW/(printText.length*0.62);
    printTxt = `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" fill="var(--ink)" font-family="var(--sans)" font-weight="700" font-size="${fs.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" letter-spacing="0.06em">${esc(printText)}</text>`;
  }

  // key dimensions: per-panel widths below the blank, flap/height on the right
  const dimFS = strokeW*9, dimC = 'var(--ink-2)', dw = strokeW*0.7, tick = dimFS*0.5;
  const dimH = (a, b, y, val) => {
    const x1 = fx(a), x2 = fx(b);
    if(x2 - x1 < dimFS*0.9) return '';
    return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${dimC}" stroke-width="${dw}"/>` +
      `<line x1="${x1}" y1="${y - tick}" x2="${x1}" y2="${y + tick}" stroke="${dimC}" stroke-width="${dw}"/>` +
      `<line x1="${x2}" y1="${y - tick}" x2="${x2}" y2="${y + tick}" stroke="${dimC}" stroke-width="${dw}"/>` +
      `<text x="${(x1 + x2)/2}" y="${y - dimFS*0.45}" fill="${dimC}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle">${val}</text>`;
  };
  const dimV = (a, b, x, val) => {
    const y1 = fy(b), y2 = fy(a);
    if(y2 - y1 < dimFS*0.9) return '';
    const cy = (y1 + y2)/2, tx = x - dimFS*0.45;
    return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${dimC}" stroke-width="${dw}"/>` +
      `<line x1="${x - tick}" y1="${y1}" x2="${x + tick}" y2="${y1}" stroke="${dimC}" stroke-width="${dw}"/>` +
      `<line x1="${x - tick}" y1="${y2}" x2="${x + tick}" y2="${y2}" stroke="${dimC}" stroke-width="${dw}"/>` +
      `<text x="${tx}" y="${cy}" fill="${dimC}" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle" transform="rotate(-90 ${tx} ${cy})">${val}</text>`;
  };
  const yRow = fy(0) + m*0.30, xCol = fx(w) + m*0.30;
  let dims = '';
  for(const dd of g.meta.hDims || []) dims += dimH(dd.from, dd.to, yRow, fmt(dd.v));
  for(const dd of g.meta.vDims || []) dims += dimV(dd.from, dd.to, xCol, fmt(dd.v));

  // overall dimension labels
  const overall = `
    <text x="${(fx(0) + fx(w))/2}" y="${(fy(0) + m*0.68).toFixed(1)}" fill="var(--muted)" font-family="var(--mono)" font-size="${dimFS}" text-anchor="middle">blank ${fmt(w)} × ${fmt(h)} ${unit}</text>`;

  view2d.base = [0, 0, VW, VH];
  apply2dView(svg);
  svg.innerHTML = `
    ${zones}
    ${creases}
    <polygon points="${pts}" fill="rgba(229,72,77,0.04)" stroke="var(--cut)" stroke-width="${strokeW}" stroke-linejoin="round"/>
    ${refs}
    ${labels}${zoneLabels}${printTxt}${dims}${overall}`;

  return {w, h};
}
