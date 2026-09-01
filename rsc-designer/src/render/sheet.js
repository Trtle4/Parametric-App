/**
 * Capture sheets — deterministic camera → offscreen render → composed sheet.
 *
 * A GENERAL PRIMITIVE. Nothing here knows what a perforation is, what an
 * exploded view is, or that a shelf can hold two designs: it takes a list of
 * SCENE DESCRIPTORS, each of which knows how to make itself the current
 * scene, and composes their captures into one image with captions. The next
 * caller needs a descriptor and nothing else — the same contract the `aux`
 * layer hook keeps.
 *
 * DETERMINISM IS THE POINT. Same descriptors in, byte-identical image out —
 * across runs, viewport sizes, active tabs, and whatever was rendered before.
 * A sheet that varies with the window is a screenshot, not a capture. So:
 *
 *   · every dimension is a fixed pixel number, never read from a layout;
 *   · the camera comes from a NAMED entry resolved to exact orbit numbers,
 *     never from wherever the user last dragged the live view;
 *   · the pivot is BLANKED before each scene, so a capture can only contain
 *     what that scene turned on — the pivot holds every view's group at once
 *     and an unscoped capture picks up another tab's leftovers (measured: it
 *     did exactly that to two pins in the perforation work);
 *   · fonts are awaited, because a caption rasterised before its webfont
 *     arrives is a different pixel run from the same caption after it.
 *
 * CAPTIONS ARE RASTERISED INTO THE IMAGE. They never become PDF text, so
 * they never touch the WinAnsi encoding and transliteration in
 * export/palletpdf.js — canvas 2D draws Unicode directly. That is the whole
 * reason the sheet is ONE image: the PDF pipeline embeds it as a single
 * DCTDecode XObject, exactly like the three captures it already takes.
 */
import {captureOrbitPNG, setStageBackground, getStageBackground, getPivot, getOrbit,
        setCamSpan, getCamSpan, HOME_ORBIT} from './fold3d.js';

/**
 * NAMED CAMERAS, resolved to exact orbit parameters.
 *
 * `dist` is a MULTIPLIER on the scene's own span (fold3d frames at
 * span·2.4·dist), so one name frames a carton and a pallet alike. `fov` of 0
 * means the renderer's normal lens; a small number is a long lens, which
 * compresses perspective toward the orthographic projection a plan view is
 * supposed to be (see the pallet PDF's plan view).
 *
 * `home` SPREADS fold3d's HOME_ORBIT rather than restating it, so the angles
 * the app resets to and the angles a sheet uses are one source. The DISTANCE
 * is the sheet's own: on screen the app frames loosely because the user is
 * about to orbit, and a sheet cell wants the subject filling it. Until now
 * that distance lived at each call site — 1.35 here, 0.85 there — so "its own
 * home orbit" meant a different framing depending on who asked.
 */
export const SHEET_CAMERAS = Object.freeze({
  home:  {...HOME_ORBIT, dist: 1.02, fov: 0},
  hero:  {rotX: 0.42, rotY: 0.72, dist: 0.95, fov: 0},
  front: {rotX: 0, rotY: 0, dist: 0.98, fov: 0},
  right: {rotX: 0, rotY: Math.PI/2, dist: 0.98, fov: 0},
  plan:  {rotX: Math.PI/2, rotY: 0, dist: 0.92, fov: 2.2}
});

/** Sheet defaults, in device pixels. Every one of them is a constant: a
 *  dimension that followed the viewport would make the output a screenshot. */
/** The computed value of a :root design token, or a literal fallback when
 *  there is no document to read (a headless harness, a worker). */
function readToken(name, fallback){
  try{
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }catch(e){ return fallback; }
}

export const SHEET_DEFAULTS = Object.freeze({
  cell: {w: 660, h: 460},
  gap: 18,
  margin: 26,
  headerH: 78,
  captionH: 34,
  footerH: 30,
  background: '#ffffff',
  ink: '#192227',
  ink2: '#59656C',
  ink3: '#8A959B',
  line: '#D2D9DE',
  // The sheet is EXPORT, so it is monospace by the app's own type rule --
  // but a canvas `ctx.font` cannot take a CSS var, so this reads the live
  // --mono token at module load with a literal fallback. Written as a read
  // rather than a copy because a hardcoded family here would be a second
  // definition of a fact index.html owns, and would silently keep rendering
  // the old face after a token change (which is exactly what a stale copy in
  // export/png.js did once already).
  font: readToken('--mono', '"IBM Plex Mono", ui-monospace, monospace'),
  quality: 0.92
});

/** A camera by name, or a literal override. Throws on an unknown name: a
 *  silent fallback would make one sheet frame differently from the next and
 *  look like a rendering bug. */
