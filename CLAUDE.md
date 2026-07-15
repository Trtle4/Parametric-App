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

## Known simplifications to revisit

- **RESOLVED (case-builder task): clearance is split.** `Clearance` now
  carries optional `bottom` / `top` / `betweenZ`; when omitted they default
  to `wall` / `wall` / `between` (the legacy uniform shape, so the pallet
  level is untouched). The carton->case chain passes vertical zeros:
  cartons bear on the case floor, no default headspace. Headspace as a
  first-class design input is still pending an engineering ruling.
- **Orientation flip parity**: `Orientation` strings capture axis mapping
  only, not up/down flips — "inverted" occupies identical space to upright
  in the solver. Recorded in the Build UI but geometrically inert.
