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

## Tests

- `test/golden.json` + `test/verify.html`: regression pins for geometry and
  pallet results. Numeric comparisons use 1e-9 tolerance (unit round-trip
  noise is ~1e-14; real deviations >= 0.15).
- `test/containment.test.html`: DOM-free unit tests for the containment
  model. Both run in the browser off the dev server.

## Known simplifications to revisit

- **Uniform clearance (`core/containment.js`)**: `wall` currently applies to
  all six cavity faces and `between` to all three axes. That is wrong for
  the secondary/primary levels: vertical clearance is not the same animal as
  lateral — headspace above product in a carton is a deliberate design
  parameter (not a fit tolerance), bottom clearance is normally zero because
  the product sits on the deck, and vertical `between` is usually zero since
  children stack directly on each other. Inert today because the pallet
  level passes zeros. **Split vertical from lateral clearance when the
  secondary (carton) level lands — do not let this bake into three levels.**
