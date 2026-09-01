/**
 * 2D dieline renderer. Draws a style Geometry (mm) into an <svg>, with
 * zoom/pan state. Display strings are formatted in the caller's unit;
 * geometry stays mm throughout.
 */
import {fmtLen} from '../core/units.js';
import {artImageSVG} from './artwork.js';
import {auxLayersSVG} from './auxlayers.js';

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
 * @param {string} printText  accepted for signature stability; never drawn
 *        here (see the note at its one remaining use, below) — kept so
 *        callers don't need updating for a display-only decision
 * @param {{src:string,fit:string,dx:number,dy:number,scale:number}|null} art
 *        uploaded artwork placed over the blank (under the outlines), or null
 * @returns {{w:number, h:number}} blank extents, mm
 */
export function draw2d(svg, g, unit, printText, art){
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
  const ZONE_LABEL = {ends: 'END SEAL', bleeds: 'BLEED', fin: 'FIN SEAL', ramps: 'RAMP'};
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
  // the ramped-film region between the flat crimp and the product panel — the
  // film that descends to the crimp line (its slant), a distinct zone from the
  // flat crimp so the 2D blank matches the 3D ramp.
  for(const r of sz.ramps || []){
    const x = fx(r.x0), y = fy(h), rw = r.x1 - r.x0;
    zones += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${rw.toFixed(2)}" height="${h.toFixed(2)}" fill="#e5484d11" stroke="#e5484d" stroke-width="${strokeW*0.5}" stroke-dasharray="${strokeW*2} ${strokeW*2}"/>`;
    zoneLabels += zoneLabelV(x + rw/2, fy(h/2), ZONE_LABEL.ramps);
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

  // free print text on the style's print panel: NEVER drawn on the 2D
  // dieline. The #txt control that used to set it was hidden app-wide (see
  // index.html: "3D views are translucent now, print text doesn't read") —
  // the field is a save-compat relic (old saves and legacy defaults, back
  // when it was 'FRAGILE', still carry a value; readState()/persistence
  // still round-trip it), not a live feature — yet this renderer kept
  // drawing it in crisp black text regardless, which is the one place it
  // was still visibly showing up. 3D is untouched by this: buildBox() still
  // bakes printText into the kraft box's material there, for whatever that
  // is worth given the translucency note above. `printText` stays a
  // parameter (callers still pass it, harmlessly) so this stays a display
  // decision, not a signature change.
  const printTxt = '';

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

  // Auxiliary die layers (geo.aux) — GENERIC. This renderer names no layer:
  // it walks whatever `aux` carries and reads each one's stroke, weight and
  // draw order from render/auxlayers.js, which is also what the legend reads.
  // Drawn AFTER the cut polygon, because a tear line hidden under the cut it
  // crosses reads as absent.
  const auxSVG = auxLayersSVG(g.aux, fx, fy, strokeW);

  // uploaded artwork sits UNDERNEATH the panel outlines/labels so registration
  // is visibly correct. The blank canvas is the bbox (0..w × 0..h) — the same
  // canvas the template exported and the designer painted on — so a template-
  // sized upload maps 1:1 with the default 'stretch' fit.
  let artLayer = '';
  if(art && art.src) artLayer = artImageSVG(art, w, h, fx, fy, 'artClip');

  view2d.base = [0, 0, VW, VH];
  apply2dView(svg);
  svg.innerHTML = `
    ${artLayer}
    ${zones}
    ${creases}
    <polygon points="${pts}" fill="rgba(229,72,77,0.04)" stroke="var(--cut)" stroke-width="${strokeW}" stroke-linejoin="round"/>
    ${auxSVG}
    ${refs}
    ${labels}${zoneLabels}${printTxt}${dims}${overall}`;

  return {w, h};
}
