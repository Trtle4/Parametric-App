/**
 * DXF R12 (AC1009) export — the format cutting tables and Illustrator/Fusion
 * read most reliably. Core geometry is mm; coordinates are written in the
 * user's display unit (mm or inch), which is what the receiving app imports.
 *
 * Layers are generic: the closed `cut` perimeter goes to CUT, `crease`
 * segments to CREASE, and any additional layers a style declares in
 * `geo.aux` ({LAYERNAME: Segment[]}) are emitted as-is. Every linetype a
 * layer references is defined in the LTYPE table; the LAYER count is
 * computed from the layers actually present, never hardcoded.
 *
 * Number formatting: a SINGLE fmt() used for every coordinate. toFixed
 * guarantees fixed-decimal output (never exponential), values below EPS snap
 * to exactly 0 (kills float noise like 7.1e-15 that aborts parsers), and
 * trailing zeros are trimmed. No coordinate this module emits contains e/E.
 */
import {fromMM, fmtInputValue} from '../core/units.js';

// conventional pens for known layers; anything else falls back
const LAYER_STYLE = {
  CUT:        {color: 1, ltype: 'CONTINUOUS'},
  CREASE:     {color: 5, ltype: 'DASHED'},
  PERF:       {color: 3, ltype: 'DASHED'},
  SCORE_HALF: {color: 4, ltype: 'DASHED'}
};
const FALLBACK = {color: 2, ltype: 'CONTINUOUS'};

const EPS = 1e-9;                       // below this, a coordinate is noise -> 0
const EOL = '\r\n';                     // canonical DXF line ending

/** The one and only coordinate formatter. Fixed decimal, no exponent ever. */
function fmt(v){
  if(!isFinite(v)) v = 0;
  if(Math.abs(v) < EPS) v = 0;         // snap float noise (and -0) to 0
  let s = v.toFixed(6);                // toFixed never yields exponential
  if(s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** Build the DXF file body (R12 / AC1009) as a string. */
export function buildDXF(geo, unit){
  const c = v => fromMM(v, unit);

  // collect layer -> segment list; cut is a closed polygon, the rest segments
  const layers = new Map();
  const add = (name, segs) => { if(segs && segs.length) layers.set(name, (layers.get(name) || []).concat(segs)); };
  const cutSegs = geo.cut.map((a, i) => {
    const b = geo.cut[(i + 1) % geo.cut.length];
    return [a[0], a[1], b[0], b[1]];
  });
  add('CUT', cutSegs);
  add('CREASE', geo.crease);
  for(const [name, segs] of Object.entries(geo.aux || {})) add(name, segs);

  // linetypes actually referenced by the layers present
  const usedLtypes = [];
  for(const name of layers.keys()){
    const lt = (LAYER_STYLE[name] || FALLBACK).ltype;
    if(!usedLtypes.includes(lt)) usedLtypes.push(lt);
  }

  const out = [];
  const t = (code, val) => { out.push(code, val); };

  // ---- HEADER ----
  t(0, 'SECTION'); t(2, 'HEADER');
  t(9, '$ACADVER'); t(1, 'AC1009');
  // $INSUNITS is intentionally omitted: it is not valid in R12 (added in
  // R2000/AC1015). R12 carries no reliable unit variable; the coordinate
  // magnitudes are already in the chosen display unit.
  t(9, '$EXTMIN'); t(10, fmt(c(geo.bbox.minX))); t(20, fmt(c(geo.bbox.minY))); t(30, '0');
  t(9, '$EXTMAX'); t(10, fmt(c(geo.bbox.maxX))); t(20, fmt(c(geo.bbox.maxY))); t(30, '0');
  t(0, 'ENDSEC');

  // ---- TABLES: LTYPE before LAYER ----
  t(0, 'SECTION'); t(2, 'TABLES');
  t(0, 'TABLE'); t(2, 'LTYPE'); t(70, usedLtypes.length);
  for(const lt of usedLtypes){
    t(0, 'LTYPE'); t(2, lt); t(70, 0);
    if(lt === 'DASHED'){                // simple dash-gap pattern, valid R12
      t(3, 'Dashed __ __'); t(72, 65); t(73, 2); t(40, fmt(7.5)); t(49, fmt(5)); t(49, fmt(-2.5));
    }else{                             // CONTINUOUS / solid: no pattern elements
      t(3, 'Solid'); t(72, 65); t(73, 0); t(40, '0');
    }
  }
  t(0, 'ENDTAB');
  t(0, 'TABLE'); t(2, 'LAYER'); t(70, layers.size);
  for(const name of layers.keys()){
    const st = LAYER_STYLE[name] || FALLBACK;
    t(0, 'LAYER'); t(2, name); t(70, 0); t(62, st.color); t(6, st.ltype);
  }
  t(0, 'ENDTAB');
  t(0, 'ENDSEC');

  // ---- ENTITIES: portable LINEs, colour/linetype BYLAYER ----
  t(0, 'SECTION'); t(2, 'ENTITIES');
  for(const [name, segs] of layers){
    for(const s of segs){
      t(0, 'LINE'); t(8, name);
      t(10, fmt(c(s[0]))); t(20, fmt(c(s[1]))); t(30, '0');
      t(11, fmt(c(s[2]))); t(21, fmt(c(s[3]))); t(31, '0');
    }
  }
  t(0, 'ENDSEC');
  t(0, 'EOF');

  let str = '';
  for(let i = 0; i < out.length; i += 2) str += out[i] + EOL + out[i + 1] + EOL;
  return str;
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
