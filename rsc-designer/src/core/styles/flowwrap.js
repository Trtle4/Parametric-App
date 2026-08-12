/**
 * Flow wrap — the first FLEXIBLE style. Film is folded and sealed, never
 * scored: `cut` is the blank outline only, `crease` is EMPTY (no fold lines
 * on the CREASE layer — fold positions live in meta.refLines as reference
 * annotations, styled distinctly by the artwork exporter). Compensation is
 * seal-based, not caliper-based.
 *
 * Blank layout (film flat, before wrapping):
 *   x (horizontal) = the REPEAT: cutLength = L + 2·(rampSlant + endSealWidth +
 *                    endSealBleed) — the product panel plus, per end, the
 *                    ramped film (its slant), the flat crimp and the print bleed
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
 * The two end-seal angles and their physical bands — ONE definition shared by
 * this math and the UI sliders (styles/index.js imports it), so the slider
 * range can never drift from what the geometry actually allows.
 *
 *  - internal (the film RAMP, measured from the pack face plane): the film can
 *    neither leave the product face flat (→0°, infinite jaw clearance) nor drop
 *    vertically to the crimp (→90°, zero clearance). It lives strictly inside
 *    (0,90); 15–75° is the sane machine band.
 *  - external (the finished seal LAY): 0° = folded flat against the pack end
 *    (minimum length), 90° = standing straight out (maximum length). The full
 *    0–90 is physically real.
 */
export const SEAL_ANGLES = {
  internal: {min: 15, max: 75, default: 45},
  external: {min: 0,  max: 90, default: 45}
};

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
 *   endSealWidth       the crimped fin's OWN flat length, per end
 *   endSealBleed       print bleed beyond the seal zone, per end
 *   internalAngle      film ramp angle (deg) — derives the jaw clearance
 *   externalAngle      finished seal lay angle (deg) — 0 flat … 90 straight out
 *   girthBasis         'rectangular' | 'round'
 *   roundDiameter      circumscribing diameter (round basis only)
 *   gauge              film thickness, MICRONS
 *   density            g/cm³
 * @returns {import('../types.js').Geometry}
 */
