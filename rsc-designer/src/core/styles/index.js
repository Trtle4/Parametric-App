/**
 * Style registry. A style is a plain object; the UI builds its input fields
 * from `params`, renderers and exporters consume only the Geometry contract.
 * DOM-free, mm-only (param defaults are mm).
 *
 * Param descriptor: { key, label, hint, group: 'dims'|'material',
 *                     min, step, default }           // numeric length, mm
 *              or   { key, label, hint, group, type:'select', choices, default }
 * Option descriptor (style-specific view options, not dimensions):
 *                   { key, label, hint, choices: [{value,label}], default }
 */
import {fefco201} from './fefco201.js';
import {a6120} from './a6120.js';

export const styles = [
  {
    id: 'fefco201',
    name: 'FEFCO 201 Regular Slotted Container',
    brand: {code: 'FEFCO 201', sub: 'Regular Slotted Container'},
    tier: 'tertiary',
    material: 'corrugated',
    params: [
      {key: 'L',       label: 'Length',        hint: 'L',     group: 'dims',     min: 1, step: 1,   default: 200},
      {key: 'W',       label: 'Width',         hint: 'W',     group: 'dims',     min: 1, step: 1,   default: 150},
      {key: 'H',       label: 'Height',        hint: 'H',     group: 'dims',     min: 1, step: 1,   default: 120},
      {key: 'caliper', label: 'Board caliper', hint: 't',     group: 'material', min: 0, step: 0.1, default: 3},
      {key: 'glue',    label: 'Glue flap',     hint: 'joint', group: 'material', min: 0, step: 1,   default: 35},
      {key: 'slot',    label: 'Slot width',    hint: 'knife', group: 'material', min: 0, step: 0.5, default: 6}
    ],
    options: [
      {key: 'outerFlaps', label: 'Outer flaps', hint: '3D fold', default: 'L',
       choices: [{value: 'L', label: 'Length panels (major)'}, {value: 'W', label: 'Width panels (minor)'}]}
    ],
    geometry: fefco201,
    readouts: geo => [{label: 'Flap depth (W/2)', len: geo.meta.flapDepth}],
    defaultOrientations: ['LWH', 'WLH'],        // cases rotate about vertical only
    defaultClearance: {wall: 0, between: 0}
  },
  {
    id: 'a6120',
    name: 'ECMA A6120 Reverse Tuck End',
    brand: {code: 'ECMA A6120', sub: 'Reverse Tuck End'},
    tier: 'secondary',
    material: 'folding-carton',
    params: [
      {key: 'L',         label: 'Length',        hint: 'L',      group: 'dims',     min: 1, step: 1,    default: 100},
      {key: 'W',         label: 'Width',         hint: 'W',      group: 'dims',     min: 1, step: 1,    default: 60},
      {key: 'H',         label: 'Height',        hint: 'H',      group: 'dims',     min: 1, step: 1,    default: 150},
      {key: 'caliper',   label: 'Board caliper', hint: 't',      group: 'material', min: 0, step: 0.01, default: 0.457},
      {key: 'glueTab',   label: 'Glue tab',      hint: 'joint',  group: 'material', min: 0, step: 0.5,  default: 15},
      {key: 'dustDepth', label: 'Dust flap depth', hint: '0.625W', group: 'material', min: 0, step: 0.5, default: 37.5},
      {key: 'tuckDepth', label: 'Tuck depth',    hint: 'W − t',  group: 'material', min: 0, step: 0.5,  default: 59.543},
      {key: 'tuckTab',   label: 'Tuck tab',      hint: 'tab',    group: 'material', min: 0, step: 0.5,  default: 16},
      {key: 'cornerStyle', label: 'Tab corners', hint: '45°',    group: 'material', type: 'select', default: 'chamfered',
       choices: [{value: 'chamfered', label: 'Chamfered 45° × 5 mm'}]}
    ],
    options: [],
    geometry: a6120,
    readouts: geo => [
      {label: 'Tuck depth', len: geo.meta.tuckDepth},
      {label: 'Dust flap depth', len: geo.meta.dustDepth}
    ],
    // cartons in a case: stood on end or laid flat on the back — REVIEW
    // before the nesting task consumes these (flagged, not engineer-ruled)
    defaultOrientations: ['LWH', 'WLH', 'LHW', 'HLW'],
    defaultClearance: {wall: 0.5, between: 0}
  }
];

export const styleById = id => styles.find(s => s.id === id);
