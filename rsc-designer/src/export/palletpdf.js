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
function textWidth(s, size, bold){
  if(!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  return mctx.measureText(s).width;
}

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n2 = v => +v.toFixed(2);

/**
 * @param {object} spec
 *   {dateStr, unit,
 *    images: {iso, top, cut} — each {data (JPEG dataURL), w, h} px,
 *    captions: {iso, top, cut},
 *    sections: [{label, rows: [[key, value], ...]}]}
 * @returns {Uint8Array} the PDF file
 */
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
  let dy = isoTop + 4;
  for(const sec of spec.sections){
    text(dx, dy, sec.label.toUpperCase(), {size: 8, bold: true, color: ACCENT, tc: 1.0});
    dy += 14;
    for(const [k, v] of sec.rows){
      text(dx, dy, k, {size: 7.5, color: INK3});
      dy += 11;
      text(dx, dy, v, {size: 10});
      dy += 15;
    }
    dy += 3;
    if(sec !== spec.sections[spec.sections.length - 1]){ hline(dx, dy - 6, dx + dw); dy += 8; }
  }

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

  /* ---------------- assemble the file ---------------- */
  const content = c.join('\n');
  const jpegs = [spec.images.iso, spec.images.top, spec.images.cut].map(im => atob(im.data.split(',')[1]));

  const objs = [];                                 // 1-based object bodies
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
            '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> ' +
            '/XObject << /Im1 7 0 R /Im2 8 0 R /Im3 9 0 R >> >> /Contents 4 0 R >>');
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
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
