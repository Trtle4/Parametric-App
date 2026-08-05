# Parametric packaging app (rsc-designer/)

Single-page app: parametric dielines (2D SVG), 3D fold, palletization, DXF
export. ES modules, no build step, no framework. Serve `rsc-designer/` over
HTTP (`.claude/serve.ps1`, port 8321) — ES modules don't load from `file://`.

## Architecture rules

- `src/core/` is mm-only and DOM-free. Unit conversion happens only in
  `ui/inputs.js` (reading) and display formatting (`core/units.js`).
- Styles implement the `Geometry` contract in `core/types.js` and own ALL
  material compensation (`outer` dims). The packer/containment layer never
  adds caliper.
- `caliper` is a raw material property — no floors in dimensional math.
  Rendering-only thickness floors live in `render/fold3d.js`
  (`RENDER_MIN_THICKNESS`).
- Orientation limits are per containment level (`allowedOrientations`),
  never defaulted to all six.
- One writer, one notification path. Every project value has exactly one
  writer, and every display registers itself with the single recompute()
  notifier. Never hand-maintain a list of refreshers, and never let a
  display read a cache that isn't repopulated by that same recompute. A
  value with two writers will diverge; a value with a hand-maintained
  refresh path will go stale. Both have happened in this codebase; neither
  should happen again.
- One question, one computation. A physical quantity (cases per pallet,
  load height, a dimension) must be computed in exactly one place and read
  from there by every display. If two code paths compute "the same" number,
  they will diverge — and the wrong one is often plausible enough to hide
  for a long time. When two displays disagree, suspect a duplicated
  computation before suspecting a display bug. The pallet count read 132 in
  one place and 72 in another for weeks because a second fitInto re-packed
  with mismatched inputs; the fix was deleting the second computation, not
  reconciling the two.
- A shared source must be fully consumed. When a function returns multiple
  values that together define a result (geometry + rotation, count +
  arrangement, value + unit), every consumer must use all of them. A consumer
  that takes {geo} and drops rot, or reads the count and ignores the
  arrangement, produces a result that's subtly wrong in exactly the cases the
  dropped value governed. When two views of "the same thing" disagree, suspect
  a partial consumer before suspecting two sources. The bare-piece 3D view
  drew a standing coin in On Edge mode for exactly this reason: it took {geo}
  from pieceGeo and dropped the rot that lays the cylinder on its side, while
  the wrap/carton views applied both.
- Verify 3D/UI changes at the size and from the angle the user actually
  sees. Orientation and legibility bugs survive a zoomed-in screenshot and
  the default isometric view precisely because those are the conditions
  under which they're invisible — check named orthographic views (not
  just the default angle) and check at real rendered size (not just
  zoomed in for your own inspection). Four separate ViewCube fixes shipped
  broken for exactly this reason before this rule was written.

## Tests

- `test/golden.json` + `test/verify.html`: regression pins for geometry and
  pallet results. Numeric comparisons use 1e-9 tolerance (unit round-trip
  noise is ~1e-14; real deviations >= 0.15).
- `test/containment.test.html`: DOM-free unit tests for the containment
  model. Both run in the browser off the dev server.
- Value-correct is not the same as visible. The test suite asserts models
  and displayed values, but no test renders the real stylesheet against a
  real layout, so CSS clipping, overflow, and zero-width bugs are invisible
  to it. For any UI change, verify the rendered result at real size, not
  just that `.value` is correct. The blank GRID fields held the right
  value in a zero-width box.
- Test harnesses can produce false greens. A bare DOM fixture missing
  elements the real app has (ViewCube nodes, the real stylesheet) can make
  a whole class of assertions pass against an environment that never
  actually renders. `test/uisync.test.html`'s skeleton was missing
  `#viewCubeWrap` after the ViewCube feature landed, so `setView()` threw
  on every `#tab3d` click and 3D init silently never ran — every prior
  3D-hierarchy assertion in that file had been passing against a scene
  that was never actually built. When adding a UI feature, update every
  test harness's DOM skeleton to match, and periodically confirm 3D/render
  assertions run against a real initialized scene, not a silently-aborted
  one.

## Known simplifications to revisit