export function flowwrap(p){
  const {L, W, H} = p;
  const fin = p.sealType !== 'lap';

  // --- end-seal ANGLE geometry (two independent machine settings) ---------
  // A real horizontal flow-wrap end seal is neither flush nor rigid: two
  // angles govern it, and BOTH change the wrap's true outer length (which then
  // sizes the carton). Clamp into the shared physical band; a legacy project
  // saved before this feature (no angles) gets the defaults.
  const RAD = Math.PI/180;
  const clampA = (v, b) => Math.min(b.max, Math.max(b.min, v == null ? b.default : v));
  const internalAngle = clampA(p.internalAngle, SEAL_ANGLES.internal);
  const externalAngle = clampA(p.externalAngle, SEAL_ANGLES.external);

  // Internal ramp: the film descends from each pack face (±H/2 off the seal
  // centreline) to the flat crimp line. Its HORIZONTAL run is the jaw
  // clearance — the gap the crimp jaws need, so the flat seal can never begin
  // at the product face.  tan(internalAngle) = (H/2) / jawClearance:
  //   shallow ramp (small angle) → long clearance;  steep → short.
  // The film draped over that ramp is the SLANT (hypotenuse) — longer than the
  // clearance — so a shallower ramp also spends more film.
  const halfH = H/2;
  const jawClearance = halfH/Math.tan(internalAngle*RAD);   // horizontal run — feeds pack length
  const rampSlant    = halfH/Math.sin(internalAngle*RAD);   // hypotenuse — feeds film area

  // External lay: the crimped fin's own flat length is the end-seal width; how
  // much of it adds to pack length depends on how far the flexible tab stands.
  //   0°  laid flat against the pack end → 0 projection (min length)
  //   90° standing straight out          → full endSealWidth projection (max)
  // projection onto the length axis = sealFlatLength · sin(externalAngle).
  const sealFlatLength = p.endSealWidth;
  const externalContribution = sealFlatLength*Math.sin(externalAngle*RAD);

  // Pack length is a RANGE, not a constant: the CURRENT length at the set lay,
  // and the MAX at 90° (fin straight out) — the tolerance the carton must
  // accommodate. Each end contributes jawClearance + the fin's projection.
  const packLengthAtAngle = L + 2*(jawClearance + externalContribution);
  const packLengthMax     = L + 2*(jawClearance + sealFlatLength);

  // film usage
  const girth = p.girthBasis === 'round' ? Math.PI*p.roundDiameter : 2*(W + H);
  const finAllowance = fin ? 2*p.finHeight + p.finSealBand : (p.lapOverlap || 0);
  const webWidth = girth + finAllowance;
  // end allowance on the flat blank, outer→in per end: print bleed | the flat
  // crimp (endSealWidth) | the ramped film (its slant). The product panel
  // (width L) sits between the two borders.
  const bleed = p.endSealBleed;
  const crimp = p.endSealWidth;
  const sealEnd = bleed + crimp;                          // x where the crimp ends / the ramp begins
  const border = sealEnd + rampSlant;                    // x where the product panel begins
  const cutLength = L + 2*border;
  const filmArea = webWidth*cutLength;                    // mm² per pack (grows with a shallower ramp)

  // --- compensation (outside envelope of the WRAPPED pack) ----------------
  // L is the pack length at the CURRENT external angle — the carton follows the
  // seal's actual lay (a folded-flat seal is short and the carton is sized to
  // that; a standing seal is longer and the carton grows to match). The angle
  // IS the design decision, so the carton respects it. packLengthMax (fin at
  // 90°) is kept in meta.seal as a REFERENCE ("if the seal stands") — it does
  // NOT drive the carton size.
  //  * W gains nothing: no seal stands on the width axis.
  //  * the seal's OWN axis (finGainAxis(finFace) — bottom/top, both H) gains:
  //      - standing fin: + finHeight   - folded fin: + gauge (µm→mm)   - lap: +0
  //    This is the LONGITUDINAL back-seal fin, unchanged by the end-seal angles.
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

  const outer = {L: packLengthAtAngle, W, H};   // carton follows the current lay; max is a reference
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
      // SHELF FRONT: a flow wrap is merchandised face-UP — the printed front
      // band lands on the TOP of the pillow (the girth is measured from the
      // bottom-centre seam), so the display face's normal is H, not a wall.
      // The shelf assumed a wall for every pack and stood a wrapped tray on
      // its long edge, hiding the very face the product is seen through.
      frontFace: 'H',
      // ...and which way is UP on it. The girth walk runs seam -> back half ->
      // side -> FRONT -> side -> back half with v DESCENDING, so on the top face
      // the template's up (+v) points toward −W. An orientation string cannot
      // say that (it maps axes, with no parity), which is why the shelf stood
      // every printed wrap on its head until this was declared.
      frontUp: '-W',
      refLines,                                           // fold references, NOT creases
      // The DERIVED end-seal geometry — computed here and ONLY here. The
      // renderer (hierarchy3d.js) and the wrap-depth readout (app.js) READ
      // these; neither recomputes tan()/sin(), so the ramp you see, the length
      // that sizes the carton and the number in the readout can never diverge.
      seal: {
        internalAngle, externalAngle,
        jawClearance, rampSlant, sealFlatLength,
        externalContribution, packLengthAtAngle, packLengthMax,
        productLength: L
      },
      film: {
        girth, finAllowance, webWidth, cutLength,
        filmAreaM2: filmArea/1e6,
        packsPerMetre: cutLength > 0 ? 1000/cutLength : 0,
        massPer1000g: (filmArea/1e6)*(p.gauge || 0)*(p.density || 0)*1000  // m²·µm·g/cm³ = g
      },
      sealZones: {                                        // for the artwork exporter + 2D dieline
        ends:   [{x0: bleed, x1: sealEnd}, {x0: cutLength - sealEnd, x1: cutLength - bleed}],   // flat crimp
        ramps:  [{x0: sealEnd, x1: border}, {x0: cutLength - border, x1: cutLength - sealEnd}], // film ramp
        bleeds: [{x0: 0, x1: bleed}, {x0: cutLength - bleed, x1: cutLength}],
        fin:    [{y0: 0, y1: fa2}, {y0: webWidth - fa2, y1: webWidth}]
      },
      labels: [
        {x: cx, y: bandMid(1), text: 'BACK ½'}, {x: cx, y: bandMid(2), text: 'SIDE'},
        {x: cx, y: bandMid(3), text: 'FRONT'},  {x: cx, y: bandMid(4), text: 'SIDE'},
        {x: cx, y: bandMid(5), text: 'BACK ½'}
      ],
      hDims: [
        ...(bleed > 0 ? [{from: 0, to: bleed, v: bleed}] : []),
        ...(crimp > 0 ? [{from: bleed, to: sealEnd, v: crimp}] : []),
        ...(rampSlant > 0 ? [{from: sealEnd, to: border, v: rampSlant}] : []),
        {from: border, to: cutLength - border, v: L}
      ],
      vDims: [
        ...(fa2 > 0 ? [{from: 0, to: fa2, v: fa2}] : []),
        {from: yB[1], to: yB[2], v: bands[0]}, {from: yB[2], to: yB[3], v: bands[1]},
        {from: yB[3], to: yB[4], v: bands[2]}, {from: yB[4], to: yB[5], v: bands[3]},
        {from: yB[5], to: yB[6], v: bands[4]}
      ],
      print: {x0: border, x1: cutLength - border, y0: yB[3], y1: yB[4]},   // FRONT panel
      // ARTWORK MAP — the ONE panel decomposition the template export, the 2D
      // artwork overlay and the 3D UV wrap all read (render/artwork.js,
      // render/artwork3d.js). Derived here, at the same site that owns yB/bands/
      // border, so those three consumers can never disagree with the 2D view or
      // the template about where a panel is. Coordinates are template-canvas mm:
      // u = repeat (0..cutLength, x), v = girth (0..webWidth, y, 0 = bottom).
      // The product panel is always exactly L wide (cutLength − 2·border = L),
      // so the printed faces are unaffected by the ramp/crimp end allowance.
      artMap: (() => {
        const fw = bands[2], sh = bands[1];                     // front/back & side face widths
        const p0 = border, p1 = cutLength - border;            // the L run (u), end allowance excluded
        return {
          canvas: {w: cutLength, h: webWidth},
          product: {x0: p0, x1: p1},                            // used by the template running-direction arrow
          up: 'v',                                              // "up" on the flat = +v (template arrow)
          // 3D tube: extruded along X (the film run, L), girth around the Y-Z
          // cross-section. The film run carries u, the girth carries v.
          extrude: 'x', extrudeIsU: true, length: L,
          // cross-section polyline (y,z): FRONT at +Z, the two BACK halves meet
          // at the rear seam (y=0, z=-sh/2). One segment per band, same order.
          section: [
            [0, -sh/2], [-fw/2, -sh/2], [-fw/2, sh/2], [fw/2, sh/2], [fw/2, -sh/2], [0, -sh/2]
          ],
          faces: [                                              // template rect (mm) per band
            {panel: 'back',  u0: p0, u1: p1, v0: yB[1], v1: yB[2]},
            {panel: 'side',  u0: p0, u1: p1, v0: yB[2], v1: yB[3]},
            {panel: 'front', u0: p0, u1: p1, v0: yB[3], v1: yB[4]},
            {panel: 'side',  u0: p0, u1: p1, v0: yB[4], v1: yB[5]},
            {panel: 'back',  u0: p0, u1: p1, v0: yB[5], v1: yB[6]}
          ],
          ends: [                                               // crimped end-seal columns (the flat crimp)
            {u0: bleed, u1: sealEnd},
            {u0: cutLength - sealEnd, u1: cutLength - bleed}
          ]
        };
      })()
    }
  };
}
