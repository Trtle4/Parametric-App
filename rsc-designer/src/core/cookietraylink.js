/**
 * Cookie-Tray share-link round trip.
 *
 * Cookie-Tray's web app keeps its whole configuration in the querystring
 * (`?n=4&cl=219&ch=30&cr=24&qty=72&ncp=4`) so a link reconstructs a build on
 * any device with no backend. This module speaks that same querystring, in
 * both directions:
 *
 *   IMPORT  a pasted link  -> tray overrides + cell count for this project
 *   EXPORT  this project   -> a link that opens the equivalent tray over
 *                             there, where the full solid, STEP and AR live
 *
 * LINKED, NOT RELIANT. Nothing in the chain needs a link to have been used;
 * this is a convenience at the edges. The app is fully usable with the link
 * features never touched.
 *
 * Key maps mirror Cookie-Tray's own `web/src/urlState.js` (same short keys,
 * same string fields, numbers trimmed to at most 4 decimals). Their
 * omit-if-equal-to-default convention is deliberately NOT mirrored on export:
 * over there an absent cell dimension means AUTO (re-derive from the product),
 * not "the default", so omitting a value that merely collides with a default
 * changes the tray. See buildTrayLink.
 *
 * DOM-free, mm-only, pure.
 */
import {TRAY_DEFAULTS, packPitchOf} from './cookietray.js';
import {resolvePieceOrientation} from './collation.js';

/** Long name -> Cookie-Tray's compact querystring key (their TRAY_KEY_MAP). */
export const TRAY_KEYS = Object.freeze({
  nCells: 'n', nCols: 'nc', longAxis: 'la', cellLen: 'cl', cellWid: 'cw', cellH: 'ch',
  cradleR: 'cr', wall: 'w', divider: 'dv', floor: 'fl', cornerR: 'cnr',
  draftDeg: 'dr', stripL: 'sl', stripW: 'sw', lipH: 'lh', flangeT: 'ft',
  cellFillet: 'cf', nozzle: 'nz'
});

/**
 * The 2D GRID key, held OUTSIDE both maps above (unlike every other field it
 * is not one scalar — see parseTrayLink/buildTrayLink for its shape). THIS
 * KEY IS THIS APP'S OWN EXTENSION, not a confirmed Cookie-Tray field: the
 * real Cookie-Tray source was not reachable while this was built (repo
 * access was requested and refused twice), so its actual grid/row encoding,
 * if any, is unverified. Consequences of that, by design:
 *   - A real Cookie-Tray link never sends this key, so importing one is
 *     completely unaffected — it always resolves to the legacy single row
 *     via the ordinary TRAY_KEYS, exactly as before this field existed.
 *   - Opening a link THIS APP exported with more than one row, on the real
 *     Cookie-Tray site, degrades to that site's own reading of the legacy
 *     keys — row 0's own cell geometry is real and correct on its own. The
 *     quantity fields (`qty`/`ncp`) still state the FULL grid's totals (the
 *     count is genuinely useful information even where the geometry is
 *     partial), so a per-cell count THEIR site derives from qty/ncp will not
 *     match a row-0-only rebuild — an opened multi-row link there is a shape
 *     reference for row 0, not an exact single-row equivalent.
 *   - This app's own round trip (export, then re-import here) IS lossless,
 *     because both sides agree on this key's shape by construction, and this
 *     app reads perCell from the true grid total (see applyTrayLink), never
 *     from qty/ncp divided by row 0's count alone.
 * A genuine confirmed Cookie-Tray grid key, once seen, replaces this rather
 * than living alongside it as a second, competing encoding.
 */
const ROWS_KEY = 'rw';

/** Their PRODUCT_KEY_MAP, for the product half of the link, plus ONE field
 *  this app adds: `orientation` ('ori'). Also UNVERIFIED against the real
 *  Cookie-Tray source for the same reason as ROWS_KEY above — round-only in
 *  effect (see buildTrayLink/applyTrayLink; a box has no analogous choice,
 *  see collation.js's resolvePieceOrientation doc), and absent on any real
 *  Cookie-Tray link, so a real link still imports exactly as before this
 *  field existed (defaulting to 'on-edge', today's only prior behaviour). */
