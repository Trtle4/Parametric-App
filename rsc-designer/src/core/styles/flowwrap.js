/**
 * Flow wrap — the first FLEXIBLE style. Film is folded and sealed, never
 * scored: `cut` is the blank outline only, `crease` is EMPTY (no fold lines
 * on the CREASE layer — fold positions live in meta.refLines as reference
 * annotations, styled distinctly by the artwork exporter). Compensation is
 * seal-based, not caliper-based.
 *
 * Blank layout (film flat, before wrapping):
 *   x (horizontal) = the REPEAT: cutLength = L + 2*(endSealWidth + endSealBleed)
 *   y (vertical)   = the GIRTH path: webWidth = girth + finAllowance
 *   bands bottom→top: fin allowance/2 | BACK half | SIDE | FRONT | SIDE | BACK half | fin allowance/2
 *   (the two half-BACK panels meet at the rear and form the longitudinal seal)
 *
 * All lengths mm except gauge (µm) and density (g/cm³) — film substance is
 * NOT caliper and is never labeled as such.
 */

/**
 * The fin/lap seal's compensation grows whichever axis the seal actually
 * stands proud of. For a HORIZONTAL flow wrapper the seal can only ever
 * land on the top or bottom face (both perpendicular to H) — the film
 * closes on the face opposite the front, and with the pack lying front-up
 * that face is the underside; there is no physical way for a horizontal
 * wrapper to close along a SIDE face, which is why finFace only offers
 * 'bottom'/'top', never a side. Both map to the SAME axis today, but the
 * mapping is a lookup keyed by the face, not a bare "always H" assumption —
 * the compensation and the renderer (hierarchy3d.js) must never again each
 * independently guess which axis/face the seal is on (Prompt 20, Part A).
 * @param {'bottom'|'top'} finFace
 * @returns {'H'} the axis this face's seal grows — currently always H,
 *   looked up rather than hardcoded so a genuinely different face could
 *   never silently reuse the wrong axis again
 */
export function finGainAxis(finFace){
  return FIN_GAIN_AXIS[finFace] || 'H';
}
const FIN_GAIN_AXIS = {bottom: 'H', top: 'H'};

/**
 * @param {Object} p
 *   L, W, H            content envelope: L = pack length (repeat direction),
 *                      W = front/back panel width, H = pack thickness (sides)
 *   sealType           'fin' | 'lap'
 *   finHeight          how far the fin stands proud of the pack
 *   finSealBand        sealed band width within the fin
 *   finTreatment       'standing' | 'folded'
 *   finFace            'bottom' (default) | 'top' — which face the seal
 *                      closes on; the compensation axis (finGainAxis) and
 *                      the renderer both key off this SAME field
 *   lapOverlap         used only when sealType === 'lap'
 *   endSealWidth       crimp jaw width, per end
 *   endSealBleed       print bleed beyond the seal zone, per end
 *   girthBasis         'rectangular' | 'round'
 *   roundDiameter      circumscribing diameter (round basis only)
 *   gauge              film thickness, MICRONS
 *   density            g/cm³
 * @returns {import('../types.js').Geometry}
 */
