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
- **RESOLVED (artwork-mapping task): four invariants — glue tab never
  outward, side faces match the dieline, major panels get printed caps with
  the RSC's own major flaps sourcing them, and a perforation tear keeps
  artwork on BOTH pieces — centralised into one shared checker, run
  exhaustively, with a chirally-asymmetric fixture so a mirrored or swapped
  panel actually fails a pin instead of reading clean.** `core/
  artworkInvariants.js` is pure/DOM-free (no THREE dependency) and holds the
  properties genuinely shared across styles; per-style `faces`/`caps`
  declarations correctly stay in each style file (a carton's panel run is
  not a case's). Property 1 (`glueNeverOutward`) and property 2
  (`facesMatchDieline` — every face rect's four corners are literal
  endpoints of the style's own `crease` array, not an independently guessed
  rectangle) run exhaustively over the style registry; a new
  `rigidTubeStyleDeclaresFaces` closes the gap the task named explicitly —
  a rigid, non-flat style with NO `am.faces` at all is an ERROR
  (`applicable:true, ok:false`), never silently skipped the way a style with
  genuinely nothing to check (flexible, or the tray's flat exemption) is.
  Property 3 ("major panels printed, largest on top") turned out to have NO
  general answer: a simple extruded tube's top and bottom caps are ALWAYS
  area-tied by construction, so "largest" cannot be computed — confirmed by
  proof, then by the user's own tie-break instruction ("for the RSC, the
  LENGTH-panel flaps are the major ones — that's where the graphics are
  sourced"), which maps directly onto `closure.top`'s PRE-EXISTING
  `major flap`/`holdsLid` distinction (the openability check's own resolver)
  rather than inventing a second orientation authority. `fefco201.js` now
  extracts `majorPanels` ONCE and both `closure.top` and the new
  `artMap.caps.top`/`.bottom` read it, so the two can never disagree about
  which pair is major. The fold-flat derivation itself: a flap's CREASE
  corners are the wall's own top/bottom edge (`V(±half, sec[face])`, the
  SAME points the wall's own printed quad already uses) and its TIP corners
  are those points with the girth coordinate pulled toward the centreline by
  the flap's own depth — verified empirically via a vertex dump before
  committing to it, confirming the RSC's two length-flaps meet EXACTLY at
  the centreline with zero gap (W/2 + W/2 = W, by construction). `a6120`/
  `sealend` are DELIBERATELY DEFERRED — each has one real dominant flap per
  end, but its depth is a runtime PARAMETER (`tuckDepth`/`sealFlapDepth`)
  that does not, in general, exactly tile the cap the way the RSC's fixed
  W/2 majors do; giving them `caps` today would mean guessing a board-fill
  for the leftover, so they keep the plain board cap `packArtGeometry`
  already had. Property 4 (perforation keeps the leftover artwork, cut on
  the real arc, not a rectangular approximation): `perf3d.js` gained
  `perfRemovedGeometry`/`perfRemovedBody`, the exact geometric complement of
  the existing `perfBodyGeometry` — both read the SAME single source
  (`geo.perf.path.panels[i].pts`, `core/perf.js`'s own polygonised profile),
  never re-deriving an approximation. **NOT YET WIRED into any live scene
  consumer** — `fold3d.js`/`hierarchy3d.js`/`shelf3d.js` still only call
  `perfDisplayBody`; the removed piece exists and is tested but nothing
  renders it yet. Explicit, reported scoping decision, not a silent gap.
  The FIXTURE (`test/artworkmapping.test.html`) paints a capital "F" — the
  standard orientation-test glyph, no reflection or half-turn maps it onto
  itself — per declared region in its own colour, with a calibration pin
  (runs FIRST) proving the painted canvas is actually chirally asymmetric
  before any mapping pin trusts it. The hardest bug was in the TEST, not the
  code under test: `packArtGeometry`'s wall/cap quads are UNSUBDIVIDED (four
  corner vertices, no interior points), and every box corner is the
  physical meeting point of TWO OR THREE separate, unwelded quads (a wall
  and its neighbour; a cap flap's crease and its own wall) — sampling "the
  nearest vertex" to a corner-adjacent point is genuinely TIED between
  those duplicates, and ties resolve by build order, not by which face you
  meant. A first attempt (single nearest-vertex, then check "which region"
  it lands in) silently picked the wrong duplicate — the FRONT ANCHOR pin
  read a SIDE wall's corner and still "passed" once, by coincidence (the
  crease v-value happens to be identical across all four walls, so a wrong
  face's vertex can carry a numerically correct v and mask the bug). Fixed
  by `verticesNearMM` (returns EVERY vertex within tolerance, not one) plus
  matching against the SPECIFIC expected (u,v) value at that corner (derived
  once, by hand, from `packArtGeometry`'s own construction) rather than "any
  vertex in the right region" — region-membership alone cannot even catch a
  MIRRORED flap (both a flap's true corner and its mirrored one sit inside
  the same region's bounding rectangle; only the exact endpoint value
  differs), which is why the mutation pin for this property checks the
  numeric value, not category membership. A second, smaller instance of the
  same boundary problem hit the region-classification (not vertex-finding)
  step: a crease point sits EXACTLY on the wall/cap boundary in template
  space too, and a rasterised `fillRect` does not paint its own far edge —
  fixed by nudging a fraction of a mm into the cap's own interior (both u
  and v) before classifying or sampling the canvas, never checking the
  boundary line itself. TRAY: property 1 is vacuous (no manufacturer joint —
  reported via `inapplicabilityReason`, not silently skipped) but properties
  2 and 3 DO apply, per the task's own instruction, and needed their own
  FLAT-style variant rather than reusing the tube checkers (a tray has no
  `am.faces` girth walk at all — `flat:true` opts it into a different
  mechanism). `flatCanvasMatchesDieline` checks the template canvas is
  LITERALLY the blank's own bbox (no independent scale factor to drift);
  `printPanelIsRealWall` checks `meta.print`'s four corners are literal
  VERTICES of the style's own `cut` polygon — the tray's print panel is
  bounded by knife-cut corner SLOTS, not by creases, so this reads `cut`
  where the tube check reads `crease`, the correct boundary for THIS
  panel's own construction. Both are exhaustible (any future `flat:true`
  style is automatically covered) and both are mutation-tested. Full
  regression: `golden.json` 998/998 unchanged (no geometry changed, only
  which panels get printed vs board-capped, and a fold-flat cap derivation
  from data that already existed), every other suite green except the
  pre-existing `saveload.test.html`/`uisync.test.html` limitations already
  documented above (unrelated files, confirmed untouched by this task).
- **RESOLVED (carton-artwork task): the printed cap generalised from "flaps
  that tile exactly" to "whatever the flaps reach, board for the rest" — and
  the bug that made every printed lid look unprinted was in the TEXTURE, not
  the geometry.** `a6120` and `sealend` were deferred by the artwork-mapping
  task above on the reasoning that their dominant flap depth is a runtime
  PARAMETER and "does not, in general, exactly tile the cap... giving them
  `caps` needs a board-fill for the leftover, deliberately deferred rather
  than guessed at." Re-examined, that leftover was never a guess: the flaps'
  own folded footprint determines it exactly, and — the load-bearing point —
  the leftover is UNPRINTED either way, because the only panels that ever
  carry outward cap artwork are the dominant ones a style already declares
  (an RSC's majors, a tuck panel, a seal flap); the dust/minor flaps beneath
  them are plain board, indistinguishable from the board cap `packArtGeometry`
  already drew. So "which unprinted panel is in the gap" is a distinction with
  no visual consequence, and the fill is derivable, not invented.
  `printedCap` now RETURNS the girth interval each flap actually covers,
  unions them, and fills any gap with a plain board RECTANGLE (`boardStrip`,
  group 1) spanning the full extrude-axis width — computed in the renderer
  from the flaps' own geometry, never declared by the style. A style that
  tiles exactly produces no residual and is bit-identical to before, which is
  why `fefco201` needed no change at all. `a6120` declares ONE flap per end
  (the tuck panel, face 2 at top / face 0 at bottom — the same panel
  `closure.top` already marks `holdsLid`), depth clamped to `min(T, W)` so a
  panel deeper than the box cannot overshoot the far wall; the tab is
  deliberately NOT part of the quad, since it folds DOWN inside the cavity,
  off the cap plane entirely. `sealend` declares TWO, and the interesting part
  is that they ALWAYS tile exactly: the seal flap glues down OVER the major,
  so the major's VISIBLE depth is only `W - sealVisible`, and
  `sealVisible + majorVisible === W` by construction for every overlap >= 0
  (pinned, not assumed). Both clamps are exercised by mutation pins — a
  3x-too-deep tuck clamps to exactly W, and an overlap so large the seal alone
  reaches the far wall drops the major ENTIRELY (length 1, not a degenerate
  zero-depth quad).

  **The render bug was `composeArtCanvas`, and it predates all of this.**
  `defaultFit()` returns `fit: 'stretch'`, and `artRect` reports that to the
  2D dieline overlay as `preserveAspectRatio="none"` — a stretch. The 3D
  compositor checked `fit === 'none' || !fit` and so sent 'stretch' down the
  meet/CONTAIN branch: the dieline stretched while the texture LETTERBOXED,
  breaking the module's own stated promise that "2D and 3D show one picture."
  The bars that letterboxing leaves sit at the v EXTREMES — which is exactly
  where a cap flap samples — so a correctly built, correctly UV'd printed lid
  rendered as blank white backing, and (on a blank whose aspect differs enough)
  a wall could too. Invisible until now for the reason such things always are:
  before caps existed nothing sampled those rows, and `fefco201`'s own caps had
  never been driven with a real upload, only with pins that read UVs. Fixed by
  making 'stretch' take the stretch branch. Pinned at the PIXELS rather than
  the branch — a source image whose aspect deliberately differs from the blank,
  composed, then sampled at each flap's TIP (its v extreme) and at all four
  corners; the paired mutation pin runs the REAL letterbox branch (by asking
  for `fit: 'fit'`) and asserts it leaves that same row blank, so the stretch
  pin is proven capable of failing rather than merely not obviously trivial.
  Sampling 2mm from the CREASE end instead read clean under letterboxing
  (measured — the bars are ~43mm of template on the RSC blank and the crease
  end sits well inside them), which is the "confirm the specimen" rule again:
  the first version of the mutation pin was pointed at a row the bug does not
  touch. VERIFIED IN THE REAL APP, not just in pins: artwork uploaded through
  the actual file input, at the actual carton level, viewed at real rendered
  size — a6120's lid prints continuously with its walls once the tuck depth
  can span the cap, and sealend's shows its major and seal flaps meeting along
  the centre seam with the template's own panel text legible and unmirrored.
  Full regression: `golden.json` 998/998 unchanged, every suite green except
  the 4 pre-existing `saveload` `cornerPost` failures documented above.
- **RESOLVED, WITH A REACHABILITY CAVEAT (flow-wrap end-seal task): the crimp
  now has a derived girth mapping — but the path it fixes has no live consumer
  today, and the path users DO see was already correct.** The declaration gap
  was real: `flowwrap.js` gave each girth band a full template rect and then
  declared the crimps as EXTENTS only (`ends: [{u0, u1}]`, no `v`), so nothing
  downstream could map the seal — the information wasn't there. `finPlies`
  (render/artwork3d.js) fills it by DERIVING, never authoring: it folds the
  section polyline at the mid-plane of a newly DECLARED `flattenAxis` and reads
  each half-girth straight off the bands' own `faces[].v` breakpoints. The
  flatten axis is stated, not inferred, because which way the tube collapses is
  a machine fact (jaw orientation relative to the fin seal) and a square — or
  round — section carries no hint of it. Cutting at z=0 folds each SIDE band at
  its own midpoint, which is what puts one ply on the shopper's face and the
  other on the rear seam. Hand-verified on the default wrap (L90 W50 H120):
  cuts at v=95.5 and v=265.5, the shopper ply spanning exactly girth/2 with
  FRONT's own midpoint (v=180.5) landing on the fin centreline, and the seam
  landing there too for the far ply. THE FAR PLY IS TWO RUNS, not one: it is
  contiguous around the tube but the template cuts the girth at the seam, so a
  consumer that assumes one run per ply drops half of it. IDEALISATION, stated
  rather than hidden: a half-girth of film is gathered into a flat width of
  only `fw` — real film pleats at the corners — and each run is stretched
  uniformly over its share instead of modelling the pleat.

  **CHIRALITY: there is none in v, and that is the finding.** The two crimps
  mirror in u (the blank's edge is u=0 at one end and u=canvas.w at the other,
  already in the data) but NOT in v: v is a MATERIAL coordinate, so the film at
  a given point of the tube carries the same v whichever end you look at. The
  risk the task flagged is real all the same — it enters if a builder assigns
  UVs by CORNER ORDER instead of by world position, which silently negates the
  across-coordinate at the far end. Positions are therefore built from world
  across-coordinates at both ends, and the mutation (`dir > 0 ? -a : a`) was run
  against the real renderer: it mirrors the trailing fin and fails both the
  chirality and continuity pins, exactly as the task predicted.

  **BLEED was doing nothing.** `ends` u-ranges are the SEAL (`bleed`→`sealEnd`),
  so a fin drawn u0..u1 stops precisely where the bleed starts. Added
  `printU0/printU1` — the film's full printed extent out to the blank's own edge
  — and the renderer draws that, so the bleed prints OUTSIDE the seal boundary
  where bleed belongs. `u0/u1` are untouched, because hierarchy3d.js's pillow
  reads them.

  **THE CAVEAT, and it is the important part.** `packArtGeometry`'s fin — the
  thing this task fixes — is UNREACHABLE in the shipped app. Three paths, all
  checked: the FOLD view is behind `FOLD_VIEW_ENABLED = false` (app.js); the
  hierarchy's instanced children explicitly exclude wraps
  (`else if(childKind !== 'wrap')`, hierarchy3d.js); and the shelf always builds
  a wrap from `closedWrapParts`. Every wrap a user can see is the PILLOW, whose
  crimp tab already reads the crimp ring's own v via `crimpVLookup` — correct,
  two-ply, mirror-aware, and carrying the doc comment describing the very bug
  ("used to stretch the whole canvas height (0..1) across its width") that
  artwork3d's fin still had. So the symptom the task predicted was real and was
  exactly where it said, but in dormant code. Verified by rendering
  `packArtGeometry` standalone with per-band colours: the fin reads
  side-half → FRONT → side-half, centred on FRONT. NOT rewired into the pillow:
  `finPlies` gives an idealised FLAT two-ply split while `crimpVLookup`
  continues the ramp's progressive gather onto the tab — related facts, not the
  same one, so collapsing them would be wrong rather than DRY. The two-
  computations smell is noted here deliberately; if the fold view is ever
  revived, that is the moment to re-examine it.
- **RESOLVED (display-state render task): three faults from one report — a
  transparent-looking board, a torn-open pack standing empty, and a girth
  basis that never followed its product.**
  1. **Only the OUTER face is printed.** `perfBodyGeometry` put the outer
     face, the INNER face and the torn edge all in material group 0, so the
     art material clad the cavity too and a display-state pack read as if the
     board were transparent — the front panel legible, MIRRORED, on the inside
     of the far wall. Split: group 0 is the outer face alone; group 1 (board)
     takes the inner face, the torn edge and the floor. `perfRemovedGeometry`
     got the same split, for the same reason. The backing material is
     whatever the caller passes as material 1, so the white-lined board the
     user asked about later is the same call with a different material, not a
     new code path.
  2. **A pack torn to display state is an OPEN pack, so it shows its
     contents.** `showContents` already read "an OPEN tray or a SHRINK pack
     reveals its contents in BOTH modes; only a closed box hides them" —
     display state belongs in that list by the same reasoning (everything
     above the tear is gone), so it joins the existing rule rather than
     getting a branch of its own. Carton and case both. FIRST ATTEMPT WAS
     HALF A FIX and the screenshot proved it: routing to `buildContainer`
     gained the sleeves and LOST the artwork, which is the very complaint the
     report made about Cutaway. Cause: `buildContainer` built its shell with
     `tier.mat` — plain board — and never `tier.art`, which the tier has
     carried all along for its instanced-on-the-pallet case. The opened shell
     now clads itself exactly as `soloClosed` does, so a printed pack keeps
     its print in BOTH modes, and Cutaway gained the graphics it had also
     been missing.
  3. **`girthBasis` is AUTO by default and follows the product.** It had only
     ever been demoted (an explicit 'round' fell back to rectangular when the
     chain stopped being eligible) and never promoted, so a round on-edge slug
     kept a rectangular girth unless the user found the control. Added 'auto'
     as a third choice AND the default, resolved at the one existing site in
     `solvePrimaryStage` against `resolved.kind` — the fact
     `resolveWrapContents` already decided. Resolved on the COPY `wp`, so the
     stored choice stays 'auto' and keeps tracking the product; an explicit
     pick still wins, which is what keeps this a default and not a forced
     derivation. Checked first that no consumer builds the wrap from raw
     params (everything goes through `levelGeometry` → the resolved row), or
     an 'auto' sentinel reaching `flowwrap()` would have silently computed
     rectangular — a sentinel leaking into a style is exactly the silent
     wrong-default this codebase keeps re-learning.

  PINNED vs SEEN: (1) and (3) carry pins with mutations — the cavity-side
  check reconstructs the one-group arrangement and proves it would fail; the
  girth pins prove auto fires, that an explicit pick overrides it, and that a
  non-eligible collation still lands rectangular. (2) is verified by
  SCREENSHOTS through the real UI, not by a pin: the wiring rule in this file
  says a rendered-tree read is what tests wiring, and that lives in
  `uisync.test.html`, which cannot run to completion in this sandbox. Stated
  rather than papered over with a builder-level pin that would pass whether
  or not the app calls it.

- **RESOLVED (merged-strip task): the chain strip and the level rail were
  never the same LIST, which is why deduplicating them was a correctness fix
  and not just tidying.** Diagnosis first, because the obvious one is wrong:
  the STATE was already single (`activeLevel`, one writer) — there was no
  desync bug to hunt. The defect was in what each control ENUMERATED. The
  chain strip carried ONE interlayer slot with a None/Tray/U-board mode
  selector — exclusivity visible in the control itself, which is the whole
  point of `project.interlayer` being an enum. The rail re-expressed the same
  slot as two SEPARATE PEERS (Tray, U-board), so it offered a selection the
  model has no state for: view the U-board while the tray is the live
  interlayer. And there was a THIRD selector nobody's brief mentioned — a
  `<select id="style">` in the header — plus the 3D depth tabs (`#d_*`) in
  `#scopeBar`, four controls onto one fact. The trailer, meanwhile, was in the
  rail but absent from the strip.
  **The fix**: ONE strip, the chain strip as the base. `#style`, its wiring,
  and every `#d_*` tab and its three `LEVEL_ORDER.forEach` sync loops are
  gone. **Interlayer selection FOLLOWS THE MODE rather than being a second
  tab**: `setActiveLevel` coerces `tray`/`uboard` to `project.interlayer` at
  the point of selection (and returns early on `'none'` — nothing in the slot
  to view), so the nonsense state is unrepresentable rather than merely
  discouraged. Mutation-tested exactly as specified: restoring a direct
  `activeLevel = 'uboard'` path lands the app on U-BOARD while the interlayer
  is TRAY; with the guard it lands on TRAY.
  **The trailer is a CONSUMER, drawn as one**: appended past a `╎` divider
  (not a chain arrow), dashed border, quieter key, no style label, no enable
  toggle, no re-point note — selectable, but visibly not a member. Being
  outside the chain is a reason to DRAW it differently, not a reason to make
  the user find it somewhere else. Its pin checks all four: present and
  selectable, `.cs-consumer`, no toggle, and still absent from the cost
  roll-up.
  **ENABLE/DISABLE existed twice** (the strip's `in chain` chip and a "Disable
  <level>" button in the detail panel) — the strip's chip is the survivor,
  because membership is READ at a glance on the strip, so it should be CHANGED
  there. `mountEnableToggle` now empties its host rather than rendering the
  second control. Asserted BY COUNT (`#cs-tog-<level>` is exactly 1 and
  `#tierToggleBtn` exactly 0 per level), not by behaviour, so a reintroduced
  duplicate fails even if both copies happen to agree that day.
  **Two densities, one element**: the 860px query changes only how a node
  renders (inactive nodes collapse to the level name; the active one keeps its
  style sub-label and chip), never which nodes exist — the DENSITY pin asserts
  the node LIST and every level's operability are identical at 1400 and 430.
  A second narrow-only defect surfaced from the screenshots, not the pins:
  the strip is one scrolling row there, so the ACTIVE node can sit off-screen
  — on first load (the default level is CASE, five nodes in) as readily as
  after a click. Reachable by click and invisible is not reachable when this
  is the only level selector, so `renderChainString` nudges it into view
  (only when the row actually overflows; wide is untouched). Its pin carries
  a FIXTURE CHECK that the narrow strip overflows at all, or it would be a
  vacuous pass at any width where the row fits.
  **Two behaviours had to be RECONCILED, not just deduplicated**, because the
  two dead controls disagreed. (1) The depth tabs reset `hierSel` (the opened-
  index cascade) on a level change and `#style` did not, so which control you
  reached for decided whether a stale open channel carried across depths — the
  reset moved into `setActiveLevel`, which is the first time the trailer
  rail's own comment claiming it happens "on a level switch" is actually
  true. (2) The depth tabs forced `mode3d = 'hier'` and `#style` did not;
  `#style`'s behaviour won, because Fold-vs-hierarchy is a VIEW setting living
  in the render rail, and a level pick that silently cancels it makes that
  toggle un-sticky. Scope and view stay orthogonal.
  **The vertical budget, honestly**: the brief expected a recovered band above
  the canvas, and the first measurement showed NONE (1400px: canvas top 298px
  before and after). Cause: `.depthsel` lived in `#scopeBar`, which still
  exists for the candidate navigator, and `#style` sat in an already-wrapping
  header row, so removing both freed nothing. Fixed by making the now-single-
  purpose bar FOLLOW its only remaining content: `updateCandidateCycle` is its
  one writer, and it collapses where there is no candidate list. Measured:

  ```
                    1400px                430px
    depth      before   after        before   after
    case         298      298          364      362     (navigator populated)
    carton       298      243          364      307     (navigator empty)
  ```

  So the band is 55px, recovered at product/wrap/carton/trailer depth and NOT
  at case/pallet, where the row is still earning its height. Stated as
  measured rather than as the brief anticipated. `setView` reaches that writer
  via `apply3dMode()`; it also sets the bar to `none` directly for a non-3D
  view so a short-circuit can never leave it up.
  **A pre-existing crash surfaced** while writing the reachability pins:
  `mountTray`'s `bindAuto` bound `colDivider` unconditionally although that
  field is only rendered once the tray has more than one pocket per row, and
  the resulting throw inside a `forEach` took every binding AFTER it with it.
  Confirmed identical on baseline via `git stash` (not caused by this task),
  then guarded. This is the "a pin that drives it the way a user does" rule
  paying out: no builder-level pin would have reached it.
  Full regression: `golden.json` 998/998 unchanged (enable/disable round-trips
  bit-identical — a selector merge touches no geometry), every suite green
  except the four pre-existing `saveload` `cornerPost` failures and
  `uisync.test.html`, which fails at import on the BASELINE too in this
  sandbox (same `pageerror`, confirmed by `git stash`) — its skeleton was
  migrated off `#style`/`#tierToggleBtn` regardless, per this file's own
  harness rule.
  **Sequencing**: this landed BEFORE the render-controls placement work by
  design, since it changes what "scope controls" means — `#scopeBar` is now
  the candidate navigator alone, and that prompt should be re-read against
  this state rather than run against the four-selector one.

- **RESOLVED (interlock-schedule fix): interlock is a RELATIVE property, and
  the rail's "every layer above" rule was writing it as an ABSOLUTE one.**
  `layerFlips[ly]` is whether layer `ly` takes the 180° turn — an absolute
  orientation — but what interlocks a load is CONSECUTIVE LAYERS DIFFERING.
  `layerFlipsFromRule`'s `tail` mode set every layer from k up to `true`,
  which reads like "interlock them all" and is exactly wrong: they then share
  ONE orientation, so only the k-1/k boundary interlocks and everything above
  is a column again — the reported symptom precisely. It now ALTERNATES from
  k. `single` was always right and is untouched: one flipped layer differs
  from both its neighbours, which is what "interlock that one layer" means.
  **The pin's SHAPE mattered more than usual here.** A pin asserting "every
  layer above k is flipped" would have PASSED the bug maximally and read as a
  green confirmation of it, so every pin in `test/interlock.test.html`
  asserts the RELATIVE property instead. The geometry block proves the two
  are not the same claim by showing an all-flipped tail producing layers that
  are position-for-position IDENTICAL — the bug stated geometrically, which
  is what makes the rail pins' choice of assertion legible rather than
  arbitrary. Mutation-tested: restoring flip-all fails exactly the three tail
  pins and nothing else.

- **RESOLVED (top-and-bottom-caps task): the load's outer footprint had no
  single owner, and building the fourth contributor was the moment to make
  one.** Survey first, and it found worse than duplication: FIVE independent
  `2 x caliper` additions over THREE different starting rectangles.
  `trailer.js` grew the PALLET DECK; `palletpatterns.js`'s overhang check and
  both render paths (`palletmesh.js`, `hierarchy3d.js`) grew the CASE-STACK
  ENVELOPE — so the trailer packed its floor on `deck + 2t` while the posts
  were DRAWN at `caseEnvelope + 2t`. `loadFootprintStagesMM(cases, project)`
  is now the one place, returning all three stages by name — `.cases`,
  `.posts`, `.cap` — each nesting the PREVIOUS one rather than re-deriving
  from the cases, which is exactly the mistake that lets a later contributor
  land inboard of an earlier one. Returning every stage rather than only the
  outermost is what lets the cap take `.posts` as its centre panel (a cap
  goes OVER the posts) without a second computation. **WHICH rectangle a
  caller starts from is deliberately NOT answered there** — it takes the base
  as an argument, so the deck-vs-envelope disagreement, which predates caps,
  is consolidated without being silently changed.
  **THE BLANK is a plus, and the relief choice is stated.** Centre panel,
  four flaps, four corner squares removed, four creases, bounding box
  `(cL + 2x) x (cW + 2x)`. With the squares removed exactly the folded flaps
  interfere by about a caliper; of the two fixes this TRIMS THE FLAPS by
  `relief` at each end (default one caliper, `null` = auto, an explicit 0
  surviving as a real choice) rather than enlarging the cutout, because
  trimming leaves the bounding box — the number a supplier quotes a sheet
  against — untouched while still opening a real gap (2 x relief, both flaps
  giving up their share). Drawn at the PALLET level, which previously said
  "no dieline here": a cap is a real rigid blank, so it goes through the SAME
  style-agnostic `draw2d()` every carton/case dieline uses (a plus is just a
  20-vertex `cut` polygon; the renderer needed no change) and through the
  SAME generic `downloadDXF`, the U-board's own precedent.
  **THICKNESS YES, STRENGTH NO, and the pin for it had to be rebuilt.** The
  first version called `stackAnalysis` twice with identical arguments, which
  proves nothing — it is the same call, and a real strength credit added
  inside `bct.js` would sail past it. Replaced with two that can actually
  fail: a STRUCTURAL one reading `bct.js`'s own source (no import of cap.js,
  no cap-shaped parameter in `stackAnalysis`'s destructured list) and an
  END-TO-END one reading the RENDERED BCT readout with a BOTTOM cap on — the
  right probe precisely because a bottom cap adds no compression load either,
  so any movement at all is a strength credit that should not exist. A top
  cap would move the ratio legitimately through tare and could not
  distinguish the two.
  **WEIGHT IS ASYMMETRIC, which is the reason it routes through the tare path
  instead of being a flat term.** A top cap sits ON its load's cases and bears
  on that load's own bottom case (so top caps count n times, including the
  bottom position's); a bottom cap sits UNDER them and bears on nothing within
  its load (so bottom caps count n-1, excluded at the bottom position for
  exactly the reason its base is). Total load weight counts BOTH at every
  position — a different question, and the comment says so, because "what
  bears on the bottom case" and "what the trailer carries" are two facts one
  number cannot hold.
  **FOUR MUTATIONS RUN AGAINST THE REAL SOURCE, and the first one exposed a
  hole.** Charging the bounding rectangle in `decorateRow` PASSED all 29 pins:
  the area pin compared `capPlusAreaMM2` to its own formula and to a
  `materialCost` call the test made itself, so the quantity the app actually
  CHARGES was completely unwatched — the "a pin that calls the builder says
  nothing about whether the app calls it" rule, hit again one level up. Fixed
  by anchoring the row's charged area to the DRAWN blank's own
  `meta.plusAreaMM2` (a different call path, reached by the 2D view and the
  DXF), so the two consumers of one fact must agree; the mutation then failed
  immediately. The other three were caught first time: a bogus cap term in
  `stackAnalysis` fails the structural pin, treating the bottom cap like the
  top fails four pins (including the rendered BCT, which showed the phantom as
  `+ 0.3 lb tare`), and nesting the cap off the bare cases fails three.
  **`postOverhang` became `loadOverhang`, and its readout names its causes.**
  Posts were the only contributor when it was written; a cap standing proud
  and being reported as "corner posts stand proud" is a readout lying about
  its own cause, and the note also had to move OUT of the posts-off early
  return or a capped load with no posts would have been silenced entirely —
  the same expiring-scope shape the `outerFlaps` entry above records.
  `opts.postCaliperMM` became `opts.outboardMM` and now carries the TOTAL
  per-side growth (the doubling moved to the summing side with the name).
  **DELIBERATELY NOT MODELLED, stated rather than left ambiguous:** a bottom
  cap really does distribute load across a pallet's deckboard gaps. There is
  no deckboard-gap model to hang it on, and inventing a strength credit is
  what `bct.js`'s own disclose-don't-apply rule exists to prevent — so it is
  disclosed in the rail note instead, and a pin asserts that disclosure is
  present. The COST assumption is stated the same way: the plus is charged,
  and if the corner squares are lost in the trim rather than recovered as
  scrap the true sheet cost is the bounding rectangle and this figure is
  optimistic by that difference.
  **Density is 150 kg/m³, not the post board's 700.** A 48x40 cap at 3mm comes
  out ~1.2 lb, the order of magnitude a real corrugated cap weighs; borrowing
  the post's laminated-stock density would have made it five times that, and
  a pin holds the figure between 0.5 and 3 lb so a later "tidy the densities"
  edit cannot quietly restore it.
  **A unit round-trip was caught by the drawing, not by a pin.** Caliper and
  relief were being committed through the PALLET unit (inches), so 3mm
  round-tripped to 2.9972mm and the blank's own caliper label read
  `t 2.9972mm`. They are mm-native now, matching their labels; skirt depth
  stays in the pallet unit, being a load-scale dimension alongside deck height.
  Full regression: `golden.json` 998/998 unchanged (caps off is bit-identical
  by construction — an absent `cap` key reads as all-defaults, which is both
  caps off, so no schema migration was needed). Every suite green, and the
  four long-standing `saveload` `cornerPost` failures are FIXED rather than
  inherited: they asserted the whole `stack` object in migration pins whose
  subject is `positions` alone, so every later default added beside them
  (cornerPost, then cap) broke a fixture that never tested it.

- **RESOLVED (typography task): monospace was doing the job of a UI font, and
  the web fonts were not loading at all.** Two findings, one of them
  invisible until it was measured.
  **(1) The ratio, not the families.** Of index.html's 52 `font-family`
  declarations, 44 were `--mono`: section headers, every field hint, help
  prose, select values, toggle labels. DM Mono was carrying the interface,
  which is what made a packaging tool read as a terminal — and it cost real
  width, not just taste. Measured at the same size: the hint string "derived
  — solved from the carton" is 212px in DM Mono against 185px in Inter (13%),
  which is why hints wrapped to two awkwardly-centred lines and the style
  select truncated mid-word at `FEFCO 201 Regular Slotte(`. The tokens now
  carry TWO ROLES and the split is the rule, stated at `:root`: `--sans`
  (Inter) is ALL LANGUAGE — anything a person reads as words; `--mono` (IBM
  Plex Mono) is OUTPUT AND EXPORT ONLY — drawing sheets, dimension callouts,
  the title block, the build id, exported PNG/SVG. 41 declarations moved; 3
  stayed. Every one was classified individually rather than blanket-replaced,
  because "is this output?" is a judgement a regex cannot make.
  **(2) THE FONTS WERE NEVER LOADING.** The browser could not reach
  fonts.googleapis.com at all (`ERR_CONNECTION_RESET`) — so the app had been
  rendering in fallback faces, and every screenshot taken during the
  preceding cap and interlock work was of a design nobody had actually seen.
  A font fallback is SILENT: nothing errors, nothing looks broken, the page
  is simply not the thing that was designed. Reviewing it required
  downloading the woff2 files and serving them locally first. Both families
  are now VENDORED under `fonts/` (185KB, six files — Inter is variable, so
  one 47KB latin file covers every weight), the Google `<link>` is gone, and
  a pin asserts the app requests no third-party font. That also removes the
  `display=swap` FOUT and the question of handing every user's IP to a third
  party to render a form label. **The remaining third-party request is the
  three.js CDN script** — pre-existing, out of a font task's scope, and noted
  here because the measurement that found the font problem also found it.
  **TABULAR FIGURES, ASKED ONCE.** Monospace was providing digit alignment
  for free at ~40 sites; a proportional face has to be asked. Asked on
  `body`, inherited, rather than at each site — a hand-maintained list of
  "places that show numbers" is precisely the shape this codebase has already
  watched go stale (see `export/png.js`'s own token list, below).
  **`export/png.js` was fetching fonts FROM GOOGLE at export time**, from a
  hardcoded `FONT_FACES` list naming DM Mono and Hanken Grotesk with css2
  URLs — the same hand-maintained-copy-of-a-fact shape that once made this
  exact module ship a stale token list and export every tray drawing with its
  cell lines missing. It now walks the document's own `@font-face` rules, so
  renaming a family or swapping a weight cannot leave the exporter behind,
  and an export made offline embeds the same faces the screen is using.
  `render/sheet.js` had the same smell in miniature (a hardcoded family
  string for a canvas `ctx.font`, which cannot take a CSS var) and now reads
  the live `--mono` token with a literal fallback.
  `export/palletpdf.js` is untouched and correct as-is: it uses the PDF
  base-14 Helvetica, viewer-resident with nothing embedded, and never
  referenced either web font.
  **THE PIN THAT MATTERS IS STRUCTURAL.** Checking that a handful of elements
  resolve to the right family would pass while mono crept back in somewhere
  nobody sampled. `test/typography.test.html` instead reads index.html's OWN
  CSS and asserts every `--mono` declaration belongs to an allowlisted OUTPUT
  selector — a rule that has to be argued with, not a spot check — and
  carries a companion pin that plants a UI-side mono use and confirms the
  walker catches it, so the allowlist cannot pass by returning nothing.
  **THREE OF THE NINE PINS WERE WRONG ON FIRST WRITE, in instructive ways.**
  Two tested for the string `fonts.googleapis.com` in the source and failed
  on a CORRECT file, because index.html and png.js each EXPLAIN IN PROSE why
  the Google link was removed — an instrument reacting to its own subject's
  documentation; they strip comments now. The third tried to verify tabular
  figures with canvas `measureText`, which ignores `font-variant-numeric`
  entirely, so it measured Inter's proportional figures and reported the
  correct, expected difference as a failure; it measures in the DOM now, with
  a `proportional-nums` control proving the comparison can tell the two
  apart. And a fourth was weak rather than wrong: it looked for the literal
  `FONT_FACE_RULE` in png.js, which a behaviour-preserving edit (the numeric
  constant `5`) satisfies just as well — it was testing how the code is
  WRITTEN. It now asserts png.js contains NO font-family literal at all: with
  nothing to name, it has nothing to go stale against. Mutation-tested:
  putting mono back on field hints fails the structural pin; re-adding the
  Google link fails the self-hosting pin; reintroducing a hardcoded family
  list in png.js fails the derivation pin.
  Full regression: `golden.json` 998/998 unchanged (a font change touches no
  geometry) and every suite green.

- **RESOLVED (end-seal continuity + save-slot silence): two unrelated bugs,
  one shared lesson — a failure that looks like a success is worse than a
  failure that announces itself.**

  **(1) The flow wrap's end-seal print tore at one corner, and only one end
  showed it.** `crimpVLookup` (hierarchy3d.js) maps the crimp tab's v from the
  ramp's own girth walk, so the film reads continuously through the crimp
  rather than restarting. Its out-of-range fallback was `|| cands[0]` — the
  FIRST candidate run in walk order. That matters because out-of-range queries
  are NORMAL here: the crimp TAB is built at the pack's full width
  (`crossDim`), while the crimp RING's own extreme sits a few microns inside
  it, because `ringPoints` fillets the corners. So the outermost tab vertices
  at BOTH ends always fall outside every run. `cands[0]` owns the negative-w
  side, so on that side the clamp landed on the right value BY LUCK, and on
  the positive-w side it clamped to that run's far endpoint — the SEAM.
  Measured, +L end, bottom ply: v = 0.9356 where the top ply at the same
  corner read 0.2817, i.e. the back half-band painted across the corner of the
  fin. Fixed by clamping to the run the query is NEAREST rather than the first
  one. **Both ends were equally wrong; only one looked it**, because the two
  tabs are mirrored in world space — so a pin that checked one end would have
  passed on a broken pack, and `test/wrapseal.test.html` runs every pin over
  both plus one asserting the two ends agree outright (v is a MATERIAL
  coordinate: the ends mirror in u, never in v). Diagnosed by dumping the real
  UVs through `closedWrapParts` rather than from renders — three rounds of
  eyeballing an isometric view had been ambiguous, because at that angle the
  far side of a collapsing ramp legitimately shows the opposite end of the v
  ramp. Mutation-tested: restoring `|| cands[0]` fails five pins across both
  ends, including the one that names the user's own words ("the lower ply
  never reads the first back half").

  **(2) "Save to slot" did nothing, silently, on any project with artwork.**
  `safeSet` caught `QuotaExceededError` and returned a bare `false`;
  `saveToSlot` passed it up; the click handler DISCARDED it. Artwork is stored
  in the save file (a few MB downscaled) against a ~5MB origin quota, so the
  button wrote nothing, showed nothing, and left the select reading "(empty)".
  `safeSet` now returns `{ok, reason, bytes}` and both callers act on it, with
  ONE message builder so the slot button and autosave explain the same thing
  the same way and both name the remedy (Save to file — no quota).
  **The autosave half was worse and was found while checking the first.** A
  failed autosave write left the PREVIOUS entry in place, and startup restores
  that while announcing "Restored your last session" — stale work presented as
  current, with no way for the user to notice. It now clears the stale entry
  and says autosave is off, once. Losing a restore point is bad; silently
  restoring the wrong one and calling it the right one is data loss with a
  reassuring label on it.
  **The fixture had to be corrected twice, and the fixture check caught both.**
  Filling the real quota does not work in this harness — headless Chromium
  accepted 100MB of ballast without complaint, so the slot saved anyway and
  every pin reported a false green. Injecting `QuotaExceededError` at the
  `setItem` boundary is both deterministic AND the more honest instrument:
  the defect was never in detecting a full disk, it was the caller discarding
  a failure the storage layer had correctly reported. A pin calling
  `saveToSlot` directly would have passed throughout — these drive the real
  button. Mutation-tested: discarding the result again fails three pins;
  keeping the stale autosave fails the staleness pin.
  Full regression: `golden.json` 998/998 unchanged, every suite green.
- **RESOLVED (drawings-not-exporting task): of the three export formats, only
  the artwork SVG template was actually broken — and it was broken two ways,
  plus a third, unrelated crash found by testing it.** DXF (`export/dxf.js`
  transcribing `geo.cut`/`geo.crease` into CUT/CREASE layers) and the 2D PNG
  (`export/png.js` rasterizing the on-screen dieline SVG, which draws both
  arrays unconditionally) were both confirmed correct and left untouched —
  verified by reading the real exported/rendered content (DXF entity counts,
  the on-screen SVG's own `innerHTML`), not by re-deriving what they should
  contain. The bug was in `export/artwork.js`'s `buildArtworkSVG`, the app's
  only SVG-format export (behind "Artwork SVG" and the artwork panel's own
  SVG/PNG buttons — PNG builds this SVG internally, then rasterizes it).
  (1) Its "blank outline" was a `<rect>` over `geo.bbox` — the BOUNDING BOX,
  never the die. A6120's back panel has no top flap at all while its side
  panels' dust-flap sweeps and front tuck reach well past it; sealend and the
  FEFCO 0300 tray are similarly irregular. The rectangle there was not a
  simplification, it was a DIFFERENT, LARGER shape inviting a designer to
  paint into a corner the die does not have. (2) Fold guidance came ONLY from
  `geo.meta.refLines`, a field that exists SOLELY because flowwrap's own
  `crease` array is genuinely empty ("film is never scored") — every RIGID
  style (FEFCO 201, A6120, sealend, the tray) has real creases in `geo.crease`
  that nothing here ever read, so every one of those templates shipped with
  ZERO fold lines despite the sheet's own printed legend claiming "dashed =
  fold reference". Fixed by drawing a `<polygon>` from `geo.cut` — the SAME
  array DXF and the on-screen dieline already draw, so the template can never
  show a different picture than the file it's meant to register against —
  and falling back to `geo.crease` for fold lines whenever `refLines` is
  empty: not a new source, the one that was always there.
  **A third, unrelated crash surfaced from testing the fix, not from the
  report**: `geo.meta.film` is truthy for BOTH flowwrap
  (`{webWidth, cutLength, ...}`) and shrinkbundle
  (`{surfaceM2, filmAreaM2, drawdownPct, opacityPct, girth, massPer1000g}`) —
  two unrelated shapes sharing only `filmAreaM2`/`massPer1000g`. A bare
  truthiness check on `f` (both in the header-line builder and in
  `filmSpecText`, the "Copy film spec" button) read shrinkbundle's film as
  flowwrap's and called `fmtLen` on its nonexistent `webWidth`, throwing —
  silently breaking THREE buttons (`btnArt`, the artwork panel's SVG/PNG, and
  `btnSpec`) for any shrink-bundle project, all reachable since they're gated
  on `structure === 'flexible'`, which both flexible styles satisfy, and none
  of the click handlers have a try/catch. Fixed by branching on
  `geo.meta.style === 'flowwrap'` — the discriminant both styles already
  declare — rather than on the shape of a field they happen to share the name
  of; `filmSpecText` gained a genuine shrinkbundle-shaped branch reporting
  its own fields (girth, drawdown, opacity) instead of guessing at flowwrap's.
  `test/artworktemplate.test.html` holds all of this at the RENDERED string
  (real `<polygon>`/`<line>` counts and vertex values from the real exported
  text, never re-deriving `geo.cut`/`geo.crease`'s own shape), with a FIXTURE
  pin proving A6120's die is genuinely non-rectangular (an independent
  shoelace-area check) before trusting any pin built on that assumption, an
  EXHAUSTIVE sweep over the whole style registry, and a DOM-driven
  REACHABILITY block that drives the real "SVG" button in a real loaded app
  and intercepts the actual downloaded Blob via `URL.createObjectURL`, so a
  passing unit-level check can never stand in for "does the app actually call
  this". Mutation-tested three ways, each restoring the fix afterward:
  reverting to the old truthy `f` check re-crashes both the header line and
  `filmSpecText`, caught immediately; reverting the outline/fold-line fix to
  the old `<rect>` + `refLines`-only code fails all 16 outline/fold-line pins
  while the fixture and crash-fix pins stay green (proving those two failure
  classes are independently covered). Full regression: every runnable suite
  green (`golden.json`'s own harness, `verify.html`, times out in this
  sandbox exactly as it does on an unmodified baseline — confirmed via
  `git stash`, unrelated to this change, which touches no geometry code at
  all), including `explode.test.html`/`uboard.test.html`, whose identical
  timeout was likewise confirmed pre-existing.
- **RESOLVED (fragile-text task): "print text" is dead everywhere except one
  renderer that kept drawing it.** Reported as "Fragile is still shown on the
  2D dieline view... even though this does not impact the 3D render." The
  literal word is nowhere in a fresh project — `project.printText`'s default
  has been `''` since the artwork-mapping task — and the `#txt` control that
  used to set it is not merely hidden, it is entirely unwired: nothing in
  `app.js` reads `el('txt')` at all any more. So no live project can type
  this in today; what the user was seeing is a value carried over from an
  OLDER SAVE (confirmed against real ground truth: `test/fixtures/v1/
  full-chain.pkg.json`, a v1 migration fixture predating the empty default,
  has `project.printText === "FRAGILE"` verbatim). `persistence.js` still
  round-trips the field on purpose (old saves must still deserialize), and
  `dieline2d.js`'s `draw2d()` was still drawing it in solid black text
  whenever present — the one place a value that can no longer be SET through
  the UI was still visibly showing up. The 3D fold view already reads as
  effectively dead for this: index.html's own control comment says printed
  text "doesn't read" there now that materials are translucent, matching the
  user's observation that 3D was unaffected. Fixed by making `draw2d()`
  unconditionally never draw print-panel text — not "suppressed when artwork
  is present" (the first fix attempted, and mutation-tested before being
  discarded: it would have left `printText` showing on a legacy save with no
  artwork uploaded, which does not satisfy "gone from all 2D dielines"). 3D
  is untouched — `buildBox()` still bakes `printText` into the kraft box's
  material — since the report was explicit that 3D was not the problem.
  `printText` stays a parameter of `draw2d()` (accepted, now unused) rather
  than a signature change, so the one production call site (`app.js`) and
  six pre-existing calls in `uisync.test.html` need no touching for a
  display-only decision. Verified against the REAL legacy fixture through
  the real UI, not just the pure function: loading `full-chain.pkg.json` via
  the actual "Load" button and checking the rendered carton/case 2D `<svg>`
  for the literal string confirms it is gone (screenshotted). `test/
  printtext2d.test.html` holds this at the rendered SVG string, per style
  (fefco201/a6120/sealend/flowwrap — wraps, cartons and cases all share this
  one renderer) x with/without a real uploaded-artwork image, so the "was it
  conditional on artwork" question the first fix attempt got wrong stays
  pinned open. Mutation-tested: restoring the old unconditional-draw code
  fails 13 of 14 pins (only the artwork-layer-itself fixture check survives,
  as expected — it asserts a fact the mutation never touches).
- **RESOLVED IN PART (wrap-facing task): a wrap opened inside a shelf's
  cutaway carton/case now presents ITS OWN front, not the carton's.**
  Reported as "for wraps in carton on shelf, the render shows the packs
  facing the wrong way when looking at the cutaway," alongside a broader
  "ensure wraps in carton/case are oriented with the correct end up... when
  graphics are applied." Reproduced with a real diagnostic per-band texture
  through the real UI before touching any code: the cutaway carton's one
  opened wrap showed a DIFFERENT, mirrored band of the print than the exact
  same wrap shows correctly at plain carton depth (no shelf) — the fixture
  and both screenshots are the specimen-confirmation step, not assumed.
  ROOT CAUSE: `buildContainer`'s wrap-child branches (both the closed
  instances and the one opened/cutaway child) draw a wrap at
  `orientQuat(pl.orientation)` — its TRUE pose relative to the CARTON's own
  local frame, correct and untouched in the plain hierarchy view. But
  `buildSellableCutaway` (the shelf's own cutaway builder) is the SAME
  `buildContainer` called from a caller that ALSO rigidly re-orients the
  whole carton+contents group afterward, so the carton's own declared front
  (`meta.frontFace`) faces the shopper. A carton's front is a WALL
  (`frontFace: 'W'`); a wrap's own front is its TOP (`frontFace: 'H'`) — two
  unrelated physical directions. Dragging the wrap along with a correction
  that was never about it shows whichever girth band faces the shopper by
  coincidence, not the wrap's own front band.
  FIX: `buildSellableCutaway` now computes the wrap's OWN `faceShopperQuat`
  (from the WRAP's `meta.frontFace`, never the carton's) whenever the tier
  being opened has a wrap child, and threads it into `buildContainer` as
  `opts.childFrontQuat` — read by BOTH wrap-child branches in place of
  `orientQuat(pl.orientation)` when set. Every other caller (the plain
  hierarchy cascade, `buildHierarchy`'s own recursion) never sets it, so that
  path is bit-identical — confirmed both by a passing regression pin and by
  a fresh screenshot of the plain carton-depth view, unchanged. `PACK_AXIS`
  and `faceShopperQuat` moved from `shelf3d.js` into `hierarchy3d.js` (same
  names, same behaviour, re-exported back) so `buildSellableCutaway` could
  reach them without `hierarchy3d.js` importing from the UI-adjacent shelf
  module — the dependency already ran the other way.
  A `faceUpRoll` composition (the wrap's own `meta.frontUp`, the same
  in-plane correction a bare wrap gets on the shelf) was ALSO tried, on the
  reasoning that `faceShopperQuat` alone only fixes WHICH band faces the
  shopper, not whether it reads upright. Measured, it made things WORSE — a
  previously-upright band became mirrored — so it was reverted rather than
  shipped on the strength of the reasoning alone; getting the sign/axis
  right needs more iteration than this pass had budget for. `test/
  shelforient.test.html` holds the shipped fix at the ACTUAL rendered
  `InstancedMesh` matrices (read back via `getMatrixAt`, compared to
  `faceShopperQuat('LHW','H')` — quaternion double-cover-aware, since q and
  −q are the same rotation), built through the SAME bundle shape `app.js`'s
  own `hierarchyBundle()` constructs (not a guessed shape), with a fixture
  pin proving the wrap's and carton's declared fronts are genuinely
  different axes and a mutation-guard pin proving the expected and
  pre-fix quaternions are genuinely different values — both necessary or the
  main pin could pass by coincidence. A separate reachability trap surfaced
  while writing it: `buildWrapOpened` (the one recursed OPENED wrap child)
  also emits an `InstancedMesh` for the bare product pieces inside, with its
  own unrelated rotation — an early version of the pin walked every
  `InstancedMesh` in the group and read a false failure off that mesh; fixed
  by filtering to the instance count that only the closed wrap SIBLINGS
  share. Mutation-tested: clearing `childFrontQuat` reproduces the pre-fix
  identity rotation and fails the fix pin.
  **NOT ADDRESSED, and stated rather than silently left**: a wrap or carton
  placed ON EDGE (L-up or W-up) inside a containment level has a genuine,
  separate up/down ambiguity — `orientQuat` only maps axes, never which of
  the (up to four) in-plane rotations about the now-vertical axis is
  "right", and nothing in the codebase defines a "correct" one for that
  case. This is the pre-existing, already-documented "Orientation flip
  parity" simplification above, confirmed still real this session (a forced
  L-up carton test showed the print legibly mirrored) but NOT the same bug
  as the shelf cutaway fixed here — the default project never places a wrap
  on edge, so it wasn't the reported symptom, and defining which rotation is
  "correct" for an on-edge pack is a product decision this task did not
  make. If a real workflow needs it, that is the next task, not a hidden
  side effect of this one.
- **RESOLVED (default-level task): the app opens on Product, not Case.**
  Requested as "update landing page to be the product" — clarified, once the
  repo and live GitHub Pages deployment were checked and found to already
  serve the working app directly (no separate marketing page exists to
  update), to mean the level a fresh, first-time visit lands on: "when you
  first open the link it should default to show the product level. Right
  now it's the case that gets shown." Two sites set the SAME fact and had
  to move together: the module-scope `let activeLevel = 'case'` (the value
  anything reads before boot finishes) and the actual boot-time
  `setActiveLevel('case')` call the app runs after `initBuild()` — the real,
  authoritative default-setter, since it does the full rail/view mount, not
  just the variable assignment. Changing only one would have left a
  transient-then-corrected mismatch window, not a real default change.
  Neither `activeLevel` nor any default level is part of the persisted save
  schema, so this only ever affects a truly fresh load (a restored autosave
  or loaded file still opens wherever the user left it, unchanged, since
  `applyLoadedState` never touches the boot-time default). Pinned in `test/
  chainstrip.test.html`, which already drives a real, un-clicked fresh load
  of the app in an iframe before its own reachability sweep starts clicking
  through every level — `R.initialActive` is captured at that exact moment
  (before the sweep overwrites it), at both the wide and narrow widths the
  file already tests. Mutation-tested: reverting either `setActiveLevel`
  call site back to `'case'` (the module-scope default alone was not
  re-tested in isolation, since `setActiveLevel` always runs after it at
  boot and would silently correct it) fails both new pins immediately.

- **RESOLVED (dimension-basis task): manually-entered carton/case dims can
  now be read as OUTSIDE (the erected part's own footprint) as well as
  INSIDE (the cavity, this app's only convention until now) — and the fix
  is entirely a DISPLAY-layer conversion, never a second stored value.**
  Reported worked example, confirmed against CAPE and reproduced through the
  real chain: a 443×198×235mm case at 3mm caliper on a 48×40in pallet reads
  10 cases/layer if those numbers are (mis)taken as inside, 12 if correctly
  taken as outside — a 20% difference with, until now, nothing on screen to
  say which one the app was doing.
  **The single architectural decision, stated because the task explicitly
  demanded one:** `level.params.L/W/H` remains ALWAYS the canonical INSIDE
  value — every existing internal reader (`geometry()`, `checkLockedCase`'s
  cavity at project.js:1084, `solveSecondaryInner`'s locked-branch `fitInto`
  call at :876, the openTop `fixedH` read at :1006) is UNCHANGED, reads
  unchanged, needed no edits at all. The new `dimBasis: 'inside'|'outside'`
  field (on `project.secondary`/`project.tertiary` only — the two levels
  that can be `locked`, i.e. manually dimensioned) governs nothing but how
  the RAIL FIELD interprets the next keystroke and what it currently shows:
  entering an outside value converts it to inside via the style's own
  `outerGrowth(params)` BEFORE it ever reaches `params.L/W/H`, and the
  outside figure is always RE-DERIVED from that inside value for the
  counterpart readout, never itself stored. This is what makes the round-
  trip stable BY CONSTRUCTION rather than merely tested-and-hoped: there is
  exactly one number on record, so a bare toggle sequence (no re-entry in
  between) has nothing to drift — pinned across 20 repeated toggles under a
  fractional caliper (a6120's own 0.457mm default) landing bit-identical,
  not merely "close."
  **The relation is STYLE-OWNED, per the task's explicit instruction not to
  hardcode `+2t` anywhere in input handling.** Each of the four manually-
  dimensioned styles (fefco201, a6120, sealend, tray — the ones whose
  `dimsLabel` is `'Inside dimensions'`; flowwrap/shrinkbundle are correctly
  excluded, since a content envelope or a bundle envelope was never an
  "inside" to begin with) exports its own `<style>OuterGrowth(p)` function
  — `{L: 2t, W: 2t, H: 4t}` for fefco201 and a6120 (numerically identical
  totals, genuinely different flap stacks, per each file's own existing
  comment), `{L: 2t, W: 2t, H: 6t}` for sealend's three-layer seal-over-
  major-over-dust stack, `{L: 2t, W: 2t, H: t}` for the tray's single open-
  top board layer — and `geometry()` builds `outer` FROM it (`const growth =
  <style>OuterGrowth(p); outer: {L: L+growth.L, ...}`), replacing what used
  to be an inline `L + 2*t` literal in each file. `core/styles/index.js`
  attaches each as `outerGrowth` on the matching registry entry and exports
  two generic functions, `insideDimsFromOutside`/`outsideDimsFromInside`,
  that do nothing but call whichever style's own `outerGrowth` and add or
  subtract it — so there is no second, independently-maintained conversion
  formula anywhere in the app; a style's relation can only ever be defined
  once. EXHAUSTIVENESS runs at module load, the same idiom as the
  interlayer/stack-base checks elsewhere in this file: every style whose
  `dimsLabel` is `'Inside dimensions'` is filtered into
  `DIM_BASIS_ELIGIBLE_STYLES` and asserted to carry a function-typed
  `outerGrowth`, or the module throws immediately naming the offending
  style — mutation-tested by stripping `tray`'s `outerGrowth: trayOuterGrowth`
  registry line and confirming the real app hard-crashes at import with
  exactly that message, not a silent fallback.
  **The UI**: `mountDimBasisControl()` (app.js), sibling to the existing
  lock control, renders an Inside/Outside `<select>` into a new
  `#levelDimBasis` host — shown only for a LOCKED level whose style declares
  `outerGrowth` (never for a solved/derived level, never for a flow wrap or
  shrink bundle). `inputs.js`'s `lengthField` grew a `dimBasisEligibleFor`
  gate: under `'outside'`, the field displays `inside + growth` and converts
  back on input (`raw - growth`); under the default `'inside'` it is
  untouched, bit-identical to every project before this field existed. BOTH
  values are always visible, per the task's explicit requirement — a new
  `.dimcounterpart` readout beside each L/W/H box always shows the OTHER
  basis, computed fresh (`growthNow()`, never captured once) because growth
  depends on caliper, a sibling MATERIAL-group field that can change without
  remounting the dims fields; a dedicated `refreshDimCounterparts`/
  `'dimCounterparts'` notifier keeps it live across such an edit without
  touching the locked field's own value (the same guarantee `refreshDims`
  already makes for the unlocked/solved case, extended to the one case it
  had always explicitly excluded). The pre-existing L>=W convention
  (`normalizeLW`) had to be made basis-aware too — it swaps the two
  CANONICAL INSIDE values (unchanged) but had been redisplaying the raw
  inside numbers into the input boxes regardless of basis; fixed to
  redisplay through the same outside conversion the fields themselves use.
  Verified live through the real UI, including the swap interaction
  specifically: typing an outside L smaller than the current inside W
  triggers the swap, and both the outside display and the inside
  counterpart come out correct on both sides of it (hand-traced against the
  real DOM, not assumed from the code).
  **Pins** (`test/dimensionbasis.test.html`, 19, plus a fix to one
  `saveload.test.html` migration-report pin whose exact expected key list
  needed the two new `dimBasis` defaults added in their real newProject()
  key order): the worked instance both ways through the real chain
  (`checkLockedCase`, not a hand re-derivation); a style-owned-conversion
  mutation applying tray's growth to fefco201's own outside dims and
  confirming a visibly different, wrong H; round-trip exactness including
  the 20-toggle fractional-caliper sweep; the derived readout checked
  against `levelGeometry(...).outer` — the REAL built geometry, never the
  conversion helper called a second time on itself; migration defaults
  ('inside' for both a fresh project and an old v1 fixture with no
  `dimBasis` key at all); exhaustiveness (both the positive four-style list
  and the two correctly-excluded flexible styles); DOM-driven reachability
  for carton AND case at 1400px and 390px; and a pin confirming the toggle
  is absent entirely on a solved (unlocked) level. Full regression:
  `saveload`/`project`/`containment`/`a6120`/`sealend`/`tray`/
  `lockinvariant`/`singlesource`/`sensitivity`/`chainstrip` all green.
- **RESOLVED (clearance-per-axis / wrap-orientation / underspecified-
  arrangement task): three independent items, one genuine modelling defect
  among them.**
  1. **Clearance wall is now per-axis.** `clearance.clearanceWall =
     {mode:'uniform'|'perAxis', L, W}` — the mode plus BOTH values, never a
     separate L/W pair plus a "same" boolean that could disagree with them
     (this codebase's own established idiom: `project.uboard`/`cap`'s
     absence-is-auto shape, never an `isAuto` flag). `uniform` reads L for
     BOTH axes (W not consulted); `perAxis` reads each axis's own value.
     Applies to the CARTON's own clearance (`project.secondary.clearance` —
     carton-into-case fit) and the CASE's own clearance
     (`project.tertiary.clearance` — case-onto-pallet fit), since
     `mountClearanceControl` is the ONE UI mount both "Inside the case" and
     "Case onto the pallet" panels use. `normClearance` (containment.js AND
     palletpatterns.js — the pre-existing duplicated-but-independent copy,
     same precedent as `bottom`/`top`/`betweenZ`) derives `wallL`/`wallW`
     from `clearanceWall` when present, else falls back to the legacy flat
     `wall` scalar for both axes — additive, no schema-version bump, every
     existing project and golden fixture bit-identical (containment.js's
     `parentCandidates` cavity build and palletpatterns.js's own effective-
     parent `PL`/`PW` both split `2*wall` into `2*wallL`/`2*wallW`; `pack.js`'s
     `packLayer` gained `wallL`/`wallW` params defaulting from its existing
     `wall` param, so its one other caller is untouched). UI: switching
     `uniform` -> `perAxis` seeds `W := L` EVERY time (not just once), so
     flipping back and forth can never leave a stale W that makes the
     effective width clearance jump the instant perAxis is chosen; switching
     back to `uniform` keeps L and leaves W as-is (not erased) so a later
     perAxis re-entry restores it, not a fresh seed — a deliberate choice
     pinned against the equally-defensible alternative. Migration happens
     once, in place, the first time `mountClearanceControl` mounts (same
     "migrate on mount" idiom as nothing new — see the palletpatterns
     duplication note above for why this file already tolerates that
     pattern), mirroring the existing split between `mountClearanceControl`
     (rebuilds the DOM, only on a mode click or a fresh `setActiveLevel`
     mount) and `refreshClearanceControl` (values only, in place, never a
     structural rebuild — since every field on this control round-trips
     through `onInput -> recompute -> refresh` on its OWN keystrokes, a
     rebuild there would steal focus mid-type). **FLAGGED, not decided
     silently, per the task's own explicit instruction:** "Clearance
     between" (child-to-child, in-plane) has the IDENTICAL axis ambiguity —
     a pack might want a different gap along X than along Y — but it was
     not asked for in this task and was deliberately left as one value, both
     axes. Whether it should get the same per-axis treatment is an open
     product question, not resolved here either way.
  2. **Wrap-in-case orientation: diagnosed, not "fixed" as reported, and
     that diagnosis surfaced two REAL, unrelated reflection bugs elsewhere.**
     The requested differential (wrap alone / case Solid / case Cutaway,
     driven through the real app with a diagnostic texture) found: Solid
     mode at case depth is VACUOUS for this question — a closed,
     non-open-top case takes `buildHierarchy`'s `soloClosed()` shortcut
     (`if(solid && !showContents)`), which draws ONLY the case's own opaque
     exterior; no wrap, no carton, no child instance renders at all, so
     "still correct in Solid?" has nothing to check (pinned as its own
     finding — `test/wraporientcase.test.html`'s FINDING A — rather than
     silently working around it). The wrap only becomes visible "inside the
     case" in Cutaway, and there every closed wrap sibling is posed at
     EXACTLY `orientQuat(placement.orientation)` — the correct containment
     pose, bit-identical to what a bare wrap at wrap depth uses for the same
     orientation string (FINDING B, same file). So per the task's own
     branching rule, this is the "only wrong in cutaway" case: optics (the
     far side of a wrap through a transparent case; flowwrap's own 5-band
     girth walk — back/side/front/side/back — means the visible band
     depends entirely on which side faces the camera), not a transform
     defect. Reported and stopped, exactly as instructed. The mandated
     `det(M) > 0` sweep, run anyway as the task required ("that single
     assertion catches the whole class, including the instances nobody has
     looked at yet") — `test/nestingdet.test.html`, covering case→wrap,
     case→carton, pallet→case and trailer→pallet through the REAL render
     pipeline (`fold3d.init3d` against a bare container div, `hierarchy3d.js`
     `buildHierarchy` called exactly as `app.js` calls it, not a
     hand-mocked shape) — found the sweep WAS worth running: TWO independent
     negative-scale reflection bugs, both in corner-post L-bracket
     construction, both invisible on the common square-leg default and only
     showing on an asymmetric leg pair (`legL != legW`, both independently
     user-editable — `#cpLegL`/`#cpLegW`). `palletmesh.js`'s
     `buildCornerPostSet` mirrored ONE +x/+z-quadrant post into the other 3
     corners via `post.scale.set(-sign(x), 1, -sign(z))`: of the 4 corners,
     2 flip a SINGLE axis (a TRUE reflection — det -1) and 2 flip BOTH axes
     (which is just a 180° rotation — det +1), so the bug was invisible
     whenever the mirrored shape happened to look right by coincidence
     (visually harmless does not mean det > 0 — a square-leg profile still
     reflects, it just happens to look congruent to a valid rotation, which
     is a fact about the SHAPE's symmetry, not about the matrix; pinned
     directly, since the naive "square legs never reflect" restatement is
     FALSE and would have been a vacuous mutation guard). `hierarchy3d.js`
     had an INDEPENDENT SECOND instance of the identical pattern in its own
     trailer-corner-post INSTANCING path (one shared geometry pair, mirrored
     per-instance via the matrix's own scale component) — a separate
     implementation of the same shape, so fixing one never fixed the other,
     exactly the "instances nobody has looked at yet" the det(M) invariant
     exists to catch. Both fixed by building each arm at its own SIGNED,
     INWARD-pointing offset directly (pure translation/pre-translated
     geometry, det always +1) instead of a post-hoc negative scale —
     verified by hand vertex-algebra to be byte-identical in rendered
     position to the old code, so `DoubleSide` (needed only to hide the old
     flipped winding) is no longer required either. Mutation-tested against
     the REAL source (not just an inline stand-in): stashing the fix and
     re-running `nestingdet.test.html` fails exactly 3 of 15 pins, at
     exactly the two corners this predicts, in the two independent
     implementations.
  3. **The real modelling defect: a manual grid never fixed orientation, so
     it never fixed the layout.** `link.arrangement` was `'auto' |
     {nx,ny,nz}` — counts only. Pack orientation (which product axis lands
     on which cavity axis) is a second, independent degree of freedom that
     kept floating even with a manual grid pinned, because BOTH manual-grid
     callers of `parentCandidates` (`candidateCases`, governing whichever
     tier — carton or case — is currently outermost, and
     `solveSecondaryInner`, governing the carton's own inner count-of-
     primary-units link) passed the child's WHOLE `allowedOrientations` list
     through unrestricted: one candidate PER matching orientation for the
     same (nx,ny), not one. A manual "4×3×1" with 2 allowed orientations
     produced 2 candidates, reachable only by cycling the candidate
     navigator — a control the task correctly says should not exist in
     manual mode at all. Fixed: `arrangement: 'auto' | {nx,ny,nz,orient}`.
     `orient` (one of the 6 `Orientation` strings) pins the ONE orientation
     both callers pass into `parentCandidates`'s `opts.orientations`; absent
     (every arrangement stored before this field existed) defaults to
     `allowedOrientations[0]` — same one-candidate guarantee, just an
     unpinned engineer's choice rather than an explicit one, so old saves
     are never left showing a list either. Applies to BOTH tiers by
     construction, since `candidateCases` is the one function either
     "cartons in a case" or "cases on the pallet" resolves through — a
     second fixture in `test/arrangementorient.test.html` exercises the
     carton-outermost path (case disabled) explicitly, not just the more
     commonly-hit case-outermost one. Manual axes are respected VERBATIM:
     `nx` along the parent's own L, `ny` along W, exactly as entered — no
     normalization runs on a manual arrangement, and none ever did:
     `normalizeLW` (the standing L>=W convention) was already, structurally,
     scoped to a level's raw `params.L`/`params.W` only and has never taken
     an arrangement as an argument — confirmed by a SOURCE pin reading
     `normalizeLW`'s own function body text and asserting it never mentions
     `arrangement` at all, the same "argue with an allowlist" idiom
     `typography.test.html` already established for index.html's CSS. Auto
     mode is completely unchanged (its own branch never sets
     `opts.orientations`, pinned directly, plus golden.json's own two
     manual-grid chain fixtures — `carton12_4x3x1_upright` and
     `carton12_4x3x1_tray_case`, both pre-dating this task and both
     carrying no `orient` field — re-verified bit-identical against the
     live `candidateCases()` directly, now returning exactly ONE row each
     instead of two, at the identical numeric result). UI: a new
     Orientation `<select>` is a PEER of the Nx/Ny/Nz grid in
     `mountCountArrangement` (inputs.js), reachable at both the desktop and
     mobile width `chainstrip.test.html` already establishes as this
     codebase's own breakpoint pair — sourced from the SAME `childLevel.
     allowedOrientations` the Facing control already reads, so widening the
     Vertical-axis/Facing choice widens the Orientation dropdown's options
     too, while Facing itself now has NO EFFECT on a manual arrangement
     (confirmed live through the real UI: switching the Orientation select
     alone moved the resolved case outer dims 733×576×63 -> 765×552×63 and
     cascaded through cost/BCT, with the candidate navigator staying "1 of 1"
     throughout) — which is what makes `inputs.js:495`'s claim TRUE for the
     first time; the copy itself was reworded from "the grid already fixes
     the layout" (false; only counts, never orientation) to naming where
     orientation is actually set now. The Nx/Ny/Nz `input` handlers used to
     rebuild `link.arrangement` from scratch on every keystroke
     (`{nx,ny,nz}`, no spread) — which would have silently dropped `orient`
     on the very next grid edit; fixed to spread the existing arrangement
     first. Mutation-tested against the real `candidateCases`: reverting to
     the pre-fix unrestricted `parentCandidates` call fails exactly the 3
     pins that exercise the fixed function (both tiers' one-candidate
     guarantee, and the orient-changes-geometry pin), while the pins built
     on inline stand-ins for "what the old un-pinned call returns" and "what
     a normalizer-on-manual would do" stay green throughout — proving those
     stand-ins are faithful reconstructions, not just plausible-looking
     code.
  Full regression: every runnable suite green (`golden.json`'s own
  `chains.*` entries re-verified directly against `candidateCases` per
  above, since `verify.html` itself times out in this sandbox — a
  pre-existing, already-documented environment limitation, not something
  this task's changes caused), including the two new corner-post/nesting
  and clearance/arrangement suites; `explode.test.html`/`uboard.test.html`
  hit their own already-documented pre-existing timeout, confirmed
  unrelated (this task never touches either module).
- **DIAGNOSED, NO DEFECT FOUND (pallet-pattern-pick task): the reported
  "Build shows one pattern out of 24" does not trace to the code shape the
  report hypothesized.** Reported as `chainMetrics`'s `selected0 =
  patternList[0]` (project.js) ignoring `project.pallet.patternIndex`, with
  two comments elsewhere in the file asserting the opposite. Diagnosed
  per the report's own three questions, against the RUNNING resolver, not
  assumed: (1) `build.js`'s `stepPattern` already writes
  `project.pallet.patternIndex = next` directly — a real project field, not
  a view-local index, confirmed both by reading its source and by driving
  the real cycle arrows through a live iframe. (2) `applyPatternSelection`
  (project.js) already exists, already reads and clamps `patternIndex`, and
  is already called by `resolveActiveRow` in all three of its branches
  (locked / matched-selection / default) — the committed chain's own final
  numbers, not `chainMetrics`'s `selected0`, which is only that candidate's
  OWN baseline (correct for what a Build-table row shows before any pattern
  pick narrows it, same as the case-candidate table). (3) Clamping already
  exists exactly as the report guessed. Verified numerically, not just
  read: a fixture whose pattern list has GENUINELY DIFFERENT totals (not
  ties — the earlier default-project probe tied at every candidate, which
  would have made this diagnosis inconclusive) shows `casesPerPallet`,
  `cartonsPerPallet`, `coveragePct`, the interlock schedule (`layerFlips`
  applies to the SELECTED candidate, not candidate 0), and downstream
  trailer fit all following `patternIndex` correctly, both through the pure
  resolver and through the real running app (cycle arrows, BCT interlock
  warning, opened-instance index all update live). `test/
  patternpick.test.html` pins this as a REGRESSION GUARD, not a fix: the
  propagation identity, the interlock-schedule-follows-selection property,
  out-of-range clamping, and index-0 bit-identity are all pinned, plus a
  source check that `stepPattern` writes the real field and a live DOM
  survey that cycles the actual navigator. Mutation-tested against the
  REAL source (not an inline stand-in, which would only prove "row !==
  row" and test nothing): temporarily reverting `resolveActiveRow`'s three
  `applyPatternSelection(...)` wrappers to their bare argument — the
  reported bug shape, patternIndex never read — failed exactly the five
  pins that exercise propagation (PROPAGATION, IDENTITY, DOWNSTREAM,
  LAYERFLIPS, CLAMPING) while DEFAULT/SOURCE/DOM/MUTATION-CONTEXT stayed
  green, and the existing suites this task must not disturb (containment,
  palletpatterns, project, sensitivity, saveload, trailer) stayed FULLY
  GREEN under that same mutation — confirming the report's own "specimen
  problem" framing: no existing golden chain fixture ever sets
  `patternIndex` (pinned directly, `MUTATION CONTEXT`), so a fixture that
  never varies the pick could never have caught a pick that was never
  read. This mechanism was evidently built in an earlier session not
  captured by a prior entry in this file; that gap in the log, not a gap
  in the code, is presumably what let the report read as current. No code
  change was made — `core/project.js` is untouched by this task; only the
  new regression pin was added.
- **RESOLVED IN PART (pallet-pattern-table task): Build's pallet-level tab
  gets a real comparison table for pallet-layer PATTERNS — the piece that
  directly answers "Build shows one pattern out of 24."** A companion task
  in a sibling branch/PR diagnosed the reported patternIndex-propagation
  bug and found it does not exist: `resolveActiveRow` already wraps every
  branch in `applyPatternSelection`, which already reads and clamps
  `project.pallet.patternIndex`. What genuinely was missing, confirmed by
  reading the code: at pallet depth, Build never enumerated pallet
  patterns at all — `build.js`'s table has only ever shown CASE/carton
  candidate rows (`candidateCases`), regardless of `activeLevel`, which is
  the real, literal reason the tab read as "one row" — the case chain had
  one candidate; the 24 PATTERNS for that case had nowhere to be browsed
  except the pre-existing cycle arrows.

  **Reused the existing table mechanism, not a second one**, per the
  task's own instruction: `build.js`'s row/header/click DOM-building logic
  was extracted into `renderCandidateTable(tbl, cols, displayRows, opts)` —
  a pure function taking rows/columns/callbacks, owning no state itself —
  and the pre-existing case-candidate `renderTable()` now calls it (a
  mechanical, behavior-preserving refactor: same markup, same click
  wiring, confirmed bit-identical by the untouched suites still passing).
  A new `renderPatternTable()` calls the SAME function with pallet-pattern
  columns/rows. `build.setMode('case'|'pattern')`, called from
  `app.js`'s `setActiveLevel` (`level === 'pallet' ? 'pattern' : 'case'`),
  toggles which of two panels (`#bCasePanel`/`#bPatternPanel`, both built
  by `initBuild()`) is visible — build.js owns no notion of "active
  level" itself, so the caller decides when to switch.

  **Rows are `palletPatternList` candidates, one each, in that module's
  own ranked order — never a cross product with interlock schedules**
  (a schedule changes stability, not count/efficiency/footprint, so it
  would read identically down every row): the `#` column IS the row's
  position, so this table does not re-sort (re-sorting would make that
  column lie). **Selecting a row writes `project.pallet.patternIndex`
  directly** — the exact field the pre-existing cycle arrows
  (`stepPattern`) already write and `applyPatternSelection` already
  reads — never a second, view-local "which pattern is picked."
  Verified live end-to-end through the real app: selecting a
  different-total row changes the rendered pallet count, the cycle
  arrows' "N of M," the deck coverage %, and (for an interlocked
  candidate) the BCT interlock-strength warning, together.

  **Columns**, each already computed on the candidate or one arithmetic
  step away — no second solver: `#`, `Family`, `Per layer`, `Layers`,
  `Cases/pallet` (`total`), `Cartons/pallet` (`total × perPalletMultiplier`,
  reading whether `project.secondary.enabled` at all rather than
  re-deriving it — shows **"—"**, never a computed number, when the carton
  tier isn't in the chain), `Area eff. %` (imports `deckCoveragePct` from
  `project.js`, now exported specifically so this column and the committed
  chain's own `coveragePct` can never disagree), `Cube eff. %`
  (`candidate.utilization`), `Length/Width unused` (deck minus
  `candidate.envelope`, per axis), `Overhang` (`candidate.loadOverhang`,
  already on the candidate), and `Interlockable`. **The efficiency
  denominator is stated, not silently chosen**: `utilization` is volumetric
  fill against the pallet's MAX LOAD HEIGHT budget (`maxH - baseH`), not
  each candidate's own achieved stack height — named in the column's hint
  text, and pinned with a fixture where the two conventions provably give
  different numbers (an 1mm gap between the cavity height and this
  candidate's own envelope height), so the pin can't have passed by
  coincidence either way.

  **Interlockable** (`sym180`, the "is this layer its own 180° turn"
  check palletpatterns.js's own `withSchedule` already runs internally to
  decide whether to warn) is now also exposed as a field on the candidate
  object (`interlockable: !symmetric`) — reading it off the existing
  helper, never a second symmetry test. Verified against an INDEPENDENT
  reconstruction in the test file (negate every placement's x/y and check
  the resulting set matches), not by calling `sym180` a second time, which
  would only prove the function agrees with itself.

  **DEFERRED, explicitly, not silently dropped**: thumbnails (the capture-
  sheet composer pointed at the candidate list instead of the chain),
  the render inset ("Layer plan" view toggle alongside Solid/Cutaway),
  and extracting the pallet-PDF's own layer-plan drawing as a shared
  component used by all three. These are a separate, visual-rendering-
  heavy body of work — this task ships the table (the part that directly
  answers the original confusion and needed no new geometry) and stops
  there; no pins exist yet for the deferred pieces because there is
  nothing built to pin. `index.html`'s `#bTable`-scoped CSS rules were
  widened to also match `#bPatternTable` (the two tables share one visual
  language by construction, not by copy) — except the header `cursor:
  pointer`, which stays case-table-only since the pattern table's headers
  are deliberately not sortable.

  Pinned in `test/patterntable.test.html`: row content read directly off
  each candidate (never against another row), both efficiency columns
  hand-computed with the denominator stated, interlockable verified
  independently for both a symmetric and an asymmetric candidate, the
  carton-skipped "—" behaviour driven through the real chain-strip
  disable-carton confirmation dialog (not a project field poked directly),
  and full DOM reachability/wiring at both 1400px and 390px via a real
  iframe survey — panel toggling, row count, and a row click's live
  propagation into the rendered 3D readout text. Full regression: every
  suite this task's files touch (`chainstrip`, `project`, `palletpatterns`,
  `containment`, `saveload`, `trailer`, `sensitivity`) green, unchanged.
