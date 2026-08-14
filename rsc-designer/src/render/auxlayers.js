/**
 * Auxiliary die layers — the generic renderer for `geo.aux`.
 *
 * `geo.aux = {LAYERNAME: Segment[]}` has been the exporter's extension point
 * since export/dxf.js was written; perforation is its first user. This module
 * is deliberately built for the HOOK, not for perforation: it is a lookup
 * table plus two accessors, and it contains no layer-specific code path. The
 * next feature to put a layer in `aux` needs an entry here and nothing else —
 * no change to the dieline, no change to the legend, no change to the DXF.
 *
 * ONE MAP DRIVES BOTH the drawn line and the legend swatch. A legend is a
 * claim about what is on screen (the rule the 3D HUD and the tray sheet
 * already follow), so the swatch cannot describe a line the renderer drew
 * differently — they are the same record read twice. And a layer gets a
 * legend row only when it is actually PRESENT in `aux`, never because the map
 * knows about it.
 *
 * AN UNKNOWN LAYER RENDERS. Silently dropping a layer with no entry is the
 * failure this module exists to avoid: the next feature would put segments
 * into `aux`, see nothing, and go looking in the wrong place. Unknown layers
 * draw in a loud fallback and warn once per name.
 *
 * `width` and `dash` are MULTIPLES of the caller's stroke width, so a layer
 * keeps its relative weight at any blank size — the dieline scales its stroke
 * with the sheet.
 */

/**
 * @typedef {Object} AuxLayerStyle
 * @property {string} label   legend text
 * @property {string} color   literal colour (see the note on PERF_INK)
 * @property {number} width   stroke width, × the caller's base stroke
 * @property {number[]} dash  dash pattern, × the caller's base stroke; [] = solid
 * @property {number} order   draw order; higher paints later, i.e. on top
 * @property {string} [cap]   stroke-linecap
 */

/* The layer vocabulary. Colours are chosen to stay separable from the two
 * layers the dieline already draws — CUT is red and solid, CREASE is blue on
 * an even 4:3 dash — at the size a blank actually renders on a phone, where
 * dash rhythm blurs away and only hue and weight survive. So each entry gets
 * its own hue AND its own weight, and the dash rhythm is the third signal
 * rather than the only one.
 *
 * Draw order puts every aux layer ABOVE the panel fill and above the cut
 * outline: a tear line hidden under the cut it crosses reads as absent.
 */
/** Layer inks are LITERALS, not CSS tokens: the same colour has to reach the
 *  standalone artwork template SVG, which ships without a stylesheet, and the
 *  exported PNG, whose token inliner has gone stale before (CLAUDE.md). One
 *  definition here is read by every surface. Green matches the DXF PERF pen
 *  (colour 3), so the screen and the cutting table name one layer. */
export const PERF_INK = '#1B8A4B';
export const SCORE_INK = '#0BA5C7';

export const AUX_LAYERS = Object.freeze({
  // dash-dot at 1.5× weight: the heaviest line on the blank, and the only one
  // with an uneven rhythm. Green also matches the DXF PERF pen (colour 3), so
  // the screen and the cutting table describe one layer.
  //
  // THE PATTERN IS PRE-COMPENSATED FOR THE ROUND CAP. A round cap adds half a
  // stroke width at each end of every dash, so at 1.5× weight it grows each
  // dash by 1.5 and eats 1.5 out of each gap. Written as the numbers you want
  // to SEE, the rhythm renders as a nearly solid chain — measured at real
  // phone size, where the dot closed up entirely. These are the numbers that
  // RENDER as 5 / 2.4 / dot / 2.4: the zero-length element is the dot, drawn
  // by the cap alone.
  PERF: {
    label: 'Perforation (tear)',
    color: PERF_INK,
    width: 1.5,
    dash: [3.5, 3.9, 0, 3.9],
    cap: 'round',
    order: 30
  },
  // a half-depth score is a light long-dash — thinner than a crease, so it
  // cannot be mistaken for one even where the two run parallel
  SCORE_HALF: {
    label: 'Half score',
    color: SCORE_INK,
    width: 0.85,
    dash: [9, 3],
    order: 20
  }
});

