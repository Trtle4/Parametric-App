/**
 * Artwork template export for flexible styles — the deliverable handed to a
 * graphics designer, the way DXF is a rigid style's. Panel layout with
 * labels, seal zones and bleed drawn as SEPARATE, distinctly styled regions,
 * and fold positions as dashed references (never crease styling).
 *
 * NOTE: registration marks and seal-safe margins are deliberately ABSENT —
 * they are engineer-specified, not guessed (per project constraint).
 */
import {fmtLen} from '../core/units.js';

export function buildArtworkSVG(geo, unit){
  const {maxX: W, maxY: H} = geo.bbox;
  const m = Math.max(W, H)*0.08 + 20;
  const fs = Math.max(W, H)/60;
  const y = v => H - v + m;                 // flip to screen coords
  const sz = geo.meta.sealZones || {ends: [], bleeds: [], fin: []};
  let s = '';

  // bleed: outermost, hatched amber; seal zones: solid pink; fin bands: pink
  for(const b of sz.bleeds)
    s += `<rect x="${b.x0 + m}" y="${m}" width="${b.x1 - b.x0}" height="${H}" fill="#f5a62333" stroke="#f5a623" stroke-dasharray="4 3" stroke-width="${fs/8}"/>`;
  for(const e of sz.ends)
    s += `<rect x="${e.x0 + m}" y="${m}" width="${e.x1 - e.x0}" height="${H}" fill="#e5484d22" stroke="#e5484d" stroke-width="${fs/8}"/>`;
  for(const f of sz.fin)
    s += `<rect x="${m}" y="${y(f.y1)}" width="${W}" height="${f.y1 - f.y0}" fill="#e5484d22" stroke="#e5484d" stroke-width="${fs/8}"/>`;

  // blank outline
  s += `<rect x="${m}" y="${m}" width="${W}" height="${H}" fill="none" stroke="#141a1f" stroke-width="${fs/5}"/>`;

  // fold references: dashed gray, explicitly labeled as references
  for(const r of geo.meta.refLines || [])
    s += `<line x1="${r[0] + m}" y1="${y(r[1])}" x2="${r[2] + m}" y2="${y(r[3])}" stroke="#8593a1" stroke-width="${fs/8}" stroke-dasharray="${fs} ${fs/2}"/>`;

  // panel labels
  for(const l of geo.meta.labels || [])
    s += `<text x="${l.x + m}" y="${y(l.y)}" font-family="monospace" font-size="${fs}" fill="#141a1f" text-anchor="middle" dominant-baseline="middle">${l.text}</text>`;

  // header line
  const f = geo.meta.film;
  s += `<text x="${m}" y="${m*0.55}" font-family="monospace" font-size="${fs*0.8}" fill="#6b7682">` +
    `flow wrap artwork template · web ${fmtLen(f.webWidth, unit)} ${unit} × repeat ${fmtLen(f.cutLength, unit)} ${unit}` +
    ` · seal zones red · bleed amber · dashed = fold reference (not crease)</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + 2*m} ${H + 2*m}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>${s}</svg>`;
}

export function downloadArtwork(geo, unit){
  const blob = new Blob([buildArtworkSVG(geo, unit)], {type: 'image/svg+xml'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const f = geo.meta.film;
  a.download = `flowwrap_${Math.round(f.webWidth)}x${Math.round(f.cutLength)}mm_artwork.svg`;
  a.click(); URL.revokeObjectURL(a.href);
}

/** Copyable film spec text. */
export function filmSpecText(geo, unit){
  const f = geo.meta.film;
  return [
    `Flow wrap film spec`,
    `Web width:        ${fmtLen(f.webWidth, unit)} ${unit}`,
    `Repeat (cut len): ${fmtLen(f.cutLength, unit)} ${unit}`,
    `Film area/pack:   ${f.filmAreaM2.toFixed(4)} m²`,
    `Packs/metre web:  ${f.packsPerMetre.toFixed(2)}`,
    `Mass/1000 packs:  ${Math.round(f.massPer1000g)} g`
  ].join('\n');
}
