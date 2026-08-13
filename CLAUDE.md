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

- A pin that RECOMPUTES the expected value is a restatement, not a test. It
  will agree with a bug as readily as with a fix — the test-layer face of the
  single-source rule above. Every pin written that way this session passed its
  own mutation test: the M-1 Dims split (which recomputed the Pallet/Load
  arithmetic instead of reading the drawn overlay), a rounding fixture whose
  80/3 case rounds to 27 under both `ceil` and nearest, and a sibling-refresh
  check whose helper fired `change` as well as `input` and so never tested the
  live path. The pins that read what the app actually RENDERED or EXPORTED —
  overlay text, mesh vertices, the querystring, the deployed Cookie-Tray —
  caught their bugs immediately. So: mutation-test every pin. Revert the fix;
  if the pin still passes, it is testing the implementation against itself,
  and the fixture is at fault, not the code.
- An ASYNC pin body is unchecked. `t()` runs the body synchronously, so an
  `async () => {}` pin's throw becomes an unhandled rejection and the pin
  reports PASS — every assertion inside it silently unverified. `t()` now
  REFUSES an async body (it returns a promise, so the runner can see it) rather
  than teaching the runner to await, which would reorder every pin. Put the
  awaits in the enclosing block and keep the pin synchronous. Four pins in
  uisync were already written that way when the guard was added.