/** What an unstyled layer draws as: loud, heavy, and unmistakably unfinished. */
export const AUX_FALLBACK = Object.freeze({
  label: 'Unstyled layer',
  color: '#FF00A0',
  width: 1.4,
  dash: [3, 3],
  order: 900
});

const warned = new Set();

/**
 * The style for a layer name. An unknown name returns the fallback and warns
 * ONCE — the dieline redraws on every keystroke, and a warning per frame is a
 * warning nobody reads.
 * @param {string} name
 * @returns {AuxLayerStyle}
 */
export function auxLayerStyle(name){
  const st = AUX_LAYERS[name];
  if(st) return st;
  if(!warned.has(name)){
    warned.add(name);
    console.warn(`[aux] layer "${name}" has no entry in AUX_LAYERS — drawing in the fallback style. ` +
                 `Add one to src/render/auxlayers.js.`);
  }
  return {...AUX_FALLBACK, label: `${name} (unstyled)`};
}

/** Test seam: forget which names have already warned. */
export function resetAuxWarnings(){ warned.clear(); }

/** The layer names present in an `aux` bag, in draw order (back to front).
 *  Names with equal order keep a stable alphabetical sequence, so a blank
 *  renders the same way twice. */
export function auxLayerNames(aux){
  if(!aux) return [];
  return Object.keys(aux)
    .filter(n => Array.isArray(aux[n]) && aux[n].length)
    .sort((a, b) => (auxLayerStyle(a).order - auxLayerStyle(b).order) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Consecutive segments joined into runs, so a chain of segments can be drawn
 * as ONE stroked path.
 *
 * This is not a nicety. A dash pattern restarts at the start of every SVG
 * element, so a polygonised curve emitted as N short `<line>`s — each of them
 * shorter than one dash — renders SOLID. Measured: the "Front removed" preset
 * polygonises to 236 segments and drew as a continuous green rule, losing the
 * one visual property that says "perforation", at exactly the place the path
 * is most curved.
 *
 * Order-dependent by design: it joins a segment to the previous one when they
 * share an endpoint, which is how a path emits them. A layer whose segments
 * are unordered simply gets more runs — more elements, never a wrong line.
 */
export function chainSegments(segs, eps = 1e-6){
  const runs = [];
  let cur = null;
  for(const s of segs){
    const a = [s[0], s[1]], b = [s[2], s[3]];
    const end = cur && cur[cur.length - 1];
    if(end && Math.abs(end[0] - a[0]) <= eps && Math.abs(end[1] - a[1]) <= eps) cur.push(b);
    else { cur = [a, b]; runs.push(cur); }
  }
  return runs;
}

/**
 * The aux layers' SVG, ready to append AFTER the cut outline.
 * @param {Object} aux            geo.aux
 * @param {(x:number)=>number} fx blank mm → svg x
 * @param {(y:number)=>number} fy blank mm → svg y
 * @param {number} strokeW        the dieline's base stroke width
 */
export function auxLayersSVG(aux, fx, fy, strokeW){
  let out = '';
  for(const name of auxLayerNames(aux)){
    const st = auxLayerStyle(name);
    const w = strokeW*st.width;
    const dash = st.dash && st.dash.length
      ? ` stroke-dasharray="${st.dash.map(d => (d*strokeW).toFixed(3)).join(' ')}"` : '';
    const cap = st.cap ? ` stroke-linecap="${st.cap}"` : '';
    out += `<g data-aux="${name}" stroke="${st.color}" stroke-width="${w.toFixed(3)}" fill="none"${dash}${cap}>`;
    for(const run of chainSegments(aux[name]))
      out += `<polyline points="${run.map(pt => `${fx(pt[0]).toFixed(2)},${fy(pt[1]).toFixed(2)}`).join(' ')}"/>`;
    out += '</g>';
  }
  return out;
}

/**
 * Legend rows for the layers PRESENT in `aux`, in the `[color, style, label]`
 * shape the 2D HUD's own legend already uses. Empty when there is no aux, so
 * a legend never claims a layer the blank does not carry.
 */
export function auxLegendRows(geo){
  return auxLayerNames(geo && geo.aux).map(name => {
    const st = auxLayerStyle(name);
    return [st.color, st.dash && st.dash.length ? 'dashed' : 'solid', st.label];
  });
}
