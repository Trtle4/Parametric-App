/**
 * Artwork template export — the deliverable handed to a graphics designer, the
 * way DXF is a rigid style's, and the correctness mechanism for the whole
 * round-trip: the designer paints INSIDE this exact canvas, so the reupload
 * cannot be misregistered. Panel layout with labels, seal zones and bleed as
 * SEPARATE distinctly styled regions, fold positions as dashed references
 * (never crease styling), plus orientation marks (which way is up when folded)
 * and corner registration marks so the reupload aligns 1:1.
 *
 * Every region here is read from `geo.meta` (labels, sealZones, refLines) and
 * `geo.meta.artMap` — the SAME panel decomposition the 2D overlay and the 3D
 * UVs read — so the template can never draw a different picture than the map.
 * Registration marks are geometric (blank corners), not engineer-guessed seal
 * margins, which stay absent by design.
 */
import {fmtLen} from '../core/units.js';

/** A '+' registration cross with a ring, centred at (cx,cy) in svg coords. */
function regMark(cx, cy, r, sw){
  return `<g stroke="#141a1f" stroke-width="${sw}" fill="none">` +
    `<circle cx="${cx}" cy="${cy}" r="${r*0.6}"/>` +
    `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}"/>` +
    `<line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}"/></g>`;
}

export function buildArtworkSVG(geo, unit){
  const {maxX: W, maxY: H} = geo.bbox;
  const m = Math.max(W, H)*0.08 + 20;
  const fs = Math.max(W, H)/60;
  const y = v => H - v + m;                 // flip to screen coords
  const sz = geo.meta.sealZones || {ends: [], bleeds: [], fin: []};
  const am = geo.meta.artMap;
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

  // orientation: an up-arrow ("TOP") on each panel pointing the way the meta
  // says is up (artMap.up = 'v' → +v = up the web), defined once in the style.
  // Reassures the designer their art is not laid upside down.
  const up = am ? am.up : 'v';
  for(const l of geo.meta.labels || []){
    const ax = l.x + m, ah = fs*1.4;
    const ay = y(l.y) - fs*1.5;             // sit the arrow just above the label
    if(up === 'v')
      s += `<path d="M ${ax} ${ay - ah} L ${ax - fs*0.5} ${ay} L ${ax + fs*0.5} ${ay} Z" fill="#3a67d4"/>` +
           `<text x="${ax}" y="${ay - ah - fs*0.4}" font-family="monospace" font-size="${fs*0.6}" fill="#3a67d4" text-anchor="middle">TOP</text>`;
  }

  // panel labels
  for(const l of geo.meta.labels || [])
    s += `<text x="${l.x + m}" y="${y(l.y)}" font-family="monospace" font-size="${fs}" fill="#141a1f" text-anchor="middle" dominant-baseline="middle">${l.text}</text>`;

  // corner registration marks — geometric, at the four blank corners
  const rr = Math.max(W, H)/45, rsw = fs/7;
  s += regMark(m, m, rr, rsw) + regMark(m + W, m, rr, rsw) +
       regMark(m, m + H, rr, rsw) + regMark(m + W, m + H, rr, rsw);

  // film running-direction arrow along the bottom margin (the repeat axis)
  if(am){
    const ry = m + H + m*0.42, rx0 = m + am.product.x0, rx1 = m + am.product.x1;
    s += `<line x1="${rx0}" y1="${ry}" x2="${rx1}" y2="${ry}" stroke="#6b7682" stroke-width="${fs/9}"/>` +
      `<path d="M ${rx1} ${ry} L ${rx1 - fs*0.7} ${ry - fs*0.4} L ${rx1 - fs*0.7} ${ry + fs*0.4} Z" fill="#6b7682"/>` +
      `<text x="${(rx0 + rx1)/2}" y="${ry - fs*0.5}" font-family="monospace" font-size="${fs*0.6}" fill="#6b7682" text-anchor="middle">FILM RUNNING DIRECTION</text>`;
  }

  // header line — flow wrap states its film spec; any other style (carton)
  // states its blank. Both note the shared legend so the deliverable is
  // self-describing whatever the style.
  const f = geo.meta.film;
  const lead = f
    ? `flow wrap artwork template · web ${fmtLen(f.webWidth, unit)} ${unit} × repeat ${fmtLen(f.cutLength, unit)} ${unit}`
    : `${(geo.meta.style || 'carton').toUpperCase()} artwork template · blank ${fmtLen(W, unit)} × ${fmtLen(H, unit)} ${unit}`;
  s += `<text x="${m}" y="${m*0.55}" font-family="monospace" font-size="${fs*0.8}" fill="#6b7682">` +
    `${lead} · seal zones red · bleed amber · dashed = fold reference · ▲ = up · ⊕ = registration</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + 2*m} ${H + 2*m}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>${s}</svg>`;
}

function artworkName(geo, ext){
  const style = geo.meta.style || 'artwork';
  return `${style}_${Math.round(geo.bbox.maxX)}x${Math.round(geo.bbox.maxY)}mm_artwork.${ext}`;
}

export function downloadArtwork(geo, unit){
  const blob = new Blob([buildArtworkSVG(geo, unit)], {type: 'image/svg+xml'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = artworkName(geo, 'svg');
  a.click(); URL.revokeObjectURL(a.href);
}

/** Rasterise the template SVG to a PNG at the blank's real size (2 px/mm, so
 *  the designer can paint straight onto it) and download it. Browser-side. */
export function downloadArtworkPNG(geo, unit){
  const {maxX: W, maxY: H} = geo.bbox;
  const m = Math.max(W, H)*0.08 + 20;
  const PX = 2;                                     // 2 px per mm
  const cw = Math.round((W + 2*m)*PX), ch = Math.round((H + 2*m)*PX);
  // buildArtworkSVG carries only a viewBox; an <img> raster with no intrinsic
  // size renders 0×0 in Chromium (the PNG came out blank / never fired), so
  // inject explicit px width/height — exactly what the working 2D-PNG path does
  // (export/png.js). The viewBox is unchanged, so the aspect ratio is preserved.
  const svg = buildArtworkSVG(geo, unit).replace('<svg ', `<svg width="${cw}" height="${ch}" `);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);
    g.drawImage(img, 0, 0, cw, ch);
    c.toBlob(b => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = artworkName(geo, 'png');
      a.click(); URL.revokeObjectURL(a.href);
    }, 'image/png');
  };
  img.onerror = () => console.error('artwork PNG raster failed to load the template SVG');
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
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