- **RESOLVED (seal-angles task): the flow-wrap end seal is angled, not
  flush.** `flowwrap.js` takes two independent machine settings —
  `internalAngle` (the film RAMP) and `externalAngle` (the finished seal
  LAY) — with the shared physical band in the exported `SEAL_ANGLES`
  (internal 15–75°, external 0–90°; the UI sliders read that same band). The
  internal angle derives a per-end **jaw clearance** = `(H/2)/tan(θ)` (the
  crimp never starts flush at the product face) and a **ramp slant** =
  `(H/2)/sin(θ)` that lengthens the film blank (`cutLength`, so `filmArea`
  grows with a shallower ramp). Pack length is now a RANGE:
  `packLengthAtAngle = L + 2·(jawClearance + endSealWidth·sin(external))`
  and `packLengthMax = L + 2·(jawClearance + endSealWidth)` (fin at 90°).
  **`outer.L = packLengthAtAngle` — the carton FOLLOWS the current external
  lay** (corrected from the earlier conservative-max sizing; a folded-flat
  seal is short and the carton is sized to that, a standing seal grows it).
  The angle IS the design decision. `packLengthMax` stays in `meta.seal` and
  the readout as a REFERENCE ("if the seal stands: X") — the tolerance if a
  folded design ends up standing in production — but it does NOT drive carton
  size. Single source: `flowwrap.js` computes all of this once into
  `meta.seal`; `project.js` copies the derived `jawClearance`/`sealFlatLength`/
  angles onto the render `seals` (never recomputing tan/sin), and
  `hierarchy3d.js` draws the ramp over the jaw clearance + a crimp tab laid at
  the external angle (rendered pack length = `packLengthAtAngle`, matching
  `outer.L`, so both the render and the carton respond to the sliders). The
  machine-direction-is-L / seals-at-the-L-ends lock is untouched — the angles
  operate within it.
- **RESOLVED (case-builder task): clearance is split.** `Clearance` now
  carries optional `bottom` / `top` / `betweenZ`; when omitted they default
  to `wall` / `wall` / `between` (the legacy uniform shape, so the pallet
  level is untouched). The carton->case chain passes vertical zeros:
  cartons bear on the case floor, no default headspace. Headspace as a
  first-class design input is still pending an engineering ruling.
- **Orientation flip parity**: `Orientation` strings capture axis mapping
  only, not up/down flips — "inverted" occupies identical space to upright
  in the solver. Recorded in the Build UI but geometrically inert.
- **Vertical axis is a COMPARISON variable (multi-select), not one fixed
  choice.** The "Vertical axis" control (`mountVertControl`, inputs.js) is
  L/W/H checkboxes: each checked axis contributes its orientation(s) to the
  level's `allowedOrientations`, and `parentCandidates` already loops that
  list, so the Build table gets one candidate-row set per axis — ranked
  across BOTH arrangement AND standing orientation, with a "Vertical" column
  (o[2] → H/L/W-up). No mixing within a parent: each candidate still carries
  exactly one orientation; multi-axis only enumerates more single-orientation
  candidates. The core (containment.js/collation.js) was already axis-
  agnostic — this is UI only. DEFAULT stays single-axis (whatever the level
  carries), so golden pins and the default-selected candidate are unchanged
  until the user opts axes in. `orientationsToAxes` is the multi inverse;
  `orientationsToVertical` stays for single-axis reasoning. The pallet
  (`pOut`) control keeps L/W disabled (a pallet stands H up).
- **Shelf rotate 90° spins the FORWARD FACE in its own plane (about the
  DEPTH axis) — not the vertical.** `shelf.rot` (app.js, shelf view state —
  never on the project) turns the pack 0/90/180/270°, clockwise to the
  shopper, like turning a framed picture on the wall: the SAME face stays
  forward (never a side or the back). That's orthogonal to face selection
  (`shelf.front`), which picks WHICH face is forward. Because the spin is
  in-plane, the face's own two dims swap — across (o[0]) ↔ up (o[2]);
  depth (o[1]) unchanged — so `fillO = frontO[2]+frontO[1]+frontO[0]` at
  90°/270° feeds `fitInto` a different width×height and the fill
  (facings/stack/count/occupied) recomputes (a non-square face gives a
  different count at 90° than at 0°). `buildShelf` builds the box from the
  true front dims (`odGeo`) and spins each instance about the DEPTH axis
  (`makeRotationZ(+rotDeg)`, clockwise), kept separate from the art-front
  `makeRotationY(π)` alignment; rot=0 collapses the spin to identity, so the
  default is bit-identical to the pre-rotate shelf. Rigid Z-rotation (det
  +1) → artwork turns with the face, never flips/mirrors. (Earlier this
  rotated about the vertical — a lazy-Susan that wrongly showed the sides
  and back; corrected to the depth axis.)
