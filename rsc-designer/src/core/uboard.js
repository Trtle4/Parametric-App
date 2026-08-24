/**
 * U-board interlayer — a flat paperboard blank placed under the collation
 * inside the flow wrap, with two panels folded up to form a U in
 * cross-section: a base under the product, two side panels rising on the
 * long sides. No cuts, no notches, no glue — a rectangle with two crease
 * lines, which is exactly what the `Geometry` contract (types.js) and the
 * existing dieline renderer (render/dieline2d.js) already know how to draw;
 * this module builds that contract directly rather than inventing a second
 * crease-line convention.
 *
 * Sibling to core/cookietray.js, not to core/styles/*: like the tray, the
 * U-board is a dedicated interlayer with its own params, not a selectable
 * style through styleById() — project.js's resolveWrapContents() is the
 * only place that decides whether it's in the chain at all.
 *
 * FOLD AXIS: the two creases run parallel to the wrap's flow axis
 * (FLOW_AXIS, exported by core/styles/flowwrap.js — imported here, never a
 * second hardcoded 'L'), so the U-board's fold direction always follows
 * whichever physical axis the chain has resolved to be the machine
 * direction, rather than a fixed product axis of its own.
 *
 * CALL-TIME, NOT LOAD-TIME: acrossAxisOf() below is called fresh inside
 * every function that needs it — FLOW_AXIS is read at that same moment,
 * never cached into a module-level constant computed once at import. Today
 * FLOW_AXIS is a plain fixed string, so this makes no observable
 * difference — but the machine direction is only fixed because nothing in
 * this app yet lets the collation choose its own facing independent of the
 * wrap's seals. When that lands, FLOW_AXIS is expected to become something
 * derived from project/collation state rather than a bare constant; a
 * value memoized at module load would silently go stale the moment that
 * happens, while a per-call read follows it automatically. Caching it here
 * once was tried and rejected for exactly this reason.
 *
 * DOM-free, mm-only, side-effect-free.
 */
import {FLOW_AXIS} from './styles/flowwrap.js';

/** Board caliper default is a placeholder order-of-magnitude, same idiom as
 *  cost.js's COST_DEFAULTS — a real project overrides it. `f: null` means
 *  "auto": the flap panel length defaults to the content's own H (the
 *  user's stated default), any number overrides it. */
export const UBOARD_DEFAULTS = Object.freeze({caliper: 0.9, f: null});

const PLAN_AXES = {L: 'W', W: 'L'};
/** The in-plan axis that ISN'T the flow axis — 'W' today, since FLOW_AXIS is
 *  'L' — derived FRESH from FLOW_AXIS on every call (see the module doc
 *  above), never memoized into a module-level constant. */
export function acrossAxisOf(flowAxis = FLOW_AXIS){
  return PLAN_AXES[flowAxis];
}

/** Resolve the auto-with-override params: caliper always has a numeric
 *  default; f defaults to the content's own H when not overridden. */
export function uboardParams(overrides, contentH){
  const ov = overrides || {};
  const num = v => typeof v === 'number' && isFinite(v);
  const caliper = num(ov.caliper) ? ov.caliper : UBOARD_DEFAULTS.caliper;
  const f = num(ov.f) ? ov.f : contentH;
  return {caliper, f};
}

/**
 * The dimensional contribution to the envelope the wrap sees, from the
 * content envelope (`content`, the collation's own {L,W,H}) and the U-board's
 * resolved params. Flow axis unchanged; the across axis gains 2×caliper (the
 * two folded side-panel thicknesses); H is caliper (the base) plus whichever
 * is taller of the content's own height or the flap panel length — a proud
 * flap stands above the product, a proud product stands above the flap, and
 * the taller of the two is what the film must clear. Implemented as the
 * actual max(), never hardcoded to content H + caliper (a product shorter
 * than the flap is a real, reachable case).
 * @param {{L:number,W:number,H:number}} content
 * @param {{caliper:number, f:number}} p  uboardParams() result
 * @returns {{L:number,W:number,H:number}}
 */
export function uboardOuter(content, p){
  const acrossAxis = acrossAxisOf();
  const outer = {L: content.L, W: content.W, H: 0};
  outer[acrossAxis] = content[acrossAxis] + 2*p.caliper;
  outer.H = p.caliper + Math.max(content.H, p.f);
  return outer;
}

/**
 * The flat blank, as a full `Geometry` contract object (types.js) — drawn by
 * the existing style-agnostic render/dieline2d.js draw2d() with no changes
 * to that renderer: a rectangular cut, two full-length creases, and the
 * generic meta.{labels,hDims,vDims} annotations it already knows how to
 * render.
 *
 * Blank layout (flat, before folding): the flow-axis run is the blank's
 * unchanged length; the across-axis run is base + two flap panels
 * (across + 2f). Creases sit at f from each long edge, full length —
 * parallel to the flow axis, per the module doc above.
 *
 * L>=W CONVENTION EXEMPTION: unlike every rigid style's own L/W inputs, the
 * U-board's blank dimensions are fully DERIVED (content envelope + f), never
 * independently user-edited fields — inputs.js's normalizeLW/appliesLWConvention
 * machinery has no editable field here to act on, so the blank's across run
 * (content.W + 2f) may legitimately exceed its flow-axis run. This is a
 * deliberate exemption, not an oversight: the convention exists to keep a
 * user's two editable dimensions unambiguous, and the U-board has none.
 *
 * @param {{L:number,W:number,H:number}} content
 * @param {{caliper:number, f:number}} p
 * @returns {import('./types.js').Geometry}
 */
export function uboardBlank(content, p){
  const {caliper: t, f} = p;
  const flowLen = content[FLOW_AXIS];         // unfolded run along the flow axis
  const across = content[acrossAxisOf()];     // unfolded run across it (base + 2 flaps when flat)
  const blankAcross = across + 2*f;

  const cut = [[0, 0], [flowLen, 0], [flowLen, blankAcross], [0, blankAcross]];
  const crease = [
    [0, f, flowLen, f],
    [0, f + across, flowLen, f + across]
  ];

  return {
    structure: 'rigid',
    cut,
    crease,
    bbox: {minX: 0, minY: 0, maxX: flowLen, maxY: blankAcross},
    inner: {...content},
    outer: uboardOuter(content, p),
    meta: {
      style: 'uboard',
      caliper: t,
      labels: [
        {x: flowLen/2, y: f/2, text: 'FLAP'},
        {x: flowLen/2, y: f + across/2, text: `BASE  t ${t}mm  PAPERBOARD`},
        {x: flowLen/2, y: f + across + f/2, text: 'FLAP'}
      ],
      hDims: [{from: 0, to: flowLen, v: flowLen}],
      vDims: [
        {from: 0, to: f, v: f},
        {from: f, to: f + across, v: across},
        {from: f + across, to: blankAcross, v: f}
      ]
    }
  };
}

/**
 * THE U-board stage — called ONLY from resolveWrapContents()'s 'uboard'
 * branch, which is the sole place that decides whether the U-board is in
 * the chain (project.interlayer === 'uboard'). Sources its content grid the
 * same way the 'none' branch does — `content` is contentEnvelope(project.
 * primary), one collation's worth of product — then applies the U-board's
 * own dimensional contribution on top.
 * @param {Object} project
 * @param {Object} content  contentEnvelope(project.primary) result
 */
export function uboardStage(project, content){
  const cfg = (project.uboard && project.uboard.params) || {};
  const env = content.outer;
  const params = uboardParams(cfg, env.H);
  const geo = uboardBlank(env, params);
  return {params, geo, outer: geo.outer};
}
