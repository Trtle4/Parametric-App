/**
 * Top and bottom CAPS — one continuous paperboard surface covering a unit
 * load's whole layer face, with a skirt wrapping down (or up) over its
 * edges.
 *
 * Sibling to core/uboard.js and core/cookietray.js, not to core/styles/*:
 * a cap is a dedicated pallet-level accessory with its own params, never a
 * selectable style through styleById(). Like the U-board it builds the
 * `Geometry` contract (types.js) directly, so render/dieline2d.js draws it
 * with no renderer changes — its `cut` is just a 20-point polygon instead
 * of the U-board's 4-point one, and `<polygon>` does not care.
 *
 * THE BLANK IS A PLUS. A centre panel, one flap per edge, and the four
 * corner squares removed — that removal is what makes it a plus rather
 * than a rectangle, and it is also why cost must read `plusAreaMM2` and
 * never the bbox: `blankAreaM2` (project.js) is bbox area, correct for
 * every rectangular blank in this app and wrong for this one by exactly
 * the four corner squares. See capPlusAreaMM2's own doc.
 *
 * CORNER RELIEF, and which of the two options this module took. With the
 * corner squares removed EXACTLY, the four folded flaps arrive at each
 * corner edge-to-edge and interfere by about one caliper — a blank that
 * does not fold. The two fixes are trimming the flaps or enlarging the
 * relief; this module TRIMS THE FLAPS, by `relief` at each end, defaulting
 * to ONE CALIPER (`relief: null` is the auto state, the same
 * absence-is-auto idiom cost rates and tray cells already use). Trimming
 * was chosen over enlarging the corner cutout because it leaves the BLANK
 * BOUNDING BOX untouched at (centreL + 2x) x (centreW + 2x) — the number a
 * board supplier quotes a sheet size against — while still opening a real
 * gap between adjacent folded flaps. The gap is 2 x relief (each of the two
 * flaps meeting at a corner gives up `relief`), so the default clears the
 * one-caliper interference with margin.
 *
 * THICKNESS YES, STRENGTH NO. A cap has caliper and weight, and both are
 * modelled. It carries NO stacking load: nothing in this module feeds
 * core/bct.js, and core/bct.js imports nothing from here. A cap's weight
 * does reach BCT — through the ordinary tare path, as load, exactly like a
 * pallet's own tare — which is the opposite of a strength contribution and
 * must not be confused with one.
 *
 * DELIBERATELY NOT MODELLED: a bottom cap really does distribute load
 * across a pallet's deckboard gaps, letting cases bridge a gap they would
 * otherwise sit over unsupported. That is a genuine structural function and
 * this app does not model it — there is no deckboard-gap model to hang it
 * on, and inventing a strength credit for it would be exactly the kind of
 * unearned number core/bct.js's own disclose-don't-apply rule exists to
 * prevent. Stated here rather than left ambiguous.
 *
 * DOM-free, mm-only, side-effect-free.
 */
import {MM_PER_IN} from './units.js';

const KG_PER_LB = 0.45359237;
const num = v => typeof v === 'number' && isFinite(v);

/**
 * `top`/`bottom` are independent: a load may carry either, both or neither.
 * `relief: null` is AUTO (one caliper) — absence of a value IS the auto
 * state, never a separate isAuto flag that could disagree with it.
 *
 * `density` is an EFFECTIVE board density (corrugated, not solid fibre):
 * 150 kg/m³ over a 48x40in footprint at 3mm puts a cap at ~1.2 lb, the
 * order of magnitude a real corrugated cap weighs. The corner post's own
 * 700 and the slipsheet's 950 are solid/laminated stock and are NOT the
 * right figure here — a cap priced off either would weigh five times what
 * it does.
 */
export const CAP_DEFAULTS = Object.freeze({
  top: false,
  bottom: false,
  skirt: 2*MM_PER_IN,   // 2in of skirt, folded down over the load's edges
  caliper: 3,
  relief: null,         // auto: one caliper
  density: 150          // kg/m³, effective corrugated
});

/** The raw override object, or {} — never undefined, so every reader below
 *  can index it. */
function capRaw(project){
  return (project.pallet && project.pallet.stack && project.pallet.stack.cap) || {};
}

/**
 * The resolved cap config: every field either the project's own override or
 * CAP_DEFAULTS — never a mix of the two per field left to the caller. One
 * config for the WHOLE stack, applied to every position uniformly, matching
 * cornerPostConfig's own shape and for the same reason: a stack whose
 * positions each carried a different cap would need per-position UI that
 * does not exist, and inventing per-position state nothing can edit is how
 * a field goes stale.
 */