- **`openTop` is wired for the outermost tier only.** A `Level.openTop`
  (containment.js: `fitInto`/`parentCandidates` `opts.openTop`/`fixedH`/
  `wantCount`) makes that level's own H an independent input instead of
  solved-from-child, and stops it constraining how many children fit —
  correct today when the open-top container IS the case (`candidateCases`/
  `checkLockedCase`/`chainMetrics` all read `outerLevel.openTop`). An
  open-top container nested as an INNER level (e.g. a tray riding inside a
  case, solved via `solveSecondaryInner`) still constrains height as if
  closed — that path never reads `openTop`. Extend `solveSecondaryInner` if
  that case ever arises.
- **Artwork 3D: cartons/cases/shelf use a tube; the flow wrap textures its
  real pillow body; the tray is opted out.** The artwork round-trip
  (template -> upload -> map) is one system fed by each style's
  `meta.artMap` (render/artwork.js, render/artwork3d.js). For the closed
  cartons a6120/sealend, the retail shelf, and the closed hierarchy
  instances, the 3D cladding is `packArtGeometry` — a cross-section extruded
  along one axis (a tube), extruded upright along H with the girth around
  the four walls. The FLOW WRAP is the exception: its wrap-depth view is NOT
  the tube (the tube was hollow — no caps over the crimped ends — and
  axis-transposed vs the pillow, so with graphics it read see-through and
  misaligned). Instead the SAME pillow body the cutaway builds
  (`wrapPartsGeometry` loft) carries the art directly: `bodyRingUVs`
  (hierarchy3d.js) assigns per-ring [u,v] so the artMap's girth bands wrap
  the real body — u along the product length (−L end reads u1 so the print
  is unmirrored), v around the girth measured by cumulative perimeter (the
  bands sum to the physical perimeter) from the bottom-centre seam (the
  w=0 crossing of the bottom edge, interpolated — NOT snapped to a vertex,
  which lands ~W/2 off-centre and shifts every band). Result: front panel
  centred/upright on the top face, opaque, solid, sharing the pillow's
  frame so it can never be hollow or misaligned. Solid = the printed pillow
  (no contents); Cutaway = the translucent film + pieces (never overlaid
  with the art, so it always aligns). The FEFCO 0300 tray is an OPEN
  cross-blank — a base with four walls that each run a different way in the
  flat — so a single tube UV would rotate two walls. Its `artMap` sets
  `flat: true`, which opts it into the shared template + 2D overlay +
  upload/remove and OUT of the 3D tube (app.js refresh3d skips the tube for
  `flat` maps). A per-wall tray UV builder is the follow-up. The template,
  2D map and 3D UVs all derive from that one `artMap`, so they can't
  disagree; artwork is persisted downscaled (render/artwork.js `MAX_EDGE`)
  so the save file round-trips the art without bloating.
- **Artwork clads every instance — hierarchy, pallet AND shelf.**
  Artwork is a property of the pack (its level/style), not of one opened
  instance. Every rendered instance carries it from ONE shared texture per
  pack type (`packArtGeometry` + `packArtMaterials`): the hierarchy textures
  the closed InstancedMesh units (cartons in a case, cases on a pallet — so a
  printed pallet shows the art on every case; hierarchy3d.js `artInstances`),
  and the retail shelf textures every facing pack. Cap `ART_INSTANCE_CAP`
  (400) backstops pathological counts (a full pallet is ~130); beyond it the
  overflow is flat board and the HUD says so. The Solid/Cutaway toggle chooses
  look-AT (closed, printed — `soloClosed` for the tube packs, the printed
  pillow body for the flow wrap) vs look-INSIDE (cutaway); it defaults
  to Solid when the pack at the depth has art, and always on the shelf.
  Orientation gotcha (shelf): the shelf is built with pack fronts at local -Z
  but the ViewCube's FRONT looks down the opposite axis, so `buildShelf`
  rotates the whole group 180° about the vertical (and each art pack 180° to
  match the frontMat -Z convention) — without that the FRONT panel renders on
  the far side. `fefco201` (the RSC case) gained an `artMap` so case artwork is
  possible at all. The default carton/case print text is now empty (no
  "FRAGILE").
