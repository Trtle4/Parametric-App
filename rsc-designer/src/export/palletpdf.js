/**
 * Pallet summary sheet — ONE portrait US-Letter page, composed by hand.
 *
 * Hand-written PDF rather than a CDN library, deliberately: this codebase is
 * zero-dependency with no build step (the DXF exporter is the same kind of
 * hand-composed text file), and a single page of JPEG images + the built-in
 * Helvetica base fonts needs nothing a library provides. A CDN lib would be
 * the app's first runtime dependency and an offline failure mode.
 *
 * The writer emits PDF 1.4: a page tree, two base fonts (Helvetica /
 * Helvetica-Bold — viewer-resident, nothing embedded), the three captured
 * views as DCTDecode (JPEG) image XObjects, and one UNCOMPRESSED content
 * stream — uncompressed on purpose, so a test can read the exported text
 * straight out of the bytes (pin what the app EXPORTED).
 *
 * COMPOSITION ONLY. Every number on the sheet arrives as a formatted string
 * the caller read from the app's own resolved row and formatters; nothing
 * here computes, converts, or rounds a dimension — the second computation is
 * how the pallet height and the cell length went wrong, and a report sheet
 * is exactly where a plausible wrong number would hide longest.
 *
 * Text metrics come from canvas measureText against the browser's Helvetica/
 * Arial — metrically near-identical to the viewer's Helvetica, and it beats
 * shipping an AFM width table for the two alignments (centring, right-align)
 * the layout needs.
 */

/* ---- design-system tokens, as print colours (index.html :root) ---- */
const INK    = [0x19/255, 0x22/255, 0x27/255];   // --ink
const INK2   = [0x59/255, 0x65/255, 0x6C/255];   // --ink-2
const INK3   = [0x8A/255, 0x95/255, 0x9B/255];   // --ink-3
const LINE   = [0xD2/255, 0xD9/255, 0xDE/255];   // --line
const ACCENT = [0x0F/255, 0x6E/255, 0x77/255];   // --accent

const PAGE_W = 612, PAGE_H = 792, M = 40;        // portrait 8.5 x 11 in, pt

