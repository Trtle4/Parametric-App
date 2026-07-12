/**
 * Shared type contracts for the parametric packaging core.
 *
 * Everything in core/ operates in MILLIMETERS. Unit conversion happens only
 * at the UI boundary (reading inputs) and in display formatting.
 * No core module may read the DOM.
 */

/**
 * @typedef {Object} Params            // all lengths in mm
 * @property {number} L        internal length
 * @property {number} W        internal width
 * @property {number} H        internal height
 * @property {number} caliper  board thickness
 * @property {number} glue     glue-flap (manufacturer's joint) width
 * @property {number} slot     slot knife width
 */

/**
 * @typedef {[number, number, number, number]} Segment   // x1,y1,x2,y2
 */

/**
 * @typedef {Object} BBox
 * @property {number} minX @property {number} minY
 * @property {number} maxX @property {number} maxY
 */

/**
 * @typedef {Object} Dims
 * @property {number} L @property {number} W @property {number} H
 */

/**
 * @typedef {Object} Geometry          // what every style returns
 * @property {'rigid'|'flexible'} structure
 *   rigid:    cut + crease dieline, caliper-based compensation
 *   flexible: cut is the blank outline ONLY, crease is EMPTY (film is folded
 *             and sealed, never scored — fold positions may appear in
 *             meta.refLines as reference annotations), compensation is
 *             seal-based and owned by the style
 * @property {[number,number][]} cut   // ordered closed perimeter (Y-up, mm)
 * @property {Segment[]} crease
 * @property {BBox} bbox               // blank extents
 * @property {Dims} inner              // internal L/W/H, the usable cavity
 * @property {Dims} outer              // external L/W/H, compensated
 * @property {Object} meta             // style id, material properties, annotations
 */

/**
 * @typedef {Object} LayerPosition     // one child footprint inside a parent rectangle
 * @property {number} x                // centre, parent-centred coords
 * @property {number} y
 * @property {boolean} rot             // child rotated 90 degrees in plane
 */

export {}; // documentation-only module