- Fixture hygiene: a cascade of failures around one real fault is how a suite
  loses its credibility. A pin that inherits state from its neighbours — a
  stale overlay toggle, a left-over 2D view, a depth click that is a no-op
  because that depth is already shown — knocks over unrelated tests when one
  genuinely fails, and can pass by luck when it doesn't. Each pin establishes
  its own preconditions (force a real rebuild rather than assuming one) and
  restores what it changed in a `finally`, so it passes in isolation and in
  any order. Three separate fixtures broke this way in one session.

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
- **RESOLVED (tray-2D task): the tray has a 2D view, and it is a MULTIVIEW,
  not a dieline.** `render/tray2d.js` draws TOP/FRONT/RIGHT in third angle —
  the product2d.js precedent one level up, and for the same reason: a
  thermoformed part has no blank, no cut, no crease, so it cannot go through
  dieline2d.js's cut/crease renderer, cannot satisfy the `Geometry` contract,
  and has no DXF (the level's export chip says so; STL stays its export). The
  DIMENSIONED overall L/W is the MAX CROSS-SECTION — `tray.outer`, the value
  `trayOuter()` hands the wrap — read off the resolved stage, never
  re-derived. The tapered base IS drawn (a hidden outline in plan, the real
  slope of the elevations) but is never the dimensioned extent: the base is
  the number a drawing most plausibly shows and the one that would undersize
  every level above it. Height dimensions the DRAWN part (`params.overallH`)
  and the caption states the envelope when product stands proud, the same
  split the tray-depth HUD makes. `longAxis: 'Y'` is a placed-frame rotation
  that the drawing must consume in FULL — labels come off the already-rotated
  envelope, so a pin that reads only the labels cannot tell a drawing that
  turned the rim and cells from one that ignored the rotation (measured: that
  mutation passed the first version of the pin). The three drawings now share
  ONE callout renderer, `render/dim2d.js` — lifted out of product2d.js rather
  than copied a third time; its optional `key` tags a label `data-dim="…"` so
  a pin reads the value the drawing RENDERED, by name, and its optional
  `label` NAMES the callout: an unlabelled number beside another of similar
  size is ambiguous however correct it is (a bare 50 under an elevation reads
  as an overall), so only the envelope L/W go bare and everything else carries
  BASE / CELL L / CELL W / CELL DEPTH / PITCH. Features a dimension line
  cannot letter (a 2.5mm flange on a 139mm sheet — `dimLine` suppresses those
  outright) and quantities that are not linear at all (the draft ANGLE) get
  `leader()` instead. The sheet carries a TITLE BLOCK in the pallet PDF's own
  pattern (eyebrow label, mono value, design tokens) rather than a prose
  caption, and a THREE-TYPE line vocabulary — outline / cell / hidden —
  because dashed had been doing double duty and the dividers vanished at four
  cells. `TRAY_LINE_TYPES` is the one definition; the sheet legend and the
  rail legend both read it. The 2D LEGEND is a
  claim about what is on screen, same as the 3D HUD's swatches: it is written
  from the level (`LEGEND_2D`, app.js) into `#hud2dKeys`, because a multiview
  contains no cut and no crease to name — the static "Cut / Crease" markup had
  been over-claiming at the product level already. (Adding that node meant
  adding it to `test/uisync.test.html`'s DOM skeleton too — the harness rule
  below, hit again: app.js wrote to a null element and every pin in the file
  died at import.) Three more instrument faults surfaced by mutation
  in the same file: the title-block band was SIZED from one strokeW and drawn
  at another (the two-computation bug in miniature — the last row fell off the
  sheet); `export/png.js` inlined `var(--x)` from a HAND-MAINTAINED token list
  that had no `--accent`, so the exported PNG dropped every cell line and the
  legend swatch while the screen was perfect (the list is now SCANNED out of
  the markup and cannot go stale); and the harness had no design tokens at all,
  which made both the text-metric and the token-resolution pins unable to fail
  — it now pulls index.html's own `:root` block synchronously at boot, so the
  tokens are the app's, not a copy. DATES go through `core/stamp.js`: the zone
  is NAMED (`America/New_York`, so the daylight rule is live rather than a
  hardcoded -5), because reading the host's zone stamped a sheet generated at
  9pm Eastern with TOMORROW's date, and a document dated in the future is how
  a reader tells two revisions apart.
- **RESOLVED (cost task): material cost is RATES × the quantities the chain
  already solved, and nothing else.** `core/cost.js` owns no geometry and
  measures nothing — `materialCost(quantities, rates)` multiplies, and a
  quantity it is not handed becomes a NAMED missing term rather than a
  locally-derived one or a silent zero (a chain with no carton reads "not in
  this chain: carton", never a free carton). The quantities are added to the
  row in `decorateRow`, WITH the other derived values, so the rate panel, the
  per-level readout and the Build column are three views of ONE number; the
  blank-area expression that feeds both the existing `boardAreaM2` and the new
  per-level areas was factored into `blankAreaM2()` rather than written twice.
  ONE computation drives everything: the per-PACK breakdown. Every roll-up is
  that breakdown times a count, which is why the pallet trip lands exactly once
  per pallet by construction rather than by a separate rule. Rates are stored
  CANONICALLY ($/m², $/kg) and only the display converts to $/ft²; absence of a
  key IS the auto state (`COST_DEFAULTS`), the tray rail's idiom, so there is no
  isAuto flag to disagree with the value, and an old save file with no `cost`
  key loads as fully-auto rather than as five frozen overrides. The Build column
  is per 1000 packs (a pack's board is fractions of a cent and would render as a
  column of identical zeros) and is the point of the feature: on the default
  project 18 of 36 candidates TIE at 34560 pieces/pallet — indistinguishable to
  every existing column — while their cost spans $19.29 to $32.17 per 1000, and
  the count ranking's own default winner is the dearest of them. Two pins had
  to be sharpened by mutation: comparing the rendered per-pack figure to the
  rendered per-1000 could not see a wrong roll-up multiplier (the per-pack
  readout is quantised to a tenth of a cent, coarser than the error), and
  checking a cost against the row's own area cannot see cost measuring its own
  area — the areas are now anchored to numbers that existed BEFORE cost did
  (the chain's `boardAreaM2`, and the rail's rendered board-area readout).
- **RESOLVED (shelf-compare task): two DESIGNS can be compared, in two
  IDENTICAL bays.** Every other comparison in the app ranks candidates WITHIN
  one design; this one puts the current project beside a saved one. Design B is
  a SNAPSHOT — `save.loadFromSlot` deserializes its own object graph, with its
  own artwork and its own rates — solved through the same pure core functions
  and never through build.js's row cache or selection, which belong to the live
  project alone (`hierarchyBundle(proj, row)` takes the row for exactly that
  reason). B is read-only: to change it you load it, edit it as the active
  project, and save it back. The bays are identical because that is what keeps
  the two counts directly comparable — each is a full-bay number, not a half-bay
  number needing mental doubling. ONE fill function (`shelfFill`) serves both:
  the single shelf is it called once, a comparison is it called twice, and there
  is no second implementation of the packing, orientation or subsetting rules.
  `shelf3d.js` keys its groups by BAY ID so rebuilding one never disposes the
  other's geometry or art texture — the isolation rule seen from the render
  side. The isolation PIN needs A and B to DIFFER: measured, with both bays the
  same design a mutation that wrote B's pallet spec straight into the live
  project passed, because the value leaked in was the value already there.
  Per-side front/rotate controls were deliberately NOT built — the existing
  shared controls apply to both bays, and 'auto' (the default) lets each design
  present by its own declared face, which is the honest merchandising
  comparison; per-side overrides, comparing three designs, and delta
  highlighting are all noted and unbuilt.
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
- **3D candidate cycle arrows are a SECOND control onto the ONE selection
  state — never a parallel list.** At case AND pallet 3D depth, prev/next
  (`#candCycle`, app.js) step through `build.sortedRows()` — the exact
  ordered list the Build table renders — and each step COMMITS via the same
  path a row click uses (`build.stepCandidate` → `selected` → `refreshAll`).
  One index into one sorted list drives the arrows' "N of M", the table's
  highlighted row, the pallet readout's "row N of M", and the committed
  project candidate together; re-sorting the table re-orders the arrows too
  and keeps the SAME build selected (its number just moves). `getCycleState`
  reports the ON-SCREEN candidate's place — `selected` or, before any pick,
  the shared `defaultCandidate(rows)` that `resolveActiveRow` also renders,
  so the position is right from the first frame. `setCycleListener` fires the
  arrows' UI update on every `renderTable` (re-sort included, which never
  runs `refreshAll`). Clamps at both ends, no wrap. The pallet readout was
  fixed at the same time: it had computed "row N of M" from the RAW
  enumeration order (`rows.findIndex`), disagreeing with the sorted table —
  now it reads `getCycleState`, so all three positions are one source.
- **Cartons-per-case is a RANGE — one more dimension on the ONE candidate
  list.** The tertiary link carries an optional `countMax` (min = `count`);
  `countMax` absent or ≤ `count` is single-count, bit-identical to before.
  `candidateCases` loops `count..countMax` (auto mode only — an explicit grid
  pins the count to its product) × arrangements × checked axes into the same
  ranked list. The count is part of a candidate's IDENTITY (`cartonsPerCase`
  on the row + the selection key): the same irreducible grid serves several
  counts (a 2×2×3 case holds 10, 11 or 12), so nx·ny·nz no longer determines
  the count. `candidateCases` caches the pallet solve per unique case SHAPE
  (grid+orientation) and re-emits per count — only the ×count multiplier
  differs — so a wide range stays fast (5–20 ≈ 650 candidates in ~25 ms; no
  computing-state needed). The DISPLAY caps at `CANDIDATE_CAP` (build.js, =50)
  by cartons/pallet AFTER complete evaluation, and ONLY when exceeded, so the
  best is always shown and single-count sets are untouched; no remainder is
  reported (narrow/widen the range to reshape the set). The range UI is
  `mountCountArrangement`'s `rangeMode` (case level only this pass; wraps/carton
  gets it later — leave the "Wraps/carton" column slot). A "Cartons/case"
  column shows each row's count. Ranking is by cartons/pallet (∝ pieces/pallet,
  the default sort — same order).
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
  the real body — u along the product length (−L end reads u0, +L reads
  u1), v around the girth measured by cumulative perimeter (the bands sum
  to the physical perimeter) from the bottom-centre seam. THE RING IS
  OPENED AT THAT SEAM (`seamOpenRing`): the seam point is interpolated at
  the w=0 crossing of the bottom edge — never snapped to a neighbour, which
  lands ~W/2 off-centre — and DUPLICATED, so the walk starts and ends there
  and the two copies carry vHi and vLo. Without that vertex there was
  nowhere to be discontinuous, so v interpolated its whole range across the
  ONE segment spanning the bottom face: the bottom rendered a squashed
  SIDE-FRONT-SIDE sweep and the template's two BACK half-bands and its fin
  allowance never appeared on the pack at all. Applied to every section ring
  (body and both ramps), printed or not, so printed and unprinted stay one
  geometry; `loftGeometry(rings, uvs, open)` skips the wrap segment, so the
  shape is unchanged. The CRIMP TAB continues that ring rather than
  inventing a range: its v is read from the crimp ring's own v
  (`crimpVLookup`), which removes the scale STEP at the crimp line — the tab
  used to stretch the whole canvas height across its width at 2.3x the
  ramp's texel density, the right region at the right u span but a
  blown-up crop to the eye. The residual gather (body 1.00 → ramp-at-crimp
  1.51 template-mm of v per mm) is physical and progressive, not a step.
  FACE COVERAGE IS PART OF THE PIN: the quadrant pin samples the TOP face
  only, which is how the seam smear survived three rounds of artwork work —
  a pin that samples one face cannot see a defect on the opposite one. The
  companion pins paint EVERY panel its own colour (the two BACK halves and
  the two SIDEs separately, so a swap cannot hide behind a shared colour)
  plus the RAMP/END columns and the fin allowance, and sample top, bottom
  (both halves), both sides, both ramps, both crimps and the fin, each from
  a view where that face is front-facing. Colours are classified by RATIO to
  the brightest channel, never absolute: a shaded purple renders ~[72,0,135]
  and an absolute test reads it as blue. UP/LEFT ARE MEASURED, NOT
  EYEBALLED: the first mapping had both u and v reversed and rendered the
  template rotated exactly 180°, signed off from an angle where a 180° turn
  looks plausible; the pin that holds it now quadrant-samples the RENDERED
  pixels against the template at a fixed elevated-front view, so any
  single- or double-axis flip moves a corner colour and fails. The artwork
  path never forks the geometry: a printed wrap is closedWrapParts /
  buildWrapMeshes with a texture, and the art canvases ride the BUNDLE
  (attached in hierarchyBundle), so the shelf and the hierarchy read the
  same art — the shelf's printed facings once forked to the art tube, whose
  cross-section is the artMap's girth band widths in template mm, and drew
  hollow open-ended planes. Result: front panel centred/upright on the top
  face, opaque, solid, sharing the pillow's frame so it can never be
  hollow or misaligned. Solid = the printed pillow
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
- **A wrap has TWO drawn states, and ONE material rule picks between them**
  (`wrapMaterials`, hierarchy3d.js). OPENED = the cutaway: translucent film,
  seal zones coloured, contents visible. CLOSED = what ships: opaque, nothing
  showing through, and NO seal colouring, because an unprinted flow wrap is
  plain film from crimp to crimp (the orange there was diagramming a closed
  pack). Artwork replaces the white wherever there IS artwork — white stands
  in for UNPRINTED film, so hiding an upload would defeat the feature — and
  it replaces it on EVERY part: printed film runs continuously through the
  ramp and into the crimp, so the ramps/crimp tabs/fin carry the same
  texture (UVs into the template's RAMP / END SEAL columns and the fin
  allowance band), just never the teal/orange seal DIAGRAM colours, which
  stay cutaway-only. Callers pass the STATE,
  never a material, so every site agrees: wrap depth (Solid vs Cutaway), the
  non-hero packs inside a carton/case and on a pallet, and the shelf facings
  all come through `wrapMaterials` via `buildWrapMeshes`/`closedWrapParts`.
  Solid at wrap depth used to fall through to the cutaway whenever there was
  no artwork, so an unprinted pack had two identical modes. The HUD legend
  takes the same switch (`LEGEND` entries are tagged `cutaway`/`solid`) — a
  swatch is a claim about what is on screen, and Solid contains no film teal
  or seal orange to name.

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
- **The shelf shows the PACK's own face, drawn as the pack that is really
  there.** Two rules, both learned from a wrapped tray. (1) Which face a
  pack is merchandised on belongs to the STYLE, not to the shelf: each
  style declares `meta.frontFace` as the axis of that face's outward
  NORMAL — `'W'` for the upright tube cartons/case (the printed panel is a
  wall), `'H'` for the flow wrap and the tray (the display face is the
  top). That normal IS `o[1]` of a `FRONT_PANELS` orientation string, so
  `FRONT_BY_NORMAL` maps it totally, with no per-pack branch. The selector
  defaults to `'auto'` (follow the pack) and an explicit pick still wins;
  artwork pins the front to the SAME face rather than a second hardcoded
  `'LWH'`. The old flat `'LWH'` default stood a shrink-wrapped tray on its
  long edge and showed the shopper 49mm of film end. (2) A facing is drawn
  as the REAL pack: for a filmed wrap the facings come from
  `closedWrapParts()` — the closed-wrap builder lifted out of hierarchy3d's
  own instanced path — so the facings and the opened hero pack are built by
  one function from one bundle. (3) An orientation string carries NO
  front/back parity — `orientBasis` flips a horizontal column purely to keep
  the rotation proper — so naming the axis is only half the answer.
  `faceShopperQuat` (shelf3d) turns the pack 180° about the VERTICAL when its
  declared front normal comes out facing the shelf's back; without it the
  wrapped tray had the right axis forward and the wrong SIDE of it, showing
  the shopper the underside of the tray. The SAME gap one step along: an
  orientation string does not say which way is UP on the face it selects
  either, so `meta.frontUp` names that direction in the pack frame ('+H' for
  the tube cartons, '-W' for the flow wrap, whose girth walk puts the
  template's up toward −W on the top face) and `faceUpRoll` returns the
  quarter-turn that stands it up. It composes with the user's Rotate 90° —
  same axis, same plane — so ONE effective angle drives the fill and the
  render, and it applies only while the DECLARED face is the one shown (on a
  hand-picked face there is no declared up to honour). Without it every
  printed wrap stood on its head and Rotate was the only cure. The shelf's
  face selector is likewise pinned for a printed TUBE pack but NOT for a
  printed wrap: the tube is built already laid out for one front, while the
  wrap's art rides geometry that orients like any other. Locking on "has
  artwork" alone took the control away from wraps that never needed it. It applies to the film parts and the
  opened hero pack, NOT to the artwork tube: `packArtGeometry` already builds
  its tube laid out for the pack's own front (a carton L/H/W, a wrap L/W/H),
  so the tube needs only the front flip — running it through the orientation
  as well applies the layout twice and stands the pack on the wrong axis. Instancing is per PART (one InstancedMesh
  each for body, both ramps, both crimps, the fin), so draw calls stay flat
  in the facing count: 9 draw objects at 40 packs and at 4,560.
- **A check is only as sharp as the INSTRUMENT it measures with, so test the
  instrument too.** A pin that classifies or compares measured values needs
  its comparison verified under the conditions the real render produces —
  assuming it discriminates is the same mistake one level down, and it fails
  in the worst direction: a false pass looks exactly like a fixed bug. Colour
  classification by ABSOLUTE channel thresholds bucketed a lit purple
  (#8800ff renders ~[72,0,135]) as blue, so a palette pin reported both of the
  pack's bottom halves correct when one was wrong. The rule now: read a swatch
  by RATIO to the brightest channel (lighting scales out), take the NEAREST
  palette entry, and have every reading CERTIFY ITSELF — the runner-up must be
  clearly further away, or the sample comes back AMBIGUOUS and fails loudly
  rather than picking one. Then calibrate the reader against its own palette
  (`swatch reader:` pins): every colour must still read as itself from 30% to
  100% light, and no two entries may sit closer than the reader can resolve.
  That calibration immediately found a palette the instrument could NOT read —
  orange and yellow 0.47 apart — which is why the face coverage runs in two
  passes: normalised chromaticity holds only seven mutually-distant colours,
  and eight panels do not fit.
- **Fixture hygiene is measured, not assumed** (`test/uisync.test.html`).
  A pin that edits the project uses `tEdit` — snapshot in,
  `restoreProject` in a `finally`, selection included — rather than a
  hand-written restore, and NEVER writes back a hardcoded "default": three
  pins used to reset a field to a value that was never there (case wall
  clearance went back as 0 against a real 1.5, silently re-sizing every
  later pin's case). Restore is in place and deletes added keys, because
  blocks capture references into the project and an `Object.assign` restore
  cannot remove what the body added. Anything read out of the RENDER
  (overlays, the 3D scene) needs `waitFrames` — it is painted from fold3d's
  frame loop, and reading in the same synchronous turn is a race the
  fixture loses under load. The acceptance test is running every pin ALONE
  in its own page load: that must stay at 0 failures.
