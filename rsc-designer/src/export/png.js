/**
 * Client-side PNG export (this app runs on GitHub Pages — no server):
 *   - 2D dieline/blank: rasterize the SVG's FULL natural extent (view2d.base)
 *     at a fixed resolution, independent of the on-screen zoom/pan. The SVG
 *     markup emits CSS custom properties (var(--cut), var(--crease), …) and
 *     the DM Mono / Hanken families; an <img> raster is an isolated context
 *     with no access to the page's :root variables or its @font-face cache,
 *     so those are resolved to LITERAL values first — otherwise the file
 *     renders black-on-transparent. Fonts are embedded as base64 @font-face
 *     (best-effort) so the numerals actually come out in DM Mono, not a
 *     system fallback.
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
 * Font families carry double quotes ("DM Mono",…) that would break the
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

// --- font embedding: fetch the page's own DM Mono + Hanken woff2 once, base64,
// and build @font-face rules the isolated SVG raster can actually use. Cached;
// wrapped so a fetch failure degrades to system fonts rather than breaking
// the export. ------------------------------------------------------------
let fontCss = null;   // resolved <style> body, or '' if unavailable
const FONT_FACES = [
  {family: 'DM Mono', css: 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&display=swap'},
  {family: 'Hanken Grotesk', css: 'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@600;700&display=swap'}
];

async function toDataUri(url){
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:font/woff2;base64,${btoa(bin)}`;
}

async function embeddedFontCss(){
  if(fontCss !== null) return fontCss;
  try{
    const blocks = [];
    for(const f of FONT_FACES){
      // Google's css2 returns @font-face blocks with gstatic woff2 URLs; grab
      // the first (latin) src per family — enough for dimension text + labels.
      const css = await (await fetch(f.css)).text();
      const url = (css.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
      if(!url) continue;
      const data = await toDataUri(url);
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