export function capConfig(project){
  const c = capRaw(project);
  const caliper = num(c.caliper) ? c.caliper : CAP_DEFAULTS.caliper;
  return {
    top: !!c.top,
    bottom: !!c.bottom,
    skirt: num(c.skirt) ? c.skirt : CAP_DEFAULTS.skirt,
    caliper,
    // AUTO IS THE ABSENCE OF A VALUE. A relief of exactly 0 is a legitimate
    // explicit choice (a user who wants the flaps untrimmed and will handle
    // the interference themselves), so it must survive — `num(0)` is true,
    // which is why this tests numeric-ness rather than truthiness.
    relief: num(c.relief) ? c.relief : caliper,
    density: num(c.density) ? c.density : CAP_DEFAULTS.density
  };
}

/** Is either cap in play at all? The one predicate every "does this load
 *  have a cap" question reads, so none of them re-spells `top || bottom`. */
export function capEnabled(project){
  const cfg = capConfig(project);
  return cfg.top || cfg.bottom;
}

/**
 * How many caps one position carries (0, 1 or 2) — used by the cost and
 * weight roll-ups so neither counts `top` and `bottom` with its own
 * arithmetic.
 */
export function capsPerPosition(project){
  const cfg = capConfig(project);
  return (cfg.top ? 1 : 0) + (cfg.bottom ? 1 : 0);
}

/**
 * The load-footprint growth from caps, mm — 2 x caliper in EACH of L and W,
 * because the skirt hangs alongside the load on all four sides and each
 * side is one caliper thick. Zero when no cap is on.
 *
 * This is the growth from the CAP ALONE. It is never applied to a bare case
 * envelope by a caller: core/stack.js's loadFootprintStagesMM nests it
 * OUTBOARD of the corner posts, which is the physical order (a cap goes
 * over the posts) and the only place this term is consumed.
 *
 * Counted ONCE even when both caps are on: the two caps sit at opposite
 * ends of the load and their skirts occupy the same plan rectangle, so the
 * load is not twice as wide for having two of them.
 */
export function capFootprintGrowthMM(project){
  const cfg = capConfig(project);
  return (cfg.top || cfg.bottom) ? 2*cfg.caliper : 0;
}

/**
 * The cap's height contribution to one position, mm: one caliper above the
 * cases for a top cap, one below for a bottom cap. THE SKIRT ADDS NONE — it
 * hangs alongside the load, inside the height the cases already occupy.
 *
 * NOT the same number as the cap's own envelope height (`geo.outer.H`,
 * which is caliper + skirt): that is how tall the folded part is, this is
 * how much taller it makes the stack. Two different questions with two
 * different answers, kept as two named values rather than one number that
 * would have to mean both.
 */
export function capHeightGrowthMM(project){
  const cfg = capConfig(project);
  return (cfg.top ? cfg.caliper : 0) + (cfg.bottom ? cfg.caliper : 0);
}

/**
 * The plus blank's AREA, mm² — the centre panel plus four flaps, with the
 * four corner squares EXCLUDED because they are cut away and never bought
 * as part of the blank's outline.
 *
 *     centreL*centreW  +  2*skirt*(centreL - 2*relief)  +  2*skirt*(centreW - 2*relief)
 *
 * The bounding rectangle is (centreL + 2*skirt) x (centreW + 2*skirt), which
 * exceeds this by the four skirt² corners plus the eight relief slivers. The
 * difference is the whole reason cost may not use project.js's bbox-based
 * `blankAreaM2` here.
 *
 * COST ASSUMPTION, stated rather than buried: this charges the BLANK — the
 * plus outline that becomes the cap. Whether the corner squares are
 * recoverable scrap or are lost in the trim is a converter's question this
 * app does not model; if they are lost, the true sheet cost is the bounding
 * rectangle and this figure is optimistic by that difference.
 *
 * Flaps are clamped at zero: a relief wider than half the centre panel
 * would otherwise contribute NEGATIVE area, which is not a small blank but
 * an impossible one.
 */
export function capPlusAreaMM2(centre, cfg){
  const {skirt: x, relief: r} = cfg;
  const flapL = Math.max(0, centre.L - 2*r);
  const flapW = Math.max(0, centre.W - 2*r);
  return centre.L*centre.W + 2*x*flapL + 2*x*flapW;
}

/** One cap's own weight, lb — plus area x caliper x density. Reads the SAME
 *  capPlusAreaMM2 cost does, so a cap can never weigh its bounding
 *  rectangle while being charged its plus (or the reverse). */
export function capWeightLb(centre, cfg){
  const volM3 = (capPlusAreaMM2(centre, cfg)/1e6)*(cfg.caliper/1000);
  return (volM3*cfg.density)/KG_PER_LB;
}

/** Drop a point that repeats its predecessor — with `relief: 0` the plus
 *  walk below produces coincident pairs at every corner, and a polygon with
 *  zero-length segments is a needless thing to hand a renderer or a DXF.
 *  The CLOSING duplicate counts too: a `cut` polygon is implicitly closed,
 *  so a final point equal to the first is the same zero-length segment seen
 *  across the wrap-around, and at relief 0 the walk's last step lands
 *  exactly back on its first point. */