export const PRODUCT_KEYS = Object.freeze({
  productType: 'pty', cookieDiameter: 'pdia', cookieThickness: 'pthk',
  productWidth: 'pw', productHeight: 'ph', productThickness: 'ptk',
  edgeRTop: 'ert', edgeRBot: 'erb', qtyTotal: 'qty',
  distributeBy: 'dby', nCellsProduct: 'ncp', cookiesPerCell: 'cpc',
  orientation: 'ori'
});

const STRING_FIELDS = new Set(['longAxis', 'productType', 'distributeBy', 'orientation']);

/** Their PRODUCT_DEFAULTS, verbatim. LIVE on import (parseTrayLink fills every
 *  absent product key from this table, mirroring exactly what Cookie-Tray's
 *  own encoder omits and what its app would therefore resolve the field to)
 *  — no longer used to omit anything on export (see buildTrayLink), which is
 *  a genuinely different question: over there, an absent PRODUCT key means
 *  "their static default" (this table), but an absent TRAY/cell key means
 *  AUTO (re-derive from the product), which is why buildTrayLink states every
 *  tray value and never consults this table for that half. */
export const PRODUCT_DEFAULTS = Object.freeze({
  productType: 'round', cookieDiameter: 45, cookieThickness: 12,
  productWidth: 45, productHeight: 20, productThickness: 12,
  edgeRTop: 2, edgeRBot: 2, qtyTotal: 24,
  distributeBy: 'nCells', nCellsProduct: 3, cookiesPerCell: 8,
  // 'on-edge' (roll, rolled up the channel) is every tray this app built
  // before this field existed — see ROWS_KEY's doc on this being an
  // unverified extension, and cookietray.js packPitchOf's doc on what the
  // two values physically mean.
  orientation: 'on-edge'
});

/** Our OWN link-schema version, stamped on export (see buildTrayLink) and
 *  checked on import. Cookie-Tray's own encoder never sends this key at all
 *  — it is ours alone, so we can tell OUR OWN future exports apart from
 *  today's if this schema ever changes, and fail loudly on a link from a
 *  newer version rather than silently misinterpret a key whose meaning
 *  moved. We cannot migrate the other side (Cookie-Tray's own links never
 *  carry it), so an absent `v` is treated as v1 — the version this schema
 *  has always been — never as an error. */
export const CURRENT_LINK_VERSION = 1;

/** At most 4 decimals, no trailing zeros — their fmtNum. */
const fmtNum = n => Number(n.toFixed(4)).toString();

