/**
 * DXF R12 export. Core geometry is mm; coordinates are written in the user's
 * display unit (with matching $INSUNITS), exactly as the original exporter did.
 *
 * Layers are generic: the closed `cut` perimeter goes to CUT, `crease`
 * segments to CREASE, and any additional layers a style declares in
 * `geo.aux` ({LAYERNAME: Segment[]}) are emitted as-is — the exporter never
 * needs editing when a style introduces PERF, SCORE_HALF, or anything else.
 * Known layer names get conventional colors/linetypes; unknown ones get a
 * generic pen. Nothing here is style-specific.
 */
import {fromMM, fmtInputValue} from '../core/units.js';

// presentation hints for conventional layer names; anything else falls back
const LAYER_STYLE = {
  CUT:        {color: 1, ltype: 'CONTINUOUS'},
  CREASE:     {color: 5, ltype: 'DASHED'},
  PERF:       {color: 3, ltype: 'DASHED'},
  SCORE_HALF: {color: 4, ltype: 'DASHED'}
};
const FALLBACK = {color: 2, ltype: 'CONTINUOUS'};

function dxfLine(x1, y1, x2, y2, layer){
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`;
}

/** Build the DXF file body as a string. */
export function buildDXF(geo, unit){
  const c = v => fromMM(v, unit);

  // collect layer -> segment list; cut is a closed polygon, the rest are segments
  const layers = new Map();
  const add = (name, segs) => layers.set(name, (layers.get(name) || []).concat(segs));
  const cutSegs = geo.cut.map((a, i) => {
    const b = geo.cut[(i + 1) % geo.cut.length];
    return [a[0], a[1], b[0], b[1]];
  });
  add('CUT', cutSegs);
  add('CREASE', geo.crease);
  for(const [name, segs] of Object.entries(geo.aux || {})) add(name, segs);

  let table = '', ents = '';
  for(const [name, segs] of layers){
    const st = LAYER_STYLE[name] || FALLBACK;
    table += `0\nLAYER\n2\n${name}\n70\n0\n62\n${st.color}\n6\n${st.ltype}\n`;
    for(const s of segs) ents += dxfLine(c(s[0]), c(s[1]), c(s[2]), c(s[3]), name);
  }

  const insunits = unit === 'mm' ? 4 : 1; // 4=mm, 1=inch
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n` +
    `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${layers.size}\n` +
    table +
    `0\nENDTAB\n0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n${ents}0\nENDSEC\n0\nEOF\n`;
}

/** Trigger a browser download of the DXF. */
export function downloadDXF(geo, params, unit, prefix){
  const dxf = buildDXF(geo, unit);
  const d = v => fmtInputValue(fromMM(v, unit), unit);
  const blob = new Blob([dxf], {type: 'application/dxf'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}_${d(params.L)}x${d(params.W)}x${d(params.H)}_${unit}.dxf`;
  a.click(); URL.revokeObjectURL(a.href);
}