function dedupe(pts){
  const out = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  const first = out[0], last = out[out.length - 1];
  if(out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}

/**
 * The flat blank, as a full `Geometry` contract object (types.js).
 *
 * Laid out with the BOUNDING BOX at the origin, so bbox is
 * (0,0)-(centreL + 2x, centreW + 2x) and the centre panel occupies
 * [x, x+centreL] x [x, x+centreW]. Four creases, one per centre-panel edge,
 * each running the full length of that edge — the existing crease
 * convention, unchanged.
 *
 * The `cut` walk goes counter-clockwise from the centre panel's
 * bottom-left corner, stepping out around each flap in turn. With relief it
 * has 20 vertices; with relief 0 the trims collapse and `dedupe` returns
 * the plain 12-vertex plus.
 *
 * @param {{L:number,W:number}} centre  the load footprint the cap covers —
 *   INCLUDING anything already outboard of the cases (post caliper, most
 *   importantly). Callers get this from core/stack.js's
 *   loadFootprintStagesMM(...).posts, never from a bare case envelope.
 * @param {ReturnType<typeof capConfig>} cfg
 * @param {'top'|'bottom'} which  labels only — the blank is identical either way
 * @returns {import('./types.js').Geometry}
 */
export function capBlank(centre, cfg, which = 'top'){
  const {skirt: x, caliper: t, relief: r} = cfg;
  const cL = centre.L, cW = centre.W;
  // A relief that eats past the middle of an edge leaves no flap to fold;
  // clamp so the walk stays a simple polygon rather than self-intersecting.
  const rL = Math.min(r, cL/2), rW = Math.min(r, cW/2);
  const X0 = 0, X1 = x, X2 = x + cL, X3 = cL + 2*x;
  const Y0 = 0, Y1 = x, Y2 = x + cW, Y3 = cW + 2*x;

  const cut = dedupe([
    [X1, Y1],
    [X1 + rL, Y1], [X1 + rL, Y0], [X2 - rL, Y0], [X2 - rL, Y1],   // bottom flap
    [X2, Y1],
    [X2, Y1 + rW], [X3, Y1 + rW], [X3, Y2 - rW], [X2, Y2 - rW],   // right flap
    [X2, Y2],
    [X2 - rL, Y2], [X2 - rL, Y3], [X1 + rL, Y3], [X1 + rL, Y2],   // top flap
    [X1, Y2],
    [X1, Y2 - rW], [X0, Y2 - rW], [X0, Y1 + rW], [X1, Y1 + rW]    // left flap
  ]);

  const crease = [
    [X1, Y1, X2, Y1],   // bottom edge of the centre panel
    [X1, Y2, X2, Y2],   // top
    [X1, Y1, X1, Y2],   // left
    [X2, Y1, X2, Y2]    // right
  ];

  const plusAreaMM2 = capPlusAreaMM2(centre, cfg);

  return {
    structure: 'rigid',
    cut,
    crease,
    bbox: {minX: 0, minY: 0, maxX: X3, maxY: Y3},
    inner: {L: cL, W: cW, H: 0},
    // the folded cap's OWN envelope: the centre panel is one caliper thick
    // and the skirts hang `x` alongside, adding a caliper per side in plan.
    // NOT the stack height contribution — see capHeightGrowthMM.
    outer: {L: cL + 2*t, W: cW + 2*t, H: t + x},
    meta: {
      style: 'cap',
      which,
      caliper: t,
      skirt: x,
      relief: r,
      // ONE computation of the plus area, carried on the geometry so the
      // cost roll-up, the weight and the 2D readout are three readers of
      // one number rather than three places that each know the formula.
      plusAreaMM2,
      centre: {L: cL, W: cW},
      labels: [
        {x: X3/2, y: Y0 + x/2, text: 'SKIRT'},
        {x: X3/2, y: (Y1 + Y2)/2, text: `${which.toUpperCase()} CAP  t ${t}mm  PAPERBOARD`},
        {x: X3/2, y: Y2 + x/2, text: 'SKIRT'},
        {x: X0 + x/2, y: (Y1 + Y2)/2, text: 'SKIRT'},
        {x: X2 + x/2, y: (Y1 + Y2)/2, text: 'SKIRT'}
      ],
      hDims: [
        {from: X0, to: X1, v: x},
        {from: X1, to: X2, v: cL},
        {from: X2, to: X3, v: x}
      ],
      vDims: [
        {from: Y0, to: Y1, v: x},
        {from: Y1, to: Y2, v: cW},
        {from: Y2, to: Y3, v: x}
      ]
    }
  };
}
