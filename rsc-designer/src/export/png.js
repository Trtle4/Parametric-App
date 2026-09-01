/**
 * Client-side PNG export (this app runs on GitHub Pages — no server):
 *   - 2D dieline/blank: rasterize the SVG's FULL natural extent (view2d.base)
 *     at a fixed resolution, independent of the on-screen zoom/pan. The SVG
 *     markup emits CSS custom properties (var(--cut), var(--crease), …) and
 *     the app's own font families; an <img> raster is an isolated context
 *     with no access to the page's :root variables or its @font-face cache,
 *     so those are resolved to LITERAL values first — otherwise the file
 *     renders black-on-transparent. Fonts are embedded as base64 @font-face
 *     (best-effort) so a drawing's numerals come out in the app's own
 *     monospace, not a system fallback.
 *   - 3D: fold3d.capturePNG reads the WebGL drawing buffer directly (see there).
 */
import {view2d} from '../render/dieline2d.js';

/**
 * Replace every var(--token) in the markup with its computed literal value.
 *
 * A standalone SVG has no document to inherit custom properties from, so any
 * var() left in it is INVALID AT COMPUTED-VALUE TIME — and an invalid `stroke`
 * falls back to `none`. The line does not go wrong, it goes MISSING, only in
 * the export, which is where nobody is looking.
 *
 * The tokens are therefore SCANNED OUT OF THE MARKUP, never listed here. The
 * list this replaced was hand-maintained and had gone stale exactly as this
 * codebase's one-writer rule predicts: the tray drawing introduced
 * `var(--accent)` for its cell boundaries, the list did not have it, and the
 * exported PNG dropped every cell line and the legend swatch that names them
 * while the on-screen drawing was perfect. Scanning cannot go stale.
 *
 * Font families carry double quotes ("IBM Plex Mono",…) that would break the
 * double-quoted SVG attribute they sit in, so those get re-quoted single.
 *
 * Exported so a pin can run the app's REAL drawing markup through it and
 * assert nothing is left unresolved.
 */
export function inlineTokens(markup){
  const cs = getComputedStyle(document.documentElement);
  const seen = new Set(markup.match(/var\(--[a-zA-Z0-9-]+\)/g) || []);
  let out = markup;
  for(const ref of seen){
    let val = cs.getPropertyValue(ref.slice(4, -1)).trim();
    if(!val) continue;
    if(val.includes('"')) val = val.replace(/"/g, "'");
    out = out.split(ref).join(val);
  }
  return out;
}

/** Trigger a browser download of a data/blob URL. */
export function savePNG(url, filename){
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
}

/** Download raw bytes (the PDF export). Object URL revoked after the click —
 *  the browser holds its own reference for the download. */
export function saveBlob(bytes, filename, type = 'application/pdf'){
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// --- font embedding: base64 the page's OWN vendored woff2 files once and
// build @font-face rules the isolated SVG raster can actually use. Cached;
// wrapped so a failure degrades to system fonts rather than breaking the
// export.
//
// READ FROM THE PAGE'S OWN STYLESHEET, never from a list here. This used to
// name two font families with hardcoded fonts.googleapis.com
// URLs -- a hand-maintained copy of a fact that lives in fonts/fonts.css,
// which is exactly the shape that let this same module ship a stale token
// list once before (the exported PNG dropped every cell line because
// `--accent` was missing from a hand-written array). Now it walks the real
// @font-face rules the document already loaded, so renaming a family or
// swapping a weight cannot leave this behind, and an export made offline
// embeds the same faces the screen is using.
// ------------------------------------------------------------------------
let fontCss = null;   // resolved <style> body, or '' if unavailable

async function toDataUri(url){
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:font/woff2;base64,${btoa(bin)}`;
}

/** Every @font-face the document actually loaded, as {family, url} — read
 *  out of the live stylesheets. A cross-origin sheet throws on .cssRules
 *  access; ours is same-origin, and a throw is caught per sheet so one
 *  unreadable third-party sheet cannot cost us the readable ones. */
function documentFontFaces(){
  const out = [];
  for(const sheet of document.styleSheets){
    let rules;
    try{ rules = sheet.cssRules; }catch(e){ continue; }
    if(!rules) continue;
    for(const r of rules){
      if(r.type !== CSSRule.FONT_FACE_RULE) continue;
      const family = (r.style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim();
      const src = r.style.getPropertyValue('src') || '';
      const url = (src.match(/url\(["']?([^"')]+)["']?\)/) || [])[1];
      if(family && url) out.push({family, url, weight: r.style.getPropertyValue('font-weight') || '400'});
    }
  }
  return out;
}

async function embeddedFontCss(){
  if(fontCss !== null) return fontCss;
  try{
    const faces = documentFontFaces();
    // ONE face per family is enough for the raster (dimension text + labels);
    // taking them all would base64 every weight and subset into every export.
    const seen = new Set(), blocks = [];
    for(const f of faces){
      if(seen.has(f.family)) continue;
      seen.add(f.family);
      const data = await toDataUri(f.url);
      blocks.push(`@font-face{font-family:'${f.family}';font-style:normal;font-weight:400 700;src:url(${data}) format('woff2');}`);
    }
    fontCss = blocks.join('');
  }catch(e){
    fontCss = '';   // best-effort: fall back to system fonts, never break export
  }
  return fontCss;
}

/**
 * Rasterize the live 2D SVG at its FULL blank extent to a PNG download.
 * @param {SVGElement} svgEl   the on-screen <svg> (its innerHTML is reused)
 * @param {string} filename
 * @param {{outWidth?:number, background?:string}} opts
 *        outWidth: px on the long side (fixed output resolution, default 2000)
 *        background: '#ffffff' (default) — a solid white sheet, not transparent
 */
export async function downloadSvgPNG(svgEl, filename, {outWidth = 2000, background = '#ffffff'} = {}){
  const [bx, by, bw, bh] = view2d.base;   // the FULL extent, never the zoom/pan viewBox
  if(!(bw > 0 && bh > 0)) return;
  const s = outWidth/Math.max(bw, bh);
  const W = Math.round(bw*s), H = Math.round(bh*s);

  const style = await embeddedFontCss();
  const inner = inlineTokens(svgEl.innerHTML);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${bx} ${by} ${bw} ${bh}">` +
    (style ? `<defs><style>${style}</style></defs>` : '') + inner + `</svg>`;

  const svgUrl = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml;charset=utf-8'}));
  try{
    await document.fonts.ready;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = svgUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    savePNG(canvas.toDataURL('image/png'), filename);
  }finally{
    URL.revokeObjectURL(svgUrl);
  }
}
