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

// CSS custom properties the 2D renderers emit as var(--x); the rest of the
// SVG uses literal hex already (seal-zone amber, bleed red, reference greys).
const CSS_TOKENS = ['--cut', '--crease', '--ink', '--ink-2', '--ink-3', '--muted', '--mono', '--sans'];

/** Replace every var(--token) with its computed literal value. Font families
 *  carry double quotes ("DM Mono",…) that would break the double-quoted SVG
 *  attribute they sit in, so those get re-quoted single. */
function inlineTokens(markup){
  const cs = getComputedStyle(document.documentElement);
  let out = markup;
  for(const tok of CSS_TOKENS){
    let val = cs.getPropertyValue(tok).trim();
    if(!val) continue;
    if(val.includes('"')) val = val.replace(/"/g, "'");
    out = out.split(`var(${tok})`).join(val);
  }
  return out;
}

/** Trigger a browser download of a data/blob URL. */
export function savePNG(url, filename){
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
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