export function cameraByName(cam){
  if(cam && typeof cam === 'object') return {...SHEET_CAMERAS.home, ...cam};
  const name = cam || 'home';
  const c = SHEET_CAMERAS[name];
  if(!c) throw new Error(`[sheet] unknown camera "${name}" — add it to SHEET_CAMERAS`);
  return {...c};
}

/* --------------------------------------------------------------- layout --- */

/**
 * Place cells on a grid of `cols` columns. A scene may span `w` columns and
 * `h` rows, so the arrangement need not be regular; placement is first-fit,
 * left to right and top to bottom, which is deterministic for a given list.
 * @returns {{cells: Array, cols: number, rows: number}}
 */
export function layoutGrid(scenes, cols){
  const occupied = new Set();
  const key = (r, c) => `${r},${c}`;
  const cells = [];
  let rows = 0;
  for(const s of scenes){
    const w = Math.max(1, Math.min(cols, Math.round(s.w || 1)));
    const h = Math.max(1, Math.round(s.h || 1));
    let placed = null;
    for(let r = 0; r < rows + h + 1 && !placed; r++){
      for(let c = 0; c + w <= cols && !placed; c++){
        let free = true;
        for(let dr = 0; dr < h && free; dr++)
          for(let dc = 0; dc < w && free; dc++)
            if(occupied.has(key(r + dr, c + dc))) free = false;
        if(free) placed = {r, c, w, h};
      }
    }
    for(let dr = 0; dr < placed.h; dr++)
      for(let dc = 0; dc < placed.w; dc++) occupied.add(key(placed.r + dr, placed.c + dc));
    rows = Math.max(rows, placed.r + placed.h);
    cells.push(placed);
  }
  return {cells, cols, rows};
}

/* -------------------------------------------------------------- capture --- */

/**
 * Blank the pivot, run `show`, capture, and put the visibility back.
 *
 * The blanking is the scoping: the pivot holds the fold group, the hierarchy
 * group, every shelf bay and the artwork group at once, toggling visibility
 * rather than rebuilding. A capture that did not blank first would contain
 * whichever of those the last view left on.
 */
/**
 * The largest dimension of everything VISIBLE under the pivot, in world units.
 *
 * The framing distance is a multiple of the scene's span, and the span used
 * to be whichever number the last builder happened to leave behind — so the
 * same descriptors composed a different sheet depending on which tab was open
 * before. Measured: switching to the shelf changed the output. Deriving it
 * from the scene makes the framing a function of the scene, which is what
 * determinism actually requires.
 *
 * `traverseVisible` skips invisible subtrees, so this measures exactly what
 * the capture will contain. InstancedMesh is expanded per instance: its
 * geometry bounds describe ONE unit, and a pallet of 48 instanced cases would
 * otherwise measure as one case.
 */
export function visibleSpan(pivot){
  if(!pivot) return 0;
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().makeEmpty();
  const tmp = new THREE.Box3(), m = new THREE.Matrix4();
  pivot.traverseVisible(o => {
    const g = o.geometry;
    if(!g || !(o.isMesh || o.isLine || o.isLineSegments || o.isPoints)) return;
    if(!g.boundingBox) g.computeBoundingBox();
    if(!g.boundingBox) return;
    if(o.isInstancedMesh && o.instanceMatrix){
      for(let i = 0; i < o.count; i++){
        o.getMatrixAt(i, m);
        m.premultiply(o.matrixWorld);
        box.union(tmp.copy(g.boundingBox).applyMatrix4(m));
      }
    }else{
      box.union(tmp.copy(g.boundingBox).applyMatrix4(o.matrixWorld));
    }
  });
  if(box.isEmpty()) return 0;
  const s = new THREE.Vector3();
  box.getSize(s);
  return Math.max(s.x, s.y, s.z);
}

function captureScene(scene, cam, w, h, quality){
  const pivot = getPivot();
  if(!pivot) return null;
  const was = pivot.children.map(o => o.visible);
  const wasSpan = getCamSpan();
  pivot.children.forEach(o => { o.visible = false; });
  try{
    scene.show();
    const span = visibleSpan(pivot);
    if(span > 0) setCamSpan(span);
    return captureOrbitPNG(cam.rotX, cam.rotY, cam.dist, w, h, quality, cam.fov || 0);
  } finally {
    pivot.children.forEach((o, i) => { if(i < was.length) o.visible = was[i]; });
    setCamSpan(wasSpan);
  }
}

/* ------------------------------------------------------------- composing --- */

const loadImage = src => new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => res(im);
  im.onerror = () => rej(new Error('[sheet] a capture failed to decode'));
  im.src = src;
});

