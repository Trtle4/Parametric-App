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
- Two legitimate shapes for style inputs. Data knowable at build time goes
  into `geometry(params, options)` and is computed once, inside the style.
  Data that depends on a solved chain — `shrink` needing the proud stack
  height — is applied to `meta` after `geometry()` returns. The
  discriminator is availability at build time, not convenience. Applying
  build-time-knowable data after the fact scatters style knowledge into a
  second file; deferring chain-dependent data into `geometry()` is
  impossible. `outerFlaps` is the first kind, `shrink` the second.

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
- A pin asserting an invariant the code enforces by construction can never
  fail. "Every code point fits a byte" is unfalsifiable when the writer masks
  with `& 0xff` — the PDF writer's byte-truncation bug (`export/palletpdf.js`)
  would have passed a pin shaped that way. Assert the observable behaviour —
  what the drawn string contains — not the guarantee.
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
  Per-side front/rotate controls were deliberately NOT built at first — the
  shared controls applied to both bays, and 'auto' (the default) let each
  design present by its own declared face, read as the honest merchandising
  comparison. **That reasoning didn't survive contact with a non-default
  save** (per-slot view state task): a design saved with a chosen front panel
  or rotation opened under whatever the OTHER bay's live control showed,
  because `shelf.front`/`shelf.rot` were pure UI state, never on the project,
  so there was nothing to restore in the first place. Fixed by splitting
  `shelf`: width/depth/height/facings/stack/deep/cutaway stay shared bay spec
  (still one shelf spec applied twice — that part of the original reasoning
  held), while `front`/`rot` moved onto `project.shelf`, chosen when a design
  is saved and restored per slot. `shelfFill(proj, ...)` now reads
  `proj.shelf.front`/`.rot` off whichever project it was handed, instead of
  the one shared object regardless of which bay. Camera/orbit stays shared —
  comparing two packs from two viewpoints was never the ask. Comparing three
  designs and delta highlighting remain noted and unbuilt.
- **The pallet PDF's PLAN view is shot through a LONG LENS, and that is what
  puts the pallet in it.** A plan of a pallet has to contain the pallet, and it
  did not: at the renderer's normal 38° lens a 1.4m load seen from overhead is
  magnified against the deck a metre below it (the near plane of a perspective
  frustum is simply wider), so the top layer covered a deck only 3% wider than
  itself completely. Measured by hiding the 22 deck meshes and diffing the
  capture: the deck contributed ZERO pixels at 38°, and 6285 at 2.2°. Framing
  was NOT the cause and reframing alone never fixed it. `captureOrbitPNG` takes
  an optional `fovDeg` and scales the distance by `tan(fov0/2)/tan(fov/2)`, so
  the subject fills the frame exactly as before and only the perspective
  compresses — toward the orthographic projection a plan is supposed to be. The
  pin reads the camera each capture actually used (the per-frame hooks run
  against the capture camera, which is the one place a test can see it) and
  checks BOTH halves: a narrow lens was used, and `tan(fov/2)·distance` — the
  visible extent — still matches the wide shots', because a narrow lens without
  the compensation just zooms in and crops. Its framing target also accounts
  for the PANEL's aspect now; the old `max(L, W)` would have cropped a pallet
  deeper than it is wide.
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
- **Confirm the specimen, not just the instrument.** "Calibrate, don't assume"
  says check that your measurement works. This says check that there is
  something to MEASURE. An instrument in perfect order, pointed at nothing,
  reports the same clean pass as a fixed bug — and three of one session's four
  escapes were that one shape, not four different mistakes.
  - A pin ASSERTS ITS FIXTURE EXHIBITS THE CONDITION, and refuses to run if it
    does not. The rigidity pin drove the fold builders with a preset that
    trimmed no crease on the case, so a builder reading `geo.crease` for its
    wall height passed; it now throws if the perforated and unperforated
    creases come back equal. The DXF layer-purity pin compared against a path
    built from the LEVEL rather than `level.perf` — and a `Level` also carries
    `enabled`, so `normalizePerf` quietly returned a valid default whose five
    segments happened to match the preset under test; it now uses a preset
    whose counts differ (25 against 5), so the wrong object cannot agree.
  - A pin that CALLS THE BUILDER tests the builder, and says nothing about
    whether the app calls it. Two display-state pins invoked
    `perfBodyGeometry` directly and passed while wiring mutations made both
    the hierarchy shell and the shelf facings ignore display state entirely.
    To test the wiring, read the RENDERED TREE — and scope it to VISIBLE
    objects, because the pivot holds every view's group at once and toggles
    visibility: an unscoped count saw the 3D tab's leftovers while the shelf
    was on screen and reported a torn facing that was not there.
  - **A feature is not done until a pin drives it the way a user does — at
    the width the user does it.** Perforation shipped with a path builder,
    renderers, exports, an openability guard and 49 passing pins — and no
    control to enable it. Every pin constructed the perf object directly, so
    every one of them passed on a feature no user could reach. At least one
    pin per feature must start from a default load and arrive at the
    behaviour through the interface. The perforation reachability pins
    themselves then passed while State sheet and exploded were unreachable
    on a phone — desktop-shaped proof, because they ran against a DOM
    skeleton that (correctly, for its own purposes) loads no layout CSS at
    all, so no width could ever have mattered to them. "The way a user
    does" includes the viewport they use: a reachability pin needs a real
    stylesheet and a real `@media` breakpoint behind it, not just a
    real click.
  - **Where a pin exists to rule out a specific wrong implementation, run
    the wrong implementation against the fixture.** The even-gaps pin runs
    a proportional-from-centroid stand-in against its own input and asserts
    the stand-in fails. That proves the pin is capable of failing, rather
    than merely not obviously trivial.
  - **An isolation pin covers what it enumerates.** Compare's pin asserted
    B never contaminates A's readouts — facings, cost, sellable unit — and
    front-panel designation and orientation leaked through anyway, because
    they are VIEW STATE, not readouts, so the pin's own enumeration never
    named them. Both bays read the one shared `shelf.front`/`shelf.rot`
    regardless of which project `shelfFill` was handed, and nothing was
    watching. When a pin asserts non-contamination, enumerate what it does
    not cover.
