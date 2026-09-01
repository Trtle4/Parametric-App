/**
 * Artwork mapping — invariants every style's `meta.artMap` must satisfy.
 *
 * Centralised HERE, not per-style: the panel/face declarations genuinely
 * DIFFER between styles (a carton's panel run is not a case's — half a
 * girth apart, see core/perf.js's own doc comment), so authoring `faces`
 * once per style is correct and does not get centralised. What a valid
 * declaration must never do, though, is the same everywhere — that belongs
 * in exactly one shared checker, run exhaustively over the style registry,
 * so a fifth style cannot silently violate it and a missing declaration is
 * an ERROR, never a skip.
 *
 * Pure, DOM-free, no THREE dependency: every check here operates on a
 * resolved Geometry (core/types.js's contract) or its `meta.artMap` alone,
 * so it can run against `styles[i].geometry(defaults, {})` directly in a
 * plain loop. The render-level properties (major-panel caps actually
 * folding correctly in 3D, the perforation cut following the real arc) are
 * necessarily THREE-dependent and are checked by pins in the browser
 * harness instead — see test/singlesource.test.html.
 */

/**
 * Property 1: the manufacturer's joint (glue) flap is never declared as an
 * outward-facing quad. `packArtGeometry` (render/artwork3d.js) builds one
 * quad per entry in `am.faces`, unconditionally — a `glue` entry there
 * would be a spurious visible band on a made-up box, since the joint flap
 * has no outward-facing surface (it is glued BEHIND the panel at the far
 * end of the girth — core/perf.js's own doc comment).
 *
 * Not applicable to a style with no `am.faces` at all (a flat cross-blank,
 * or a style with no artwork map).
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {{ok: boolean, applicable: boolean, bad?: string[]}}
 */
export function glueNeverOutward(geo){
  const am = geo && geo.meta && geo.meta.artMap;
  if(!am || !Array.isArray(am.faces)) return {ok: true, applicable: false};
  const bad = am.faces.filter(f => f.panel === 'glue').map(f => f.panel);
  return {ok: bad.length === 0, applicable: true, bad};
}

/**
 * Property 2: every side face's template rect is DERIVABLE from the same
 * blank the 2D dieline draws for that panel, not an independently-guessed
 * rectangle that happens to agree today. Verified by checking that each
 * face's four corners are literal ENDPOINTS of the style's own `crease`
 * array (the panel fold lines render/dieline2d.js draws, and the boundary
 * between one panel and the next) — a generic, style-agnostic check that
 * needs no per-style field names, since crease lines ARE panel boundaries
 * by definition.
 *
 * Not applicable to a style with no `am.faces` or no `crease` array, or a
 * flexible (film) structure: a rigid tube's faces are walked between
 * VERTICAL creases at fixed x-positions (the panel folds), which are
 * literal segment endpoints in `crease` by construction; a flexible style's
 * girth runs the OTHER way (bands stacked in v, not walked in u — see
 * flowwrap.js's own artMap, u the same for every face) and has no such
 * per-face vertical-crease endpoints to check against, so this specific
 * corner-on-a-crease-segment method does not apply to it (a different
 * check would be needed for a flexible style's own boundary source, not
 * this one guessing at a shape it was not built for).
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {{ok: boolean, applicable: boolean, bad?: Array<{index:number,panel:string}>}}
 */
export function facesMatchDieline(geo){
  const am = geo && geo.meta && geo.meta.artMap;
  const crease = geo && geo.crease;
  if(!am || !Array.isArray(am.faces) || !Array.isArray(crease) || geo.structure !== 'rigid')
    return {ok: true, applicable: false};
  const EPS = 1e-6;
  const onCrease = (x, y) => crease.some(c =>
    (Math.abs(x - c[0]) < EPS && Math.abs(y - c[1]) < EPS) ||
    (Math.abs(x - c[2]) < EPS && Math.abs(y - c[3]) < EPS));
  const bad = [];
  am.faces.forEach((f, i) => {
    const corners = [[f.u0, f.v0], [f.u1, f.v0], [f.u1, f.v1], [f.u0, f.v1]];
    if(!corners.every(([x, y]) => onCrease(x, y))) bad.push({index: i, panel: f.panel});
  });
  return {ok: bad.length === 0, applicable: true, bad};
}

/**
 * Property 3 coverage: does this style declare printed major-panel caps
 * (`am.caps.top`/`.bottom`, render/artwork3d.js's `printedCap`), or does it
 * fall back to a plain board cap? NOT a pass/fail invariant — a style is
 * free to not declare caps yet (the plain board cap is a valid, if less
 * complete, rendering) — this is a coverage REPORT so a new style is
 * noticed rather than silently joining the "board cap" set forever. Only
 * `fefco201` declares caps today (RESOLVED, artwork-mapping task): its two
 * major flaps fold flat and tile the L×W cap exactly, so there is nothing
 * left over for a board cap to cover. `a6120`/`sealend` each have a real
 * single dominant visible flap per end too (a6120: the tuck panel; sealend:
 * the seal flap) but their depth is a runtime PARAMETER (tuckDepth/
 * sealFlapDepth) that does not, in general, exactly tile the cap the way
 * the RSC's fixed W/2 majors do — giving them `caps` needs a board-fill
 * for the leftover, deliberately deferred rather than guessed at.
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {{applicable: boolean, hasCaps: boolean}}
 */