let mctx = null;
export function textWidth(s, size, bold){
  if(!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  // measure what will be DRAWN: a transliterated arrow is two characters wide
  return mctx.measureText(winAnsi(s)).width;
}

/**
 * WinAnsi, honestly. The file declares /WinAnsiEncoding and is written a byte
 * at a time as `charCodeAt(i) & 0xff`, so a code point above U+00FF is
 * silently TRUNCATED into a different glyph: an arrow (U+2192) came out as a
 * right quote, because 0x2192 & 0xff = 0x92. Latin-1 survives that by
 * accident; nothing else does.
 *
 * So the characters WinAnsi does have above U+00FF are mapped to their real
 * byte, and the ones it does not have are TRANSLITERATED to ASCII rather than
 * mangled. Anything still out of range becomes '?' — a visible gap beats a
 * plausible wrong glyph.
 */
const WIN_ANSI = {
  '\u20ac': '\x80', '\u201a': '\x82', '\u0192': '\x83', '\u201e': '\x84', '\u2026': '\x85',
  '\u2020': '\x86', '\u2021': '\x87', '\u02c6': '\x88', '\u2030': '\x89', '\u0160': '\x8a',
  '\u2039': '\x8b', '\u0152': '\x8c', '\u017d': '\x8e', '\u2018': '\x91', '\u2019': '\x92',
  '\u201c': '\x93', '\u201d': '\x94', '\u2022': '\x95', '\u2013': '\x96', '\u2014': '\x97',
  '\u02dc': '\x98', '\u2122': '\x99', '\u0161': '\x9a', '\u203a': '\x9b', '\u0153': '\x9c',
  '\u017e': '\x9e', '\u0178': '\x9f'
};
/** Characters with no WinAnsi glyph at all, spelled out instead. */
const TRANSLIT = {'\u2192': '->', '\u2190': '<-', '\u21d2': '=>', '\u26a0': '!', '\u2264': '<=', '\u2265': '>='};
export function winAnsi(str){
  let out = '';
  for(const ch of String(str)){
    if(ch.codePointAt(0) < 0x100){ out += ch; continue; }
    if(WIN_ANSI[ch]){ out += WIN_ANSI[ch]; continue; }
    out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : '?';
  }
  return out;
}

const esc = s => winAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n2 = v => +v.toFixed(2);

/**
 * @param {object} spec
 *   {dateStr, unit,
 *    images: {iso, top, cut} — each {data (JPEG dataURL), w, h} px,
 *    captions: {iso, top, cut},
 *    sections: [{label, rows: [[key, value], ...]}]}
 * @returns {Uint8Array} the PDF file
 */
/** Greedy word wrap to a pixel width, using the sheet's own text metrics. A
 *  word longer than the column is left on its own line rather than broken:
 *  a split dimension reads as two numbers. */
export function wrap(str, width, size, bold){
  const words = String(str).split(/\s+/).filter(Boolean);
  if(!words.length) return [''];
  const lines = [];
  let cur = words[0];
  for(let i = 1; i < words.length; i++){
    const next = cur + ' ' + words[i];
    if(textWidth(next, size, bold) <= width) cur = next;
    else { lines.push(cur); cur = words[i]; }
  }
  lines.push(cur);
  return lines;
}

/** The width a section row's value is wrapped to. Exported so a pin measures
 *  the number the renderer uses, not a copy of it. */
export const SECTION_COL_W = PAGE_W - M - (M + 336 + 20);   // = PAGE_W - M - dx

export function buildPalletPdf(spec){
  const c = [];                                   // content stream ops
  const ty = v => PAGE_H - v;                     // compose top-down
  const col = rgb => `${n2(rgb[0])} ${n2(rgb[1])} ${n2(rgb[2])}`;

  const text = (x, yTop, s, {size = 10, bold = false, color = INK, tc = 0, align = 'left', width = 0} = {}) => {
    let tx = x;
    const w = textWidth(s, size, bold) + tc*Math.max(0, s.length - 1);
    if(align === 'right')  tx = x + width - w;
    if(align === 'center') tx = x + (width - w)/2;
    c.push(`${col(color)} rg`, 'BT', `/F${bold ? 2 : 1} ${size} Tf`, `${n2(tc)} Tc`,
           `1 0 0 1 ${n2(tx)} ${n2(ty(yTop))} Tm`, `(${esc(s)}) Tj`, 'ET');
    return w;
  };
  const hline = (x1, yTop, x2, {color = LINE, w = 0.7} = {}) => {
    c.push(`${col(color)} RG`, `${w} w`, `${n2(x1)} ${n2(ty(yTop))} m`, `${n2(x2)} ${n2(ty(yTop))} l`, 'S');
  };
  const frame = (x, yTop, w, h) => {
    c.push(`${col(LINE)} RG`, '0.7 w', `${n2(x)} ${n2(ty(yTop + h))} ${n2(w)} ${n2(h)} re`, 'S');
  };
  const image = (name, x, yTop, w, h) => {
    c.push('q', `${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(ty(yTop + h))} cm`, `/${name} Do`, 'Q');
  };
  const eyebrow = (x, yTop, s, opts = {}) =>
    text(x, yTop, s.toUpperCase(), {size: 7.5, color: INK3, tc: 1.1, ...opts});

  /* ---------------- layout ---------------- */
  let y = M + 8;
  eyebrow(M, y, 'Parametric packaging · pallet load summary');
  eyebrow(M, y, `Generated ${spec.dateStr}`, {align: 'right', width: PAGE_W - 2*M, color: INK2});
  y += 24;
  text(M, y, 'Pallet Summary', {size: 21, bold: true});
  text(M, y + 14, `All dimensions in ${spec.unit}`, {size: 8.5, color: INK2});
  y += 24;
  hline(M, y, PAGE_W - M);
  y += 18;

  // ---- row 1: the iso view + the data column ----
  const isoW = 336, isoH = 300, isoTop = y;
  image('Im1', M, isoTop, isoW, isoH);
  frame(M, isoTop, isoW, isoH);
  eyebrow(M, isoTop + isoH + 13, spec.captions.iso, {align: 'center', width: isoW});

  const dx = M + isoW + 20, dw = PAGE_W - M - dx;

  // THE COLUMN HAS A FLOOR. It shares its x-range with the bottom-right image,
  // so a section that runs past the first image row does not simply look
  // cramped — it draws over a photograph and over its caption. That was true
  // the moment a block longer than three rows existed; the sheet had only ever
  // been given short ones. Sections are MEASURED first, and whatever does not
  // fit continues on a second page rather than being drawn on top of something
  // or silently dropped.
  //
  // Row height, in one place, so the measure and the draw cannot disagree:
  // a 7.5pt label (11), one 13pt line per wrapped line, and 2 of air.
  const rowH = (v, width) => 11 + 13*wrap(String(v), width, 10).length + 2;
  const secH = (sec, width, last) =>
    14 + sec.rows.reduce((a, [, v]) => a + rowH(v, width), 0) + 3 + (last ? 0 : 8);

  const drawSections = (list, x, width, y0) => {
    let dy = y0;
    for(const sec of list){
      text(x, dy, sec.label.toUpperCase(), {size: 8, bold: true, color: ACCENT, tc: 1.0});
      dy += 14;
      for(const [k, v] of sec.rows){
        text(x, dy, k, {size: 7.5, color: INK3});
        dy += 11;
        // WRAP. A row value used to be assumed short enough for the column,
        // and ran off the page when it wasn't — an openability warning is a
        // sentence, not a dimension. Measured against the same canvas metrics
        // every other string on this sheet uses, so a line that fits here fits
        // when it is drawn.
        for(const line of wrap(String(v), width, 10)){
          text(x, dy, line, {size: 10});
          dy += 13;
        }
        dy += 2;
      }
      dy += 3;
      if(sec !== list[list.length - 1]){ hline(x, dy - 6, x + width); dy += 8; }
    }
    return dy;
  };

  // how much of the column is really available: down to the first image row
  const COLUMN_FLOOR = isoTop + isoH + 10;
  let split = spec.sections.length, used = isoTop + 4;
  for(let i = 0; i < spec.sections.length; i++){
    const h = secH(spec.sections[i], dw, i === spec.sections.length - 1);
    if(used + h > COLUMN_FLOOR){ split = i; break; }
    used += h;
  }
  const onPage1 = spec.sections.slice(0, split), overflow = spec.sections.slice(split);
  drawSections(onPage1, dx, dw, isoTop + 4);

  y = isoTop + isoH + 30;

  // ---- row 2: top-down + case cutaway ----
  const pw = (PAGE_W - 2*M - 16)/2, ph = 230;
  image('Im2', M, y, pw, ph);
  frame(M, y, pw, ph);
  eyebrow(M, y + ph + 13, spec.captions.top, {align: 'center', width: pw});
  image('Im3', M + pw + 16, y, pw, ph);
  frame(M + pw + 16, y, pw, ph);
  eyebrow(M + pw + 16, y + ph + 13, spec.captions.cut, {align: 'center', width: pw});
  y += ph + 30;

  // ---- footer ----
  hline(M, PAGE_H - M - 14, PAGE_W - M);
  eyebrow(M, PAGE_H - M, 'Parametric packaging designer');
  eyebrow(M, PAGE_H - M, `Units · ${spec.unit}`, {align: 'right', width: PAGE_W - 2*M});

  /* ---------------- page 2, only if something overflowed ---------------- */
  const page1 = c.join('\n');
  let page2 = '';
  if(overflow.length){
    c.length = 0;                                  // the drawing helpers write into `c`
    // the same header rhythm page 1 uses: eyebrow, 24 down to the title,
    // 24 more to the rule. Set by hand the first time, it overlapped.
    let y2 = M + 8;
    eyebrow(M, y2, 'Parametric packaging · pallet load summary');
    eyebrow(M, y2, `Generated ${spec.dateStr}`, {align: 'right', width: PAGE_W - 2*M, color: INK2});
    y2 += 24;
    text(M, y2, 'Specification, continued', {size: 21, bold: true});
    y2 += 24;
    hline(M, y2, PAGE_W - M);
    // full width here, so a sentence wraps into far fewer lines than it did
    // in the narrow column it was pushed out of
    drawSections(overflow, M, PAGE_W - 2*M, y2 + 18);
    hline(M, PAGE_H - M - 14, PAGE_W - M);
    eyebrow(M, PAGE_H - M, 'Parametric packaging designer');
    eyebrow(M, PAGE_H - M, `Units · ${spec.unit}`, {align: 'right', width: PAGE_W - 2*M});
    page2 = c.join('\n');
  }
  const pages = page2 ? [page1, page2] : [page1];

  /* ---------------- assemble the file ---------------- */
  const jpegs = [spec.images.iso, spec.images.top, spec.images.cut].map(im => atob(im.data.split(',')[1]));

  // Object numbers are computed from the page count BEFORE anything is
  // pushed, because a page has to name its content stream and the catalog has
  // to name every page. With one page these come out 1..9 exactly as they
  // always did, so an unperforated sheet is byte-identical.
  const nP = pages.length;
  const pageN = i => 3 + i, contentN = i => 3 + nP + i;
  const fontN = 3 + 2*nP, fontBoldN = fontN + 1, imN = i => fontBoldN + 1 + i;

  const objs = [];                                 // 1-based object bodies
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  // PDF arrays are SPACE separated. A comma here parsed as a third, bogus
  // entry and every reader rejected the file with "non-page object in page
  // tree" — invisible with one page, because one page needs no separator.
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageN(i)} 0 R`).join(' ')}] /Count ${nP} >>`);
  pages.forEach((_, i) => {
    // only the first page carries images; the continuation is text alone
    const xobj = i === 0
      ? `/XObject << /Im1 ${imN(0)} 0 R /Im2 ${imN(1)} 0 R /Im3 ${imN(2)} 0 R >> ` : '';
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
              `/Resources << /Font << /F1 ${fontN} 0 R /F2 ${fontBoldN} 0 R >> ` +
              `${xobj}>> /Contents ${contentN(i)} 0 R >>`);
  });
  pages.forEach(pg => objs.push(`<< /Length ${pg.length} >>\nstream\n${pg}\nendstream`));
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  [spec.images.iso, spec.images.top, spec.images.cut].forEach((im, i) => {
    objs.push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ` +
              `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
              `/Length ${jpegs[i].length} >>\nstream\n${jpegs[i]}\nendstream`);
  });

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
         offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for(let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