- **Latent: a single-`shelfRoot` restructure of `shelf3d.js` crashed the
  headless renderer.** Tried during the shelf-compare amendments and
  reverted (the per-bay grouping it would have replaced was a floor, not a
  cap — it bought nothing). The crash itself was never diagnosed: ~50-60s
  into a run, no JS error, heap flat at ~35MB, reproduced five times, gone
  on revert. Heap flat while the process dies points GPU-side (geometry or
  texture disposal under the merged structure), not a JS object-count leak.
  Cheap probe before anyone tries this restructure again: rebuild a single
  shelf bay 200x in a loop on the CURRENT (per-bay) structure. Survives, and
  the fragility was specific to the reverted single-root arrangement — safe
  to retry with more care. Doesn't survive, and there's a real disposal leak
  in the current code, found for five minutes of work instead of discovered
  mid-feature.
- **Untested: whether JPEG smears a thin dashed line the way it doesn't
  smear a flat board edge.** The capture-sheet composer's determinism check
  measured JPEG against flat board colour and straight box edges (an
  exploded-view survey) and found no meaningful smear — but that content is
  exactly what JPEG's DCT handles best. It says nothing about a 1.5-2px
  green dash-dot perforation line on tan board, which is a much smaller,
  higher-frequency mark, and chroma subsampling hits colour edges harder
  than luminance ones. This project has already broken a dashed line once
  this way (the SVG perf line rendering solid because a dash pattern
  restarts at every element — a different mechanism, same failure shape:
  a fine repeating mark reads as a solid rule). Next time the perforation
  state sheet regenerates, crop the dash region at actual embed size and
  look — don't assume the flat-board measurement covers it.
- **RESOLVED (openability-guard task): an option scoped to one consumer
  needs re-scoping when a second consumer starts reading the same fact.**
  `outerFlaps` was correctly scoped as fold-only cosmetics — on a standard
  0201 all four flaps are half the width, so swapping which pair is outer
  leaves the blank identical, and that was true of every consumer that
  existed. The perforation work promoted it to a fact with consequences
  (`openabilityWarning` reads `meta.closure.top`, which fefco201 only
  asserts for the `outerFlaps: 'L'` build), and nothing forced a re-read of
  the original scoping — so the closure declaration silently disagreed with
  the live fold render under `outerFlaps: 'W'`, false-clear on the
  unopenable configuration and false-warn on the safe one. A correct
  scoping decision can expire silently. Interim fix (`core/perf.js`,
  `OUTERFLAPS_ASSERTED_STYLES`, marked TEMPORARY): the caller now confirms
  which build is live, and ABSENCE OF THAT CONFIRMATION READS AS
  NOT-EVALUATED, never as "assume the default" — an optional argument that
  quietly defaults to the standard build reintroduces the identical failure
  one level up. **The real fix landed** (`outerFlaps` task): `geometry()`
  now takes `(params, options)` — threaded through all six `styleById(...)
  .geometry(...)` call sites in `project.js`, including the wrap's, for the
  same reason a partially-threaded option created this task in the first
  place — and `fefco201`'s `closure.top` derives `holdsLid` from the live
  `outerFlaps` build instead of asserting the default one. The temporary
  argument, `OUTERFLAPS_ASSERTED_STYLES`, and the not-evaluated state are
  gone. Golden stayed bit-identical, confirming gate 2 of that task's own
  survey: `outerFlaps` moves the fold and the closure declaration, never
  the blank.
- **The DXF harness fetches its parser from an external CDN, so it can't
  run in every environment.** `test/dxf.test.html` dynamically imports
  `dxf-parser` from esm.sh; in a sandboxed environment without reach to
  that CDN the whole file hangs at "running…" with no pin result at all —
  confirmed pre-existing (via `git stash`) during the `outerFlaps` task,
  not caused by it. Standing limitation, not new, but it means any future
  change that touches DXF output ships unverified in exactly the
  environments most likely to be sandboxed. Fix: vendor the parser (a
  committed file this repo controls, like `three.r128.min.js` already is
  for the Playwright harness) instead of fetching it live.