export function capsCoverage(geo){
  const am = geo && geo.meta && geo.meta.artMap;
  if(!am || am.flat || (geo.structure !== 'rigid') || am.ends) return {applicable: false, hasCaps: false};
  const hasCaps = !!(am.caps && ((am.caps.top && am.caps.top.length) || (am.caps.bottom && am.caps.bottom.length)));
  return {applicable: true, hasCaps};
}

/**
 * Property 2, FLAT variant (a tray's open cross-blank, `am.flat`, has no
 * girth walk of `am.faces` to check — see `facesMatchDieline`'s own
 * inapplicability note). What "derivable, not guessed" means for a flat
 * style instead: the template's own canvas size is not an independently
 * chosen number that happens to agree today — it is LITERALLY the blank's
 * own bbox, so the whole dieline maps 1:1 onto the template with no
 * separate scale factor to drift out of sync.
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {{ok: boolean, applicable: boolean}}
 */
export function flatCanvasMatchesDieline(geo){
  const am = geo && geo.meta && geo.meta.artMap;
  const bbox = geo && geo.bbox;
  if(!am || !am.flat || !bbox) return {ok: true, applicable: false};
  const EPS = 1e-6;
  const ok = Math.abs(am.canvas.w - bbox.maxX) < EPS && Math.abs(am.canvas.h - bbox.maxY) < EPS;
  return {ok, applicable: true};
}

/**
 * Property 3, FLAT variant: an open cross-blank has no closing cap flaps to
 * rank by area (there is no lid — `frontFace:'H'`, seen through the open
 * top). What it DOES declare is a single visible PRINT panel (`meta.print`,
 * "the visible outer face"), and that panel must be a REAL region of the
 * dieline, not an arbitrary guessed rectangle. For the tray specifically,
 * that panel is the bottom wall's solid area BETWEEN its two corner slots —
 * bounded left/right by knife cuts, not by creases (property 2's tube check
 * reads `crease`; a slot-bounded panel's edges are `cut` vertices instead).
 * Checked generically: every corner of `meta.print` must be a literal VERTEX
 * of the style's own `cut` polygon.
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {{ok: boolean, applicable: boolean}}
 */
export function printPanelIsRealWall(geo){
  const am = geo && geo.meta && geo.meta.artMap;
  const print = geo && geo.meta && geo.meta.print;
  const cut = geo && geo.cut;
  if(!am || !am.flat || !print || !Array.isArray(cut)) return {ok: true, applicable: false};
  const EPS = 1e-6;
  const isVertex = (x, y) => cut.some(([cx, cy]) => Math.abs(cx - x) < EPS && Math.abs(cy - y) < EPS);
  const corners = [[print.x0, print.y0], [print.x1, print.y0], [print.x1, print.y1], [print.x0, print.y1]];
  return {ok: corners.every(([x, y]) => isVertex(x, y)), applicable: true};
}

/**
 * Cross-style exhaustiveness: a RIGID, non-flat style (a closed tube — a
 * carton, a case, a flow wrap's rigid cousin) is expected to declare
 * `am.faces` — the girth walk properties 1/2/3 all read. A style that is
 * rigid, is not the tray's flat open-blank exemption, and STILL has no
 * `am.faces` at all is not "not applicable" (`glueNeverOutward`'s own
 * inapplicability is silent-by-design for a style that genuinely has
 * nothing to check) — it is a MISSING declaration, an error a fifth style
 * could introduce silently if nothing here caught it. `am.ends` (a flexible
 * film wrap's crimped-seal style) does not reach this function at all: it
 * is gated on `structure === 'rigid'`, and a flexible style is exempt the
 * same way `facesMatchDieline` already exempts it.
 *
 * @param {import('./types.js').Geometry} geo
 * @returns {{ok: boolean, applicable: boolean}}
 */
export function rigidTubeStyleDeclaresFaces(geo){
  if(!geo || geo.structure !== 'rigid') return {ok: true, applicable: false};
  const am = geo.meta && geo.meta.artMap;
  if(am && am.flat) return {ok: true, applicable: false};   // tray's own exemption
  const applicable = true;
  const ok = !!(am && Array.isArray(am.faces) && am.faces.length > 0);
  return {ok, applicable};
}

/** Why property 1 (and, for a flat style, most of these) does not apply —
 *  for a report to STATE rather than a pin to silently skip. Null when
 *  every property is fully applicable (a rigid tube style). */
export function inapplicabilityReason(geo){
  const am = geo && geo.meta && geo.meta.artMap;
  if(!am) return 'no artwork map for this style — nothing here to check';
  if(am.flat) return 'flat cross-blank (open blank, no continuous girth) — property 1 (glue) and property 4 (perf arc) are vacuous; properties 2/3 do not apply to a tube cap that does not exist';
  if(geo.structure !== 'rigid') return 'flexible film — no manufacturer joint (property 1 vacuous); no board caps either (property 3 vacuous, sealed ends instead)';
  return null;
}