export function flowwrap(p){
  const {L, W, H} = p;
  const fin = p.sealType !== 'lap';

  // film usage
  const girth = p.girthBasis === 'round' ? Math.PI*p.roundDiameter : 2*(W + H);
  const finAllowance = fin ? 2*p.finHeight + p.finSealBand : (p.lapOverlap || 0);
  const webWidth = girth + finAllowance;
  const border = p.endSealWidth + p.endSealBleed;
  const cutLength = L + 2*border;
  const filmArea = webWidth*cutLength;                    // mm² per pack

  // --- compensation (outside envelope of the WRAPPED pack) ----------------
  // Seal geometry is the compensation; consumers never derive it:
  //  * L gains 2 × endSealWidth: the flattened crimp tabs stand proud of the
  //    product at each end by the jaw width. Bleed is print-only and adds
  //    NOTHING physical.                              << check vs sample >>
  //  * W gains nothing: no seal stands on the width axis.
  //  * The seal's OWN axis (finGainAxis(p.finFace) — bottom/top, both H)
  //    gains:
  //      - standing fin: + finHeight — the fin stands proud of that face
  //      - folded fin:   + gauge (µm -> mm) — film laid against the pack,
  //        negligible but honest
  //      - lap seal:     + 0 — the overlap lies within the wrap
  const gaugeMM = (p.gauge || 0)/1000;
  const finFace = p.finFace || 'bottom';
  const gainAxis = finGainAxis(finFace);
  const gain = !fin ? 0 : (p.finTreatment === 'standing' ? p.finHeight : gaugeMM);

  // blank outline only — no notches or tear features yet
  const cut = [[0, 0], [cutLength, 0], [cutLength, webWidth], [0, webWidth]];

  // girth bands, bottom -> top (fold positions are REFERENCE, not creases).
  // With the round basis the girth path is shorter than the rectangular
  // perimeter; the notional panel bands scale proportionally so the artwork
  // layout still sums to the web width.
  const fa2 = finAllowance/2;
  const k = girth/(2*(W + H));
  const bands = [W/2, H, W, H, W/2].map(b => b*k);
  const yB = [0, fa2];
  for(const b of bands) yB.push(yB[yB.length - 1] + b);
  yB.push(webWidth);
  const bandMid = i => (yB[i] + yB[i + 1])/2;
  const cx = cutLength/2;
  const refLines = [];
  for(let i = 1; i < yB.length - 1; i++) refLines.push([border, yB[i], cutLength - border, yB[i]]);

  const outer = {L: L + 2*p.endSealWidth, W, H};
  outer[gainAxis] += gain;

  return {
    structure: 'flexible',
    cut,
    crease: [],                                           // film is never scored
    bbox: {minX: 0, minY: 0, maxX: cutLength, maxY: webWidth},
    inner: {L, W, H},
    outer,
    meta: {
      style: 'flowwrap',
      refLines,                                           // fold references, NOT creases
      film: {
        girth, finAllowance, webWidth, cutLength,
        filmAreaM2: filmArea/1e6,
        packsPerMetre: cutLength > 0 ? 1000/cutLength : 0,
        massPer1000g: (filmArea/1e6)*(p.gauge || 0)*(p.density || 0)*1000  // m²·µm·g/cm³ = g
      },
      sealZones: {                                        // for the artwork exporter
        ends: [{x0: p.endSealBleed, x1: border}, {x0: cutLength - border, x1: cutLength - p.endSealBleed}],
        bleeds: [{x0: 0, x1: p.endSealBleed}, {x0: cutLength - p.endSealBleed, x1: cutLength}],
        fin: [{y0: 0, y1: fa2}, {y0: webWidth - fa2, y1: webWidth}]
      },
      labels: [
        {x: cx, y: bandMid(1), text: 'BACK ½'}, {x: cx, y: bandMid(2), text: 'SIDE'},
        {x: cx, y: bandMid(3), text: 'FRONT'},  {x: cx, y: bandMid(4), text: 'SIDE'},
        {x: cx, y: bandMid(5), text: 'BACK ½'}
      ],
      hDims: [
        ...(p.endSealBleed > 0 ? [{from: 0, to: p.endSealBleed, v: p.endSealBleed}] : []),
        ...(p.endSealWidth > 0 ? [{from: p.endSealBleed, to: border, v: p.endSealWidth}] : []),
        {from: border, to: cutLength - border, v: L}
      ],
      vDims: [
        ...(fa2 > 0 ? [{from: 0, to: fa2, v: fa2}] : []),
        {from: yB[1], to: yB[2], v: bands[0]}, {from: yB[2], to: yB[3], v: bands[1]},
        {from: yB[3], to: yB[4], v: bands[2]}, {from: yB[4], to: yB[5], v: bands[3]},
        {from: yB[5], to: yB[6], v: bands[4]}
      ],
      print: {x0: border, x1: cutLength - border, y0: yB[3], y1: yB[4]}   // FRONT panel
    }
  };
}