- **The perforation arc is complete.** Path builder (crease resolution,
  chord-tolerance sampling, presets), 3D display state, BCT gating, the
  spec sheet, the openability warning, the control panel that makes all of
  it reachable, and now `outerFlaps` deriving `closure.top` from the live
  build instead of a temporary confirm-or-refuse argument — landed across
  separate tasks, each building on the last. Recorded here so the
  temporary-argument history in the openability-guard entry above reads as
  closed, not as a loose thread: anyone finding that commit in isolation
  should find this note beside it, not re-litigate a gap that was already
  closed by a later task.
- **RESOLVED (three-from-use task): three independent fixes, one shared
  lesson — a control or a value that answers two different questions will
  eventually answer one of them wrong.**
  1. **Artwork no longer locks shelf orientation.** Diagnosis first, per the
     task's own gate: rotate was never locked; front-panel selection was,
     at two layers — `shelfFill` forced `frontO` to the pack's declared
     face whenever printed, and `shelf3d.js`'s printed-tube branch hardcoded
     a fixed 180°-Y matrix, never consuming `opts.frontO` at all, because
     `packArtGeometry`'s tube has no orientation parameter — it's built once
     in the pack's own canonical frame (x=L, y=H, z=W, front at +Z — the
     SAME frame `orient.js`'s `orientBasis('LWH')` already resolves to, and
     the same one `faceShopperQuat` assumes as input). A prior attempt to
     compose `faceShopperQuat` on top of that fixed matrix double-applied
     the orientation (measured: a printed wrap rendered 49mm tall where it
     should be 172) and the lock was added to hide the breakage rather than
     fix the composition. The actual fix: route through `faceShopperQuat`
     directly (no fixed matrix, no wrapping it), exactly like the wrap's
     `closedWrapParts` path and the shelf's opened-cutaway path already do
     — ONE orientation mechanism for every printed part on the shelf, not
     two. `artPinsFront` and the `el('shFront').disabled` lock are gone
     from `app.js`; both controls stay live under artwork, for a wrap and a
     tube pack alike. Verified by mutation: a printed tube pack's rendered
     mesh extents (rotation-only, translation stripped) must equal the
     unprinted board pack's, for every front x rot combination — reverting
     the composition to the old fixed matrix fails this pin immediately
     (measured mismatches up to ~175mm on an axis), and it also fails the
     literal "front alone changes the rendered mesh" pin, which the fit
     readout alone could never catch (it moves with `frontO` regardless of
     what the render does, since `shelfFill`'s solve was never the broken
     half).
  2. **Wrap facing is now a three-way choice, not a boolean.** Gate finding:
     facing (which of a vertical axis's two in-plan rotations, e.g. `LWH`
     vs `WLH`) was solved entirely by containment via
     `project.primary.allowedOrientations` — genuinely not an input, not
     merely unsurfaced. The one UI control touching that field
     (`mountVertControl`'s "May rotate about vertical" checkbox) could only
     ever pin `pair[0]` when off, or enumerate-and-compare both when on;
     there was no way to pin `pair[1]` specifically. Per the ruling, this
     extends the EXISTING control rather than adding a second fact:
     `verticalToOrientations(axis, mayRotate, flip)` gained a third,
     backward-compatible parameter (`flip` defaults `false`, so every
     existing 2-arg call is untouched) that picks `pair[1]` instead of
     `pair[0]` when not auto-comparing, and `mountVertControl`'s checkbox
     became a 3-way `<select>` (Auto / pair[0]-facing / pair[1]-facing,
     labelled by whichever axis lands "across" for the checked vertical
     axis) writing the same `allowedOrientations` field the same way it
     always has. `ORIENT_PAIRS` is now the one exported source for the
     axis-pair table, replacing three separate inline copies
     (`verticalToOrientations`, `orientationsToVertical`,
     `orientationsToAxes`) that had been drifting toward a fourth. Auto
     stays bit-identical (926/926 golden pins, untouched). Mutation-tested:
     reverting `flip` support collapses `pair[1]` back to `pair[0]` and the
     facing pin catches it immediately, as does the carton-dims pin (a
     non-cube wrap's L/W visibly swap in the solved carton envelope when
     facing flips, holding the vertical axis fixed — the case the old
     H-up-vs-L-up pin never covered, since that changes the axis too).
  3. **Length >= width is enforced on EDIT, never on load.** Gate finding:
     nothing in `fefco201`/`a6120`/`sealend` (`closure.top`'s panel
     indices, `artMap.section`'s girth walk, flap depth `F = W/2`, the
     dieline panel run, `core/perf.js`'s corner/panel indexing) assumes
     `L >= W` — every one of them is indexed by axis IDENTITY (which
     girth position is a length-wall vs a width-wall), never by magnitude,
     so `L < W` already produced geometrically CORRECT output; this was a
     labelling/convention fix, not a correctness one, and no
     previously-wrong-output pin was needed. Applies to `fefco201`,
     `a6120`, `sealend`, and `tray` (the FEFCO 0300, folded in per the
     ruling despite its different, non-girth-walk blank layout — same
     tier slot as the RSC, and a user switching between them at the case
     level shouldn't see L/W change meaning) — gated on the style
     registry's own `material !== 'film'` rather than a new per-style
     flag, so `flowwrap`/`shrinkbundle` (length is the machine direction)
     and the bare product (any proportions) are automatically exempt and
     can never fall out of sync with that gate. `inputs.js`'s
     `normalizeLW` runs ONLY from an editable field's `change` listener
     (blur/Enter, never mid-keystroke) — swapping is NOT neutral, since
     the girth walk assignment follows whichever value is now L vs W, so
     a mapped artwork panel resizes with it; both fields update visibly
     and an inline advisory (reusing `mountCountArrangement`'s `countwarn`
     look) names the swap and, when the level carries artwork, says so.
     The advisory clears itself on the next edit that no longer needs
     swapping, not just on the next swap. Loading is untouched by
     construction — no swap logic exists anywhere in `persistence.js` or
     `mountLevel`'s initial value population, only in the DOM `change`
     handler a real edit fires. Mutation-tested: disabling the convention
     gate fails the visible-swap pin immediately, and the
     swap-vs-direct-entry geometry-identity pin (reaching the identical
     `{L,W}` two ways — through a swap, and by typing in convention order
     from the start — and diffing `cut`/`crease`/`outer`/`inner`) confirms
     the swap is a pure relabelling, never a second, disagreeing
     computation.
- **SUPERSEDED then RESOLVED (Cookie-Tray 2D-grid task, then the
  ground-truth-correction task): the tray is a genuine 2D grid, and
  round product carries a real packMode choice — but the shape of both was
  GUESSED wrong the first time.** The original version of this entry (below,
  now rewritten) described a grid of N independent ROWS, each its own cell
  SIZE, plus a round-only `orientation`/`ori` field whose "flat" mode widened
  the cell by pitching on diameter. That was built with `add_repo` for the
  real Cookie-Tray blocked three times, so it was a plausible invention, not
  a reading — and it was wrong on both counts. The correction task got real
  ground truth by fetching the DEPLOYED APP's own production JS bundle
  directly (`curl` through the proxy; `add_repo`/`WebFetch` both still
  couldn't reach usable source — WebFetch strips `<script>` tags and never
  executes JS, so a client-rendered SPA reads as empty to it), reading the
  minified `trayParams`/`deriveTrayParams`/product-placement functions out of
  it, and cross-checking the port NUMERICALLY against a real share link a
  user supplied (`?cl=48&cr=2.5&nc=2&pkm=stack&qty=7&cpc=2`) — the three
  derived values it predicts (cellLen, cradleR, cellH) matched the link's own
  stated/defaulted values exactly.

  THE REAL MODEL, verified: cell SIZE (`cellLen`/`cellWid`/`cellH`/`cradleR`)
  is UNIFORM across the WHOLE tray — never varies row to row. What varies is
  pocket COUNT: each of the `nCells` rows (channels across the tray's width)
  is split along its OWN length into pockets — `nCols` pockets uniformly, or
  `nColsPerRow` (one entry per row) for an asymmetric grid — separated by
  `colDivider` (a real, distinct field from `divider`, the row-to-row wall).
  A row with fewer pockets than the widest row is CENTERED within the tray's
  own length, which follows the WIDEST row (`topL`); `topW` is the plain
  single-row-equivalent formula, untouched by pockets. `packMode`
  ('standing'|'stack') requires NO new field at all: it maps directly onto
  the pre-existing collation `stackAxis` ('X'/'Z') — a Z-stacked collation
  and a Cookie-Tray "stack" pocket are the same physical arrangement — and
  `packPitchOf` is ALWAYS the piece's thickness regardless of packMode
  (reverted from the guessed "diameter when flat" rule); what packMode
  actually swaps is WHICH of `cellLen`/`cellH` scales with the stacked/spread
  count and which takes the product's other fixed extent (+ a flat 4mm
  margin) — `deriveTrayParams`'s doc comment carries the exact formulas.
  `cookietray.js`'s own header cites the link cross-check as a live pin
  (`GROUND TRUTH:` in cookietray.test.html), not just prose.

  EVERY POCKET IN EVERY ROW SHARES THE SAME `cellH` and opens at the SAME
  shared rim — there is no per-row depth anymore (the guessed model's `H =
  floor + max(row.cellH)` is gone; it is simply `floor + cellH`). Both
  renderers apply this identically: `tray3d.js`'s pocket loop is row-major
  (row → its own `cols[row]` pockets), each pocket's floor at `rimY - cellH`
  (uniform), with the row's own span centered under `topL` exactly as
  `trayParams` computes it; `tray2d.js`'s `planCells()` does the same
  centering math for its TOP-view cell mouths and its elevations' trough
  rectangles/cradle arcs. A browser-loaded pin driving the REAL THREE.js
  geometry (`tray render GRID:...`, uisync.test.html — plus an equivalent
  standalone harness, since this file has the same CDN/iframe environment
  limitation `dxf.test.html` already documents and could not be driven to
  completion in this sandbox; confirmed via `git stash` that the identical
  hang exists on the unmodified baseline) checks that every pocket's floor
  lands on that ONE shared plane (not the guessed model's per-row variation)
  and that a shorter row's lone pocket centers under the widest row's span —
  mutation-tested by removing the centering term and confirming the pin
  catches a ~52mm offset.

  THE FIT CHECK (`solveTrayStage`, project.js) has two axes for a reason
  that is easy to get backwards: WIDTH is always checked against the
  collation's own ACTUAL footprint (`env.W`, sensitive to `nx`/`ny`/
  `stackAxis`) — pockets split a row along its LENGTH only, so a
  wider-than-one-stack collation must still fail regardless of `nCols`; an
  early draft of the correction compared width against the AUTO-derived
  `cellWid` instead, which is TAUTOLOGICAL whenever `cellWid` is auto (auto
  IS the resolved value then, by construction) and silently let a
  two-stacks-wide collation "fit" a one-stack-wide cell — caught by
  mutation-testing the `TRAY:` and `GRID:` misfit pins, both of which
  immediately went green on the broken comparison. LENGTH stays the same
  `env.L` check at `nCols === 1` (the common case, bit-identical to every
  pre-grid fixture); only once `nCols > 1` does it switch to the
  `auto.cellLen` (pocket-aware, `perCol`-based) comparison, because `env.L`
  by then describes a run collate() assembled for the WHOLE row, not one
  pocket's own share.

  THE COOKIE-TRAY LINK: the guessed `rw` (JSON-encoded per-row sizes) and
  `ori` keys are gone, replaced by the real ones the bundle's own key maps
  name — `ncr` (comma-separated `nColsPerRow`, sent only when a custom
  per-row array is set — mirrors the real app's own Uniform/Custom split)
  and `pkm` (packMode, `'standing'`/`'stack'`, `PRODUCT_DEFAULTS.packMode`
  verbatim from the bundle). A real Cookie-Tray link never sends either key
  and imports exactly as before (packMode defaults to `'standing'`). THE
  RAIL (`inputs.js` `mountTray`) exposes the grid as a Columns field (the
  uniform `nCols`) plus a Uniform/Custom toggle that reveals one pocket-count
  field per row when Custom — replacing the old Grid-rows UI, which edited
  ROW cell-counts (a concept that no longer exists; `nCells`, the row count,
  is its own always-editable field now, independent of the grid toggle).

  A FABRICATED TEST FIXTURE was found and removed during the correction: an
  earlier version of `cookietray.test.html` claimed differential fidelity
  against "the upstream Python" (`cookie_tray/params.py` + `calculator.py`,
  86 vectors in a committed `cookietray.vectors.json`) — invented during the
  guessed-model task, when no real source was reachable. The real app has no
  Python anywhere in it (confirmed by reading its actual JS bundle); the
  fixture and its three pins were deleted rather than reconciled, replaced by
  the live share-link cross-check described above. Recorded here as the same
  class of failure the "confirm the specimen" entries below warn about, one
  level up: not an instrument pointed at nothing, but an instrument pointed
  at something that was never real. Four `resolveWrapContents` differential
  fixtures (frozen expected numbers from the pre-refactor chain) needed
  RECAPTURING, not because they were fabricated but because the ground-truth
  fix corrected a real bug in the auto cell-depth derivation (it had been
  guessing `cellH = cellWid/2`; the real formula ties `cellH` to the
  product's own vertical extent or its paced count depending on packMode) —
  the two no-tray fixtures in that same sweep were untouched, confirming the
  formula fix was scoped to exactly the path it changed.

  BOX LAY-FLAT remains investigated and deliberately not built, for the
  reason the original entry gave (below) — that reasoning never depended on
  the row model and still holds.

  ---

  *Original entry, superseded above — kept for the box-lay-flat reasoning
  and as a record of what was guessed and why it seemed plausible at the
  time:* the tray was described as a grid of ROWS, each its own cell size
  (`TRAY_DEFAULTS.rows`, `row.span` summed into `topW`, `H = floor +
  max(row.cellH)`, per-row floors in both renderers), with round product
  lay-flat as a `pieceOrientation`-branched `packPitchOf(piece, orientation)`
  pacing by diameter when flat vs thickness on-edge, and a Cookie-Tray link
  carrying invented `rw`/`ori` keys explicitly marked "unverified against the
  real upstream" (repo access was requested and refused, twice). BOX LAY-FLAT
  WAS INVESTIGATED AND DELIBERATELY NOT BUILT: rotating a box's W/H for
  "on-edge" would require every renderer that draws a bare piece
  (`product2d.js`, `hierarchy3d.js`, `nest3d.js`) to become orientation-aware
  too, or risk exactly the historical "standing coin" mesh/envelope mismatch
  — and `pieceOrientation:'on-edge'` on a box is ALREADY reachable today (the
  product rail's On Edge toggle, and the `onedge` collation preset) with a
  real, different, correct meaning (stack-as-sleeve along L, no rotation —
  collation.js's own doc: "boxes have no round axis"); overloading it would
  silently change that existing, working behaviour. A box's L/W/H are
  already three independent user-entered numbers, so there is no missing
  information the way there is for a cylinder's diameter/thickness — a user
  gets an on-edge box in a tray today by entering its dimensions in the
  orientation they want.
- **RESOLVED (pallet-pattern task, two parts): interlock became a
  per-layer SCHEDULE, and a new sandwiched-split-band construction reuses
  it.** Part 1 was built and committed first, on purpose — it changes the
  candidate SHAPE Part 2 emits into, and building Part 2 against the old
  shape would have meant reworking it.

  **Part 1**: `palletpatterns.js` candidates carried a whole-load
  `interlock` boolean — the sixth boolean in this project that turned out
  to be a set (`tray.enabled`, content kind, `doubleStack`, film axis, the
  tray 2D grid, now this). Replaced with `layerFlips`: a per-layer boolean
  array, bottom first. "Flip every odd layer" and "flip nothing" are just
  two values the array can hold, not two code paths — the two
  auto-generated candidates every family already produced (straight,
  alternating) now build from `straightSchedule(layers)`/
  `alternatingSchedule(layers)`, bit-identical to before (mutation-tested:
  reverting `build()` to hardcode `ly & 1` breaks a schedule pin while the
  two migration pins, which check the STORED `layerFlips` array rather than
  built placements, stay green — exactly the split the task asked for).
  Each candidate gained `withSchedule(schedule)`: a NEW candidate, same
  layout/orientation/envelope, a different flip array — the entry point an
  arbitrary schedule reaches through (a schedule shorter/longer than the
  candidate's own layer count degrades safely, never throws), and where the
  `isOwn180` no-op-flip WARNING lives — populated only here, never on the
  two auto-generated candidates, whose odd-layer default is the app's own
  long-standing behaviour, not a user request. `project.pallet.layerFlips`
  (null = auto, bit-identical to before the field existed) is the project-
  level override `chainMetrics`/`applyPatternSelection` apply to whichever
  candidate is selected. `bct.js` gained `interlockCaveat(layerFlips)` —
  conditional on the ACTUAL schedule, never on `family`/`pattern` (`family:
  'optimal'` can still pick the straight candidate with nothing
  interlocked at all) — plus a static DERATINGS line, keeping the module's
  disclose-don't-apply rule: no numeric factor, ever. The rail's "columnar
  through layer k, then interlock [this layer only|all layers above]" rule
  WRITES the expanded array (never storing k+mode themselves — a scalar
  pair would have to be thrown away the moment per-layer editing UI
  lands), the same "one representation, one writer, a convenience control
  on top" idiom `pallet.stack.positions`' own quick-set buttons already
  established.

  **Part 2**: `stripLayouts` always puts its short (rotated) block at ONE
  end of the combined footprint, so a mixed layout's short band sits at an
  edge. `sandwichLayouts` — a new construction alongside `stripLayouts`/
  `pinwheelLayouts` — REARRANGES the exact same cells a matching-k
  `stripLayouts` search would find: splits the majority band's k columns
  into two EQUAL halves (k must be even — an odd k has no exact split, so
  it's simply not a candidate for this construction, the same "doesn't
  apply here" the module already uses for a square footprint), pushes one
  half flush to EACH outer edge of the layer — the real full deck extent
  every construction here uses, not the strip's own smaller combined
  footprint, which is what makes this an "edge justification" distinct
  from the original — and puts the short band in the middle, centred,
  which is what turns its own ordinary leftover slack into a visible
  central void split evenly on both sides. Emits only the maximal
  (highest-total) even k per axis/orientation combo, and only when the
  short band is non-empty (pinwheel's own "a variant that could grow, or a
  split with nothing to sandwich, is pure noise" rule). Because the two
  halves are an EXACT mirror pair and the short band is self-centred, the
  whole layer is its own 180° turn BY CONSTRUCTION — Part 1's `isOwn180`
  warning fires on it exactly like any other symmetric layout when an
  explicit schedule flip is requested. `sandwich` joined `FAMILY_RANK`
  between `mixed` and `pinwheel`, and needed no new selection machinery —
  it rides the SAME ranked candidate list, cycle arrows, and Build table
  every other family already does. Count invariance was the load-bearing
  claim (this only rearranges cells, never adds or removes one) and it's
  checked three ways: the sandwich total exactly equals a same-perLayer
  `mixed` candidate's total for a hand-verified "3+2+3" fixture, across a
  30+-instance sweep, and never exceeds the ranked-best overall. Central
  void position/width is hand-computed from the same fixture (two 5mm
  gaps flanking the middle band, symmetric about the layer's own centre —
  not just "no overhang", the edge-pushing claim itself, checked by
  confirming the outermost case footprint lands EXACTLY on the deck edge).
  No new "geometric verifier" needed writing or modifying: the pre-existing
  deck-bounds/centring sweep pins (which run against `palletPatternList`'s
  own output generically) already covered `sandwich` the moment it started
  appearing in the family set they iterate — the only change either pin
  needed was widening its EXPECTED family list from three entries to four.
  Mutation-tested precisely as specified: reverting the short band's own
  centring to a one-sided placement (still split, so the candidate survives
  dedupe as a distinct geometry, unlike a first mutation attempt that
  reverted the WHOLE construction to the legacy contiguous layout and
  collapsed it back into an existing `mixed` candidate via the module's own
  geometric dedupe, killing the count pins along with the position ones —
  informative, but not the specific failure mode asked for) breaks the
  central-void and isOwn180-symmetry pins while every count/overhang/no-
  overlap pin stays green, confirming count alone could never have caught
  this and the position pin has to exist. Full regression both parts:
  `golden.json` 998/998 unchanged (interlock's refactor is behavior-
  preserving by construction, and a rearrangement that only ever ranks at
  or below the layouts already in every fixture's list never displaces a
  `list[0]`).
- **CORRECTED (split-band-flush task): a layer has slack in TWO
  INDEPENDENT directions, and the first version of the sandwich
  construction sent both to the same place.** The Part 2 entry above's own
  "central void" — hand-computed as "two 5mm gaps flanking the middle
  band" — was, on inspection, describing the bug this task fixes, not a
  feature: those two gaps were a full-depth CHANNEL between the middle
  band and each majority half, because the majority halves were pushed
  flush to the DECK's own outer edge (`u = ±U/2`) regardless of where the
  middle band actually sat. Band-normal (u) slack — the three bands'
  combined width falling short of the deck width — is a margin AROUND the
  whole group and must never appear BETWEEN bands; band-parallel (v) slack
  — one band's own length falling short of its neighbours' — is the
  construction's actual, only void, and belongs INSIDE that band, not at
  its edges. `sandwichLayouts` now keeps the two separate: majority halves
  sit flush against the SHORT band's own edges (adjacent, zero gap; `u =
  ±(n2u*b/2 + (i+0.5)*a)`, not `±U/2`), and the whole group — `k*a +
  n2u*b` wide — is centred on the deck exactly like `stripLayouts`'s own
  `maxU` convention, so any leftover lands outside the group, split evenly.
  The new `bandRowsV(count, p, bandLength)` is the one place either kind of
  v-layout happens: an ordinary centred block when a band's own extent
  already equals `bandLength` (the longer of the majority/middle lengths —
  no shortfall, no void), or, when it falls short, `count` split into two
  EQUAL groups flush to `bandLength`'s two ends with the shortfall
  consolidated into ONE centred void between them — mirroring, one level
  down, the exact "push to two ends, leftover in the middle" pattern the
  group-centring fix now correctly reserves for the u-axis. `count` must be
  even for that split to land exactly centred (an odd count has no exact
  split — `null`, not a candidate, the SAME rule `k`'s own evenness already
  used) — a new constraint the original Part 2 fixture's own "3+2+3"
  (n2v=1, uneven by construction, one case can't be "pushed to both ends")
  couldn't satisfy, so it no longer emits at all; replaced with a
  hand-verified "3+4+3" (case 65×50×100, deck 250×180) where n2v=2 splits
  cleanly. A `rows*b === n2v*a` fixture (case 40×30×100, deck 250×120)
  confirms the OTHER new rule — no length mismatch, no void, no candidate
  at all — and is non-vacuous: without the length-equality gate, that exact
  combo has a real k=2 candidate, so the gate is refusing something, not
  nothing. Mutation-tested two ways: an IN-PIN reconstruction of the old
  `u = ±(U/2 - (i+0.5)*a)` formula (same k1/a the real candidate already
  solved) reopens exactly the reported channel while the candidate's own
  COUNT is untouched, proving count alone could never have caught this; and
  splicing the actual OLD `sandwichLayouts` function back into the real
  module and re-running the suite fails exactly the four pins that encode
  the new rules (adjacency, void location, group margin, no-short-band-no-
  candidate) while the count-match and count-invariance-sweep pins —
  and every other suite, `golden.json` 998/998 — stay green, confirming the
  fix moves positions only. Sweep coverage held without adjustment: the
  pre-existing count-invariance/no-overlap sweeps (CL 90–220 × CW 60–180 ×
  a 500×400 deck) still produce 105 sandwich instances post-fix, comfortably
  past their own `n > 10` vacuousness floor, so the new evenness/
  length-mismatch gates cut the SHAPE of what's emitted, not the volume.
- **RESOLVED (render-controls task): the render controls are two groups
  with different jobs, and that split is now a DOM fact, not a CSS
  convention.** Inventory first, per the task's own instruction, because
  this was never a single-container move: `#hud` (index.html) is only the
  gesture legend; the actual controls live in four separate containers —
  `#viewToolbar` (2D/3D/Shelf/Build tabs), `#mode3d` (Fold, the depth tabs,
  the candidate cycle arrows, Solid/Cutaway, Explode, Dims, Grid/White —
  hierarchy view only), `#modeShelf` (Solid/Cutaway, Grid/White — shelf view
  only), and the depth tabs/cycle arrows specifically (`.depthsel`,
  `#candCycle`) that used to live INSIDE `#mode3d`. **Scope** (what am I
  looking at: the depth tabs + candidate navigator) is now `#scopeBar`, a
  new element docked directly under `#chainString`, outside `<main>`/
  `.stage` entirely — a continuation of the chain strip's own navigation, so
  it needs no per-breakpoint placement CSS at all, only the same
  overflow-x:auto/nowrap treatment the chain strip already uses (the WHOLE
  bar scrolls as one row, not the inner `.seg.depthsel` alone — a
  deliberate choice, caught by mutation-testing the extracted depthsel-
  scroll pin against the real change, which is why that pin now reads
  `#scopeBar`'s own `overflow-x`, not the inner seg's). **View** (how is it
  drawn: Solid/Cutaway, Explode, Dims, Grid/White) stays in `#mode3d`/
  `#modeShelf`, which now share ONE `grid-area:rail` and ONE set of CSS
  rules — never both visible at once, so nothing to collide. `.stage`
  became a CSS grid (`grid-template-areas: "toolbar toolbar" / "canvas
  rail"` desktop, `"canvas" "toolbar" "rail"` mobile — canvas stays FIRST on
  mobile per the original sticky-pinned-render intent, so only the AREA
  order differs by breakpoint, never the element set or the DOM order) so
  `#viewToolbar` docks as a full-width in-flow top bar and the view rail
  becomes a narrow (72px) side column outside the canvas on desktop —
  vertical space is scarce there (~750px of laptop viewport after chrome,
  already spent by the header/chain strip/scope bar) — reflowing to a
  horizontal strip below the canvas on mobile, where width is scarce
  instead. ONE breakpoint-driven rule, not two control trees: the 860px
  query only changes `grid-template-areas`/`flex-direction`, never adds or
  removes an element. `.stagecanvas` went from `position:absolute;inset:0`
  to a plain grid item with its own `position:relative` — confirmed safe by
  research before touching it: nothing in JS reads `.stage`'s own rect
  (fold3d.js/viewcube.js measure `cvWrap`/their own `parentElement`
  directly), so a grid item's box works exactly like the old inset:0 box
  did for every child anchored on it. Every control kept its id, label, and
  click handler — `el(id)` lookups are flat everywhere in this codebase (no
  `.closest()`/`querySelector` assuming DOM proximity to `#mode3d`, one
  research-confirmed exception on `#m3fold` unrelated to this move), so
  relocating markup needed zero JS changes beyond `setView()` gaining one
  more `el('scopeBar').style.display` line alongside the existing
  `#mode3d`/`#modeShelf` toggles. The defect the task named was real: `#hud`
  (2D-view-only) claims "scroll zoom · drag pan · dblclick reset", but the
  2D view has NO touch path at all (no wheel handler, and pan is gated
  behind a zoom level only wheel can reach) — every clause is false on
  touch and there is no working substitute to state, so it's hidden there
  instead of rewritten (`updateHudGestureLegend`, keyed off
  `matchMedia('(pointer:coarse)')`, the one new capability check this
  codebase needed — nothing else here queries input mode up front, only
  fold3d.js's per-EVENT `pointerType` checks). `#orbithint` (3D/shelf) had
  the same defect independently — "right-drag pan · scroll zoom" have no
  touch analogue either — fixed by factoring its four separate hardcoded-
  string call sites (hierarchy/fold mode entry, Solid/Cutaway state, shelf
  entry) down to ONE `orbitGesturePrefix()` that every site composes a
  suffix onto, so the mouse/touch fork exists in exactly one place. Every
  test harness's DOM skeleton had to move with the markup, per this file's
  own rule: `test/uisync.test.html`'s bare skeleton had `.depthsel`/
  `#candCycle` INSIDE its own `#mode3d` mock and no `#scopeBar`/
  `#hudGesture` at all — since `setView()` now unconditionally writes
  `el('scopeBar').style.display`, every one of that file's several thousand
  pre-existing pins (not just this task's new ones) would have thrown at
  the very first view switch had the skeleton not been updated; caught
  before it shipped, not discovered as a regression. Mutation-tested three
  ways: moving `.depthsel` back into `#mode3d` in real `index.html` (not
  just the skeleton) failed the new structural-membership pin immediately
  (`#d_case is not inside #scopeBar`) and, as a side effect, the depthsel-
  reachability pin too; reintroducing `position:absolute;inset:0` on
  `.mode3d` (mimicking the exact old bug) failed the rail's own
  position-check pin AND the canvas-obstruction pin at both widths it now
  runs at (extended from mobile-only to mobile+desktop, per the task); and
  the obstruction pin's own sampler is exercised against a synthetic
  overlay element inline in its own pin, proving `canvasObstructionMisses`
  is capable of failing at all, not merely "not obviously trivial" — the
  first version of that pin READ CLEAN on a false positive, because the
  preceding legend-input-mode block leaves the desktop fixture parked on
  the 2D tab (no `<canvas>` on screen, `#cvWrap` display:none), so the
  "clean" baseline it diffed against was itself already obstructed for an
  unrelated reason; fixed by re-entering 3D/case on the fixture immediately
  before the mutation runs. `test/uisync.test.html`'s own DOM-fixture rule
  (`uisync.test.html cannot run to completion in this sandbox`) held again
  here (identical failure reproduced via `git stash`, unrelated to this
  task) — verified instead by extracting the new block verbatim into a
  standalone harness driving the same real `<iframe src="../index.html">`
  fixtures, exactly this session's established workaround, deleted once
  confirmed and the edit to the real file was all that remained. Full
  regression: `golden.json` 998/998 unchanged (a layout/placement change
  touches no geometry), every other suite green except `saveload.test.html`
  (4 pre-existing `pallet.stack.cornerPost` failures, confirmed via
  `git stash` to predate this task and already flagged as out of scope in
  the corner-post task's own entry above).