/** Accept a full URL, a bare querystring, or a `?`-prefixed one. */
function toParams(input){
  const s = String(input || '').trim();
  if(!s) return new URLSearchParams();
  const q = s.indexOf('?');
  if(/^https?:/i.test(s)) return new URLSearchParams(q >= 0 ? s.slice(q + 1) : '');
  return new URLSearchParams(s.replace(/^[?#]/, ''));
}

/**
 * Parse a Cookie-Tray link into this project's terms.
 *
 * IMPORTANT — imported values are PINNED, not auto, on BOTH halves, but for
 * two different reasons:
 *
 *   TRAY half: Cookie-Tray omits any cell/shell value equal to its default,
 *   so an absent `cl` there means "their default cell length", NOT "derive
 *   it from my product". Treating absences as auto would silently reproduce
 *   a DIFFERENT tray than the link describes, so every tray dimension the
 *   link determines (present, or their default) comes back as an explicit
 *   override. Reset any field to auto afterwards to hand it back to this
 *   app's product-driven derivation. Do NOT change this: it is a deliberate
 *   asymmetry with the product half below, not an oversight.
 *
 *   PRODUCT half: the same omit-if-default encoding applies (Cookie-Tray's
 *   encodeGroup has one rule for the whole payload), but there is no "auto"
 *   concept for a product's own dimensions to fall back to — PRODUCT_DEFAULTS
 *   IS what an absent key means, full stop. Every product key is filled from
 *   PRODUCT_DEFAULTS below so the returned `product` is never sparse:
 *   downstream code must never see `undefined` here and must never invent
 *   its own fallback for an absent key (that was the bug — a default-
 *   thickness product importing as some unrelated caller-side magic number).
 *
 * @param {string} input a share URL or querystring
 * @returns {{nCells: number, params: Object, product: Object, rows: Object[]|null,
 *   keysFound: string[], unknownKeys: string[]}|null}
 *   null when the string carries no Cookie-Tray keys at all. `rows` is this
 *   app's own 2D-grid extension (see ROWS_KEY) — null unless the link carries
 *   a valid `rw`, which no real Cookie-Tray link does, so this is null for
 *   every real link and every link from before the grid existed. `unknownKeys`
 *   names every querystring key that matched neither TRAY_KEYS nor
 *   PRODUCT_KEYS (nor our own `v`/`rw` stamps) — Cookie-Tray may have added a
 *   field since this module was last updated. Surfaced, never silently
 *   dropped: a link this app only partly understands is still useful, and
 *   the caller (app.js's applyTrayLink) shows this list through the same
 *   note the import status already uses, rather than failing the import.
 * @throws {Error} if the link's own `v` (our schema version, absent = v1)
 *   is newer than this app understands — fail loudly rather than silently
 *   misparse a key whose meaning moved in a schema we don't know yet.
 */
export function parseTrayLink(input){
  const sp = toParams(input);
  const keysFound = [];
  const params = {};
  for(const [long, short] of Object.entries(TRAY_KEYS)){
    if(sp.has(short)) keysFound.push(short);
    const raw = sp.get(short);
    if(STRING_FIELDS.has(long)){
      params[long] = raw != null && raw !== '' ? raw : TRAY_DEFAULTS[long];
    }else{
      const v = raw != null && raw !== '' ? parseFloat(raw) : NaN;
      // absent -> their default, which for cradleR/divider is null (derive)
      params[long] = Number.isFinite(v) ? v : TRAY_DEFAULTS[long];
    }
  }
  const product = {};
  for(const [long, short] of Object.entries(PRODUCT_KEYS)){
    if(sp.has(short)) keysFound.push(short);
    const raw = sp.get(short);
    if(STRING_FIELDS.has(long)){
      product[long] = raw != null && raw !== '' ? raw : PRODUCT_DEFAULTS[long];
    }else{
      const v = raw != null && raw !== '' ? parseFloat(raw) : NaN;
      // absent -> Cookie-Tray's own static default for this product field —
      // never left undefined for a caller to guess at.
      product[long] = Number.isFinite(v) ? v : PRODUCT_DEFAULTS[long];
    }
  }

  // ROWS (ROWS_KEY) — this app's own 2D-grid extension, so it gets its own
  // lenient parse rather than the throw-on-malformed the `v` stamp uses:
  // a real Cookie-Tray link never sends this key at all, and a corrupted or
  // hand-edited one should degrade to "no grid" (the legacy single row from
  // the fields above), not fail the whole import.
  let rows = null;
  if(sp.has(ROWS_KEY)){
    keysFound.push(ROWS_KEY);
    try{
      const raw = JSON.parse(sp.get(ROWS_KEY));
      if(Array.isArray(raw) && raw.length){
        const parsed = raw.map(r => ({
          nCells: Math.max(1, Math.round(Number(r.n))),
          cellLen: Number(r.cl), cellWid: Number(r.cw), cellH: Number(r.ch), cradleR: Number(r.cr)
        }));
        if(parsed.every(r => Object.values(r).every(Number.isFinite))) rows = parsed;
      }
    }catch{ /* malformed rw -> no grid, not a failed import */ }
  }

  if(keysFound.length === 0) return null;          // not a Cookie-Tray link

  // UNKNOWN KEYS: every querystring key that matched NEITHER map above, and
  // isn't one of our own `v`/`rw` stamps. THE CLASS FIX, not just this one
  // dropped field: any key Cookie-Tray adds after this module is last
  // updated would otherwise be silently dropped and silently never
  // re-emitted on export, exactly the nCols defect this same fix landed
  // alongside. Deduped (a querystring can repeat a key).
  const known = new Set([...Object.values(TRAY_KEYS), ...Object.values(PRODUCT_KEYS), 'v', ROWS_KEY]);
  const unknownKeys = [...new Set(sp.keys())].filter(k => !known.has(k));

  // OUR OWN version stamp (see CURRENT_LINK_VERSION) — absent means v1, the
  // version this schema has always been, since Cookie-Tray's real links
  // never send it. Only a link claiming a version NEWER than we understand
  // is refused; this cannot fire against a real Cookie-Tray link or any
  // link this app itself has ever exported, only against a future export
  // from a schema change not yet made.
  const vRaw = sp.get('v');
  const linkVersion = vRaw != null && vRaw !== '' ? parseInt(vRaw, 10) : 1;
  if(Number.isFinite(linkVersion) && linkVersion > CURRENT_LINK_VERSION)
    throw new Error(`This link uses a newer tray-link format (v${linkVersion}) than this app understands (v${CURRENT_LINK_VERSION}) — update the app to open it.`);

  const nCells = Math.max(1, Math.round(params.nCells || TRAY_DEFAULTS.nCells));
  delete params.nCells;                             // the cell count is its own field
  // nCols stays IN params, unlike nCells: it drives nothing in this port's
  // 1xN geometry (see cookietray.js's TRAY_DEFAULTS comment), so there is no
  // second top-level field for it to become — it just rides through
  // trayParams() untouched, present so the round trip is lossless.
  // null overrides mean "let the tray stage derive it" — drop them so the
  // auto-with-override contract (absent key = auto) is preserved. Product
  // fields never carry this shape (every PRODUCT_DEFAULTS entry is a real
  // value or a defaulted string), so no equivalent pass runs over `product`.
  for(const k of Object.keys(params)) if(params[k] == null) delete params[k];
  return {nCells, params, product, rows, keysFound, unknownKeys};
}

/**
 * Build a Cookie-Tray share link from this project's tray.
 *
 * Emits every resolved value, so the tray that opens over there is the tray
 * on screen here regardless of which defaults either side happens to hold.
 * The product half is filled from the collation so their inverse calculator
 * agrees about the product too.
 *
 * @param {Object} project
 * @param {Object} trayResult  the chain's solved tray (row.tray)
 * @param {string} [base='https://trtle4.github.io/Cookie-Tray/']
 * @returns {string|null} null when there is no tray to describe
 */
export function buildTrayLink(project, trayResult, base = 'https://trtle4.github.io/Cookie-Tray/'){
  if(!trayResult || !trayResult.params) return null;
  const p = trayResult.params;
  const out = new URLSearchParams();
  // OUR OWN schema version (see CURRENT_LINK_VERSION) — Cookie-Tray's own
  // site ignores unrecognized querystring keys, so this rides along
  // harmlessly when the link is opened there; it only matters when a link
  // WE exported is later pasted back into US (parseTrayLink checks it).
  out.set('v', String(CURRENT_LINK_VERSION));

  // STATE EVERY VALUE. This used to omit anything equal to Cookie-Tray's own
  // static default, mirroring their encoder — and that is wrong, because over
  // there ABSENT does not mean "the default". For the cell dimensions absent
  // means AUTO: their app re-derives them from the product spec. So a value of
  // ours that happens to collide with their default vanished from the link and
  // came back as whatever their derivation produced.
  //
  // Measured against the deployed Cookie-Tray build: a 44mm product with our
  // sideClearance 2 gives cellWid 48 — exactly their default — so `cw` was
  // dropped, and they re-derived 44 + 2*1.5 = 47 using THEIR clearance. The
  // tray came back 3mm narrower (footprint 167 vs 170) from a link that
  // claimed to describe ours.
  //
  // It cannot be fixed by sending clearance instead: their URL key maps carry
  // no sideClearance/endClearance/cradleClearance at all (they are function
  // arguments of the derive, defaulting 1.5/3/0). Stating the resolved
  // dimensions IS the only channel through which a non-default clearance can
  // survive the trip — which is what makes this load-bearing rather than tidy.
  //
  // The link is longer for it. That is the correct trade: it now says what the
  // tray IS, instead of relying on two default tables agreeing forever.
  const put = (long, keyMap, value) => {
    if(value === null || value === undefined || value === '') return;
    const short = keyMap[long];
    if(STRING_FIELDS.has(long)){ out.set(short, value); return; }
    const num = typeof value === 'number' ? value : parseFloat(value);
    if(!Number.isFinite(num)) return;
    out.set(short, fmtNum(num));
  };

  // the tray half — the RESOLVED values (what this project actually built),
  // so the link describes the tray on screen, not a partial override set.
  // These legacy scalar keys always describe ROW 0 (trayParams()'s own
  // single-row mirrors) — the ONLY row when there is one, and still a real,
  // valid single-row tray when there are more (see ROWS_KEY's doc: a tool
  // reading only these keys degrades to row 0, not to something wrong).
  put('nCells', TRAY_KEYS, p.rows[0].nCells);
  for(const long of ['nCols', 'longAxis', 'cellLen', 'cellWid', 'cellH', 'cradleR', 'wall', 'divider',
                     'floor', 'cornerR', 'draftDeg', 'stripL', 'stripW', 'lipH', 'flangeT',
                     'cellFillet', 'nozzle'])
    put(long, TRAY_KEYS, p[long]);

  // THE FULL GRID (our own extension — see ROWS_KEY's doc). Only sent when
  // there is more than one row: a single-row tray already round-trips
  // completely through the legacy keys above, so this stays absent for
  // every tray built before rows existed, and the link is no longer than
  // it needs to be.
  // Reads p.rows (trayParams()'s own FULLY RESOLVED rows), never
  // trayResult.rows directly — solveTrayStage's own row list can still
  // carry a null cradleR (meaning "let trayParams derive cellWid/2", the
  // same convention the single-row path uses), and this link must state
  // real numbers throughout, same as every other tray value here.
  if(p.rows && p.rows.length > 1){
    out.set(ROWS_KEY, JSON.stringify(p.rows.map(r =>
      ({n: r.nCells, cl: fmtNum(r.cellLen), cw: fmtNum(r.cellWid), ch: fmtNum(r.cellH), cr: fmtNum(r.cradleR)}))));
  }

  // the product half, from the collation (the one owner of per-cell content)
  const col = project.primary && project.primary.collation;
  if(col){
    const perCell = trayResult.perCell;
    put('qtyTotal', PRODUCT_KEYS, trayResult.total);
    // we always know the cell count, so distribute by cells over there too
    put('distributeBy', PRODUCT_KEYS, 'nCells');
    put('nCellsProduct', PRODUCT_KEYS, trayResult.nCells);
    // the pitch we EXPORT is packPitchOf — the same value the cell length was
    // sized from (cookietray.js cellLengthFor), so the tray this link rebuilds
    // over there is the tray we built here rather than a second reading of the
    // product's dimensions.
    if(col.piece.kind === 'cylinder'){
      const orient = resolvePieceOrientation(col);
      put('productType', PRODUCT_KEYS, 'round');
      put('cookieDiameter', PRODUCT_KEYS, col.piece.diameter);
      put('cookieThickness', PRODUCT_KEYS, packPitchOf(col.piece, orient));
      // ORIENTATION (our own extension — see PRODUCT_KEYS' doc). Round only:
      // a box has no analogous choice, so nothing is sent for one and a
      // re-import defaults it to 'on-edge', matching the unrotated box every
      // link has always described.
      put('orientation', PRODUCT_KEYS, orient);
    }else{
      // their rectangle axes: thickness runs along the channel, width across
      // the cell, height vertical — the same convention our on-edge collation
      // uses, so the piece dims map straight across.
      put('productType', PRODUCT_KEYS, 'rectangle');
      put('productThickness', PRODUCT_KEYS, packPitchOf(col.piece));
      put('productWidth', PRODUCT_KEYS, col.piece.W);
      put('productHeight', PRODUCT_KEYS, col.piece.H);
    }
    void perCell;
  }
  const qs = out.toString();
  return qs ? `${base}?${qs}` : base;
}
