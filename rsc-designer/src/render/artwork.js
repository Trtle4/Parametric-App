/**
 * Artwork round-trip — the shared, style-agnostic upload/map system. ONE
 * mechanism feeds every level (wrap, cartons); the per-style panel data comes
 * from `geo.meta.artMap` (owned by each style, derived from the same yB/bands
 * the 2D view and template already use), so the template, the 2D overlay and
 * the 3D UVs can never disagree about where a panel is.
 *
 * The correctness idea: the designer paints on the exact template canvas, so
 * "the art" is simply an image laid over the blank (0..canvas.w × 0..canvas.h,
 * mm). The fit controls are only a safety valve for an upload that isn't
 * exactly template-sized; with a template-sized file the defaults map 1:1 and
 * nothing is touched.
 *
 * Browser-side only (canvas/texture, no server) — runs on GitHub Pages.
 */

// longest edge kept when downscaling an upload for STORAGE + preview. This app
// previews and registers art; it is not the RIP — the print house uses the
// designer's full-res original. 1400px is crisp on screen and 3D while keeping
// the data URL small enough not to bloat the save file (reported to the user).
const MAX_EDGE = 1400;

/** Default fit state for a fresh upload: `stretch` fills the blank exactly, so
 *  a template-sized file lands 1:1. dx/dy are mm nudges; scale is a multiplier. */
export function defaultFit(){ return {fit: 'stretch', dx: 0, dy: 0, scale: 1}; }

/**
 * Read an uploaded image file, downscale to <= MAX_EDGE on the long edge, and
 * return a compact record to store on the project. JPEG (small) unless the
 * source is a PNG (kept PNG to preserve any transparency the designer used).
 * @returns {Promise<{src:string, natW:number, natH:number, bytes:number}>}
 */
export function loadArtworkFile(file){
  return new Promise((resolve, reject) => {
    const rdr = new FileReader();
    rdr.onerror = () => reject(rdr.error || new Error('could not read file'));
    rdr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a readable image'));
      img.onload = () => {
        const natW = img.naturalWidth, natH = img.naturalHeight;
        const k = Math.min(1, MAX_EDGE/Math.max(natW, natH));
        const w = Math.max(1, Math.round(natW*k)), h = Math.max(1, Math.round(natH*k));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const png = /png$/i.test(file.type);
        const src = c.toDataURL(png ? 'image/png' : 'image/jpeg', png ? undefined : 0.85);
        resolve({src, natW, natH, bytes: Math.round(src.length*0.75)});   // base64 → ~3/4 bytes
      };
      img.src = rdr.result;
    };
    rdr.readAsDataURL(file);
  });
}

/**
 * The art's placement rectangle in blank-canvas mm coords (origin bottom-left,
 * matching artMap's v-up convention). `fit`/`scale`/`dx`/`dy` combine into one
 * rect + an SVG preserveAspectRatio; every consumer (2D overlay, 3D compose)
 * reads placement from HERE so they line up.
 * @returns {{x:number,y:number,w:number,h:number,par:string}}
 */
export function artRect(art, canvasW, canvasH){
  const s = (art.scale > 0 ? art.scale : 1);
  const w = canvasW*s, h = canvasH*s;
  const x = (canvasW - w)/2 + (art.dx || 0);
  const y = (canvasH - h)/2 + (art.dy || 0);
  const par = art.fit === 'fit' ? 'xMidYMid meet'
            : art.fit === 'fill' ? 'xMidYMid slice'
            : 'none';                               // 'stretch' (default, 1:1)
  return {x, y, w, h, par};
}

/**
 * SVG fragment placing the art over the blank for the 2D dieline. `fx`/`fy`
 * map blank-mm → svg coords (draw2d passes its own). Clipped to the blank rect
 * so overflow (fill/slice, scale > 1, nudge) never spills past the cut.
 */
export function artImageSVG(art, canvasW, canvasH, fx, fy, clipId){
  const r = artRect(art, canvasW, canvasH);
  // rect in svg space: top-left is (r.x, r.y + r.h) in world (y-up) → fy flips
  const sx = fx(r.x), sy = fy(r.y + r.h), sw = fx(r.x + r.w) - fx(r.x), sh = fy(r.y) - fy(r.y + r.h);
  const cx = fx(0), cy = fy(canvasH), cw = fx(canvasW) - fx(0), ch = fy(0) - fy(canvasH);
  return `<clipPath id="${clipId}"><rect x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}"/></clipPath>` +
    `<image clip-path="url(#${clipId})" x="${sx.toFixed(2)}" y="${sy.toFixed(2)}" width="${sw.toFixed(2)}" height="${sh.toFixed(2)}" ` +
    `preserveAspectRatio="${r.par}" href="${art.src}" opacity="0.96"/>`;
}

/**
 * Compose the art onto an offscreen canvas the size of the template (canvas.w ×
 * canvas.h mm, rasterised at `px` per long edge), in the SAME placement the 2D
 * overlay uses. This canvas IS the texture the 3D UVs sample, so 2D and 3D show
 * one picture. Canvas y is top-down; the caller's UVs use artMap v (bottom-up)
 * and THREE's default flipY, which cancels out. Returns null until the image
 * has decoded (caller re-runs on the returned Image's load).
 */
export function composeArtCanvas(artMap, art, imgEl, px){
  if(!imgEl || !imgEl.complete || !imgEl.naturalWidth) return null;
  const CW = artMap.canvas.w, CH = artMap.canvas.h;
  const k = (px || 1400)/Math.max(CW, CH);
  const cw = Math.max(1, Math.round(CW*k)), ch = Math.max(1, Math.round(CH*k));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);              // seals/bleed backing
  const r = artRect(art, CW, CH);                                 // blank-mm, y-up
  // to canvas px (y-down): top of rect is world y = r.y + r.h
  const dx = r.x*k, dw = r.w*k, dh = r.h*k, dy = (CH - (r.y + r.h))*k;
  g.imageSmoothingQuality = 'high';
  if(art.fit === 'none' || !art.fit){
    g.drawImage(imgEl, dx, dy, dw, dh);                           // stretch
  }else{
    // meet (contain) / slice (cover): fit source aspect into the dest rect
    const ir = imgEl.naturalWidth/imgEl.naturalHeight, dr = dw/dh;
    let sw = imgEl.naturalWidth, sh = imgEl.naturalHeight, sx = 0, sy = 0;
    let ddx = dx, ddy = dy, ddw = dw, ddh = dh;
    if(art.fit === 'fill'){                                       // cover: crop source
      if(ir > dr){ sw = sh*dr; sx = (imgEl.naturalWidth - sw)/2; }
      else       { sh = sw/dr; sy = (imgEl.naturalHeight - sh)/2; }
      g.drawImage(imgEl, sx, sy, sw, sh, ddx, ddy, ddw, ddh);
    }else{                                                        // fit: letterbox dest
      if(ir > dr){ ddh = dw/ir; ddy = dy + (dh - ddh)/2; }
      else       { ddw = dh*ir; ddx = dx + (dw - ddw)/2; }
      g.drawImage(imgEl, ddx, ddy, ddw, ddh);
    }
  }
  return c;
}

/** An HTMLImageElement for a stored art src, cached per src so re-renders don't
 *  re-decode. `onReady` fires (once decoded) so the caller can re-render. */
const imgCache = new Map();
export function artImage(src, onReady){
  let img = imgCache.get(src);
  if(img) return img;
  img = new Image();
  img.onload = () => { if(onReady) onReady(); };
  img.src = src;
  imgCache.set(src, img);
  return img;
}