/**
 * Compose a capture sheet.
 *
 * @param {Object} spec
 *   scenes:    [{show: () => void, caption?: string, camera?: string|Object,
 *                w?: number, h?: number}]   — `show` makes this scene current
 *   captions:  optional parallel array; a count mismatch THROWS
 *   title, subtitle, footer: sheet chrome, all optional
 *   grid:      {cols} — defaults to a near-square arrangement
 *   cell:      {w, h} in device pixels
 *   onRestore: run in a `finally`, for a caller that changed state to show a scene
 * @returns {Promise<{canvas, width, height, png, jpeg}>}
 *   `png()` is a data URL for saving; `jpeg()` returns {data, w, h} — exactly
 *   the record export/palletpdf.js embeds, so a sheet drops into a document
 *   with no second path.
 */
export async function composeSheet(spec){
  const S = {...SHEET_DEFAULTS, ...spec};
  const scenes = spec.scenes || [];
  if(!scenes.length) throw new Error('[sheet] no scenes to compose');
  // A SHEET WITH CAPTIONS ON THE WRONG SCENES is the failure that survives
  // review, because every caption is plausible somewhere. Refuse the pairing
  // rather than zip two lists of different length.
  if(spec.captions && spec.captions.length !== scenes.length)
    throw new Error(`[sheet] ${scenes.length} scenes but ${spec.captions.length} captions`);
  const caption = i => (spec.captions ? spec.captions[i] : scenes[i].caption) || '';

  const cols = Math.max(1, Math.round((spec.grid && spec.grid.cols) || Math.ceil(Math.sqrt(scenes.length))));
  const {cells, rows} = layoutGrid(scenes, cols);
  const cw = S.cell.w, ch = S.cell.h, gap = S.gap, m = S.margin;
  const capH = spec.captions || scenes.some(s => s.caption) ? S.captionH : 0;
  const headH = (S.title || S.subtitle) ? S.headerH : 0;
  const footH = S.footer ? S.footerH : 0;
  const width = m*2 + cols*cw + (cols - 1)*gap;
  const height = m*2 + headH + rows*(ch + capH) + (rows - 1)*gap + footH;

  // capture first, compose second: every capture runs against a blanked pivot
  const shots = [];
  const prevBg = getStageBackground();          // restore what the user chose, not a default
  setStageBackground('white');
  try{
    for(const s of scenes) shots.push(captureScene(s, cameraByName(s.camera), cw, ch, S.quality));
  } finally {
    setStageBackground(prevBg);
    if(spec.onRestore) spec.onRestore();
  }
  if(shots.some(u => !u)) throw new Error('[sheet] a scene captured nothing — is the 3D view initialised?');

  // a caption rasterised before its webfont lands is a different pixel run
  if(document.fonts && document.fonts.ready) await document.fonts.ready;
  const imgs = await Promise.all(shots.map(loadImage));

  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const g = cv.getContext('2d');
  g.fillStyle = S.background; g.fillRect(0, 0, width, height);

  let y = m;
  if(headH){
    if(S.title){
      g.fillStyle = S.ink; g.font = `600 26px ${S.font}`; g.textBaseline = 'alphabetic';
      g.fillText(S.title, m, y + 26);
    }
    if(S.subtitle){
      g.fillStyle = S.ink2; g.font = `13px ${S.font}`;
      g.fillText(S.subtitle, m, y + 50);
    }
    g.strokeStyle = S.line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(m, y + headH - 12.5); g.lineTo(width - m, y + headH - 12.5); g.stroke();
    y += headH;
  }

  cells.forEach((cell, i) => {
    const x = m + cell.c*(cw + gap);
    const cy = y + cell.r*(ch + capH + gap);
    const w = cell.w*cw + (cell.w - 1)*gap, h = cell.h*ch + (cell.h - 1)*(capH + gap);
    g.drawImage(imgs[i], x, cy, w, h);
    g.strokeStyle = S.line; g.lineWidth = 1;
    g.strokeRect(x + 0.5, cy + 0.5, w - 1, h - 1);
    if(capH){
      g.fillStyle = S.ink2; g.font = `13px ${S.font}`; g.textBaseline = 'alphabetic';
      g.fillText(caption(i), x, cy + h + 20);
    }
  });

  if(footH){
    g.fillStyle = S.ink3; g.font = `11px ${S.font}`;
    g.fillText(S.footer, m, height - m + 8);
  }

  return {
    canvas: cv, width, height,
    png: () => cv.toDataURL('image/png'),
    // the shape export/palletpdf.js already embeds: a JPEG data URL and its
    // pixel size, so a sheet needs no second path into a document
    jpeg: (q = S.quality) => ({data: cv.toDataURL('image/jpeg', q), w: width, h: height})
  };
}

/** Download a composed sheet as a PNG. */
export function saveSheet(sheet, filename){
  const a = document.createElement('a');
  a.href = sheet.png();
  a.download = filename;
  a.click();
}

/** The live orbit, for a caller that wants to prove it was left alone. */
export const liveOrbit = () => getOrbit();
