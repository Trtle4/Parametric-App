/**
 * DXF R12 export, CUT + CREASE layers. Core geometry is mm; coordinates are
 * written in the user's display unit (with matching $INSUNITS), exactly as
 * the original single-file exporter did.
 */
import {fromMM, fmtInputValue} from '../core/units.js';

function dxfLine(x1, y1, x2, y2, layer){
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`;
}

/** Build the DXF file body as a string. */
export function buildDXF(geo, unit){
  const c = v => fromMM(v, unit);
  let ents = '';
  for(let i = 0; i < geo.cut.length; i++){
    const a = geo.cut[i], b = geo.cut[(i + 1) % geo.cut.length];
    ents += dxfLine(c(a[0]), c(a[1]), c(b[0]), c(b[1]), 'CUT');
  }
  geo.crease.forEach(s => ents += dxfLine(c(s[0]), c(s[1]), c(s[2]), c(s[3]), 'CREASE'));
  const insunits = unit === 'mm' ? 4 : 1; // 4=mm, 1=inch
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n` +
    `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2\n` +
    `0\nLAYER\n2\nCUT\n70\n0\n62\n1\n6\nCONTINUOUS\n` +
    `0\nLAYER\n2\nCREASE\n70\n0\n62\n5\n6\nDASHED\n` +
    `0\nENDTAB\n0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n${ents}0\nENDSEC\n0\nEOF\n`;
}

/** Trigger a browser download of the DXF. */
export function downloadDXF(geo, params, unit){
  const dxf = buildDXF(geo, unit);
  const d = v => fmtInputValue(fromMM(v, unit), unit);
  const blob = new Blob([dxf], {type: 'application/dxf'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `FEFCO201_${d(params.L)}x${d(params.W)}x${d(params.H)}_${unit}.dxf`;
  a.click(); URL.revokeObjectURL(a.href);
}
