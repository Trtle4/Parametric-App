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
 * Key maps and the omit-defaults convention mirror Cookie-Tray's own
 * `web/src/urlState.js`: a value equal to its default is left OUT of the
 * querystring, string fields are passed through, numbers are trimmed to at
 * most 4 decimals. Keeping that convention is what makes a link we generate
 * open correctly over there, and a link they generate parse correctly here.
 *
 * DOM-free, mm-only, pure.
 */
import {TRAY_DEFAULTS} from './cookietray.js';

/** Long name -> Cookie-Tray's compact querystring key (their TRAY_KEY_MAP). */
export const TRAY_KEYS = Object.freeze({
  nCells: 'n', longAxis: 'la', cellLen: 'cl', cellWid: 'cw', cellH: 'ch',
  cradleR: 'cr', wall: 'w', divider: 'dv', floor: 'fl', cornerR: 'cnr',
  draftDeg: 'dr', stripL: 'sl', stripW: 'sw', lipH: 'lh', flangeT: 'ft',
  cellFillet: 'cf', nozzle: 'nz'
});

/** Their PRODUCT_KEY_MAP, for the product half of the link. */
export const PRODUCT_KEYS = Object.freeze({
  productType: 'pty', cookieDiameter: 'pdia', cookieThickness: 'pthk',
  productWidth: 'pw', productHeight: 'ph', productThickness: 'ptk',
  edgeRTop: 'ert', edgeRBot: 'erb', qtyTotal: 'qty',
  distributeBy: 'dby', nCellsProduct: 'ncp', cookiesPerCell: 'cpc'
});

const STRING_FIELDS = new Set(['longAxis', 'productType', 'distributeBy']);

/** Their PRODUCT_DEFAULTS — needed so we omit defaults on export the way they do. */
const PRODUCT_DEFAULTS = Object.freeze({
  productType: 'round', cookieDiameter: 45, cookieThickness: 12,
  productWidth: 45, productHeight: 20, productThickness: 12,
  edgeRTop: 2, edgeRBot: 2, qtyTotal: 24,
  distributeBy: 'nCells', nCellsProduct: 3, cookiesPerCell: 8
});

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
 * IMPORTANT — imported values are PINNED, not auto. Cookie-Tray omits any
 * value equal to its default, so an absent `cl` there means "their default
 * cell length", NOT "derive it from my product". Treating absences as auto
 * would silently reproduce a DIFFERENT tray than the link describes, so
 * every tray dimension the link determines (present, or their default) comes
 * back as an explicit override. Reset any field to auto afterwards to hand
 * it back to this app's product-driven derivation.
 *
 * @param {string} input a share URL or querystring
 * @returns {{nCells: number, params: Object, product: Object, keysFound: string[]}|null}
 *   null when the string carries no Cookie-Tray keys at all.
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
    if(!sp.has(short)) continue;
    keysFound.push(short);
    const raw = sp.get(short);
    product[long] = STRING_FIELDS.has(long) ? raw : parseFloat(raw);
  }
  if(keysFound.length === 0) return null;          // not a Cookie-Tray link

  const nCells = Math.max(1, Math.round(params.nCells || TRAY_DEFAULTS.nCells));
  delete params.nCells;                             // the cell count is its own field
  // null overrides mean "let the tray stage derive it" — drop them so the
  // auto-with-override contract (absent key = auto) is preserved
  for(const k of Object.keys(params)) if(params[k] == null) delete params[k];
  return {nCells, params, product, keysFound};
}

/**
 * Build a Cookie-Tray share link from this project's tray.
 *
 * Emits only values that DIFFER from Cookie-Tray's defaults, exactly as
 * their own encoder does, so the link stays short and opens over there
 * showing the same tray. The product half is filled from the collation so
 * their inverse calculator lands on the same cell sizing.
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

  const put = (long, keyMap, defaults, value) => {
    if(value === null || value === undefined || value === '') return;
    const short = keyMap[long], d = defaults[long];
    if(STRING_FIELDS.has(long)){
      if(value !== d) out.set(short, value);
      return;
    }
    const num = typeof value === 'number' ? value : parseFloat(value);
    if(!Number.isFinite(num)) return;
    if(typeof d === 'number' && Math.abs(num - d) < 1e-9) return;
    out.set(short, fmtNum(num));
  };

  // the tray half — the RESOLVED values (what this project actually built),
  // so the link describes the tray on screen, not a partial override set
  put('nCells', TRAY_KEYS, TRAY_DEFAULTS, trayResult.nCells);
  for(const long of ['longAxis', 'cellLen', 'cellWid', 'cellH', 'cradleR', 'wall', 'divider',
                     'floor', 'cornerR', 'draftDeg', 'stripL', 'stripW', 'lipH', 'flangeT',
                     'cellFillet', 'nozzle'])
    put(long, TRAY_KEYS, TRAY_DEFAULTS, p[long]);

  // the product half, from the collation (the one owner of per-cell content)
  const col = project.primary && project.primary.collation;
  if(col){
    const perCell = trayResult.perCell;
    put('qtyTotal', PRODUCT_KEYS, PRODUCT_DEFAULTS, trayResult.total);
    // we always know the cell count, so distribute by cells over there too
    put('distributeBy', PRODUCT_KEYS, PRODUCT_DEFAULTS, 'nCells');
    put('nCellsProduct', PRODUCT_KEYS, PRODUCT_DEFAULTS, trayResult.nCells);
    if(col.piece.kind === 'cylinder'){
      put('productType', PRODUCT_KEYS, PRODUCT_DEFAULTS, 'round');
      put('cookieDiameter', PRODUCT_KEYS, PRODUCT_DEFAULTS, col.piece.diameter);
      put('cookieThickness', PRODUCT_KEYS, PRODUCT_DEFAULTS, col.piece.thickness);
    }else{
      // their rectangle axes: thickness runs along the channel, width across
      // the cell, height vertical — the same convention our on-edge collation
      // uses, so the piece dims map straight across.
      put('productType', PRODUCT_KEYS, PRODUCT_DEFAULTS, 'rectangle');
      put('productThickness', PRODUCT_KEYS, PRODUCT_DEFAULTS, col.piece.L);
      put('productWidth', PRODUCT_KEYS, PRODUCT_DEFAULTS, col.piece.W);
      put('productHeight', PRODUCT_KEYS, PRODUCT_DEFAULTS, col.piece.H);
    }
    void perCell;
  }
  const qs = out.toString();
  return qs ? `${base}?${qs}` : base;
}
