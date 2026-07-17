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
import {flowwrap} from './flowwrap.js';
import {trayGeometry} from './tray.js';
import {sealend} from './sealend.js';

const trayReadouts = geo => [
  {label: 'Board layers, bottom', text: String(geo.meta.boardLayersBottom)},
  {label: 'Board layers, top', text: String(geo.meta.boardLayersTop)}
];

export const styles = [
  {
    id: 'fefco201',
    name: 'FEFCO 201 Regular Slotted Container',
    brand: {code: 'FEFCO 201', sub: 'Regular Slotted Container'},
    tier: 'tertiary',
    material: 'corrugated',
    structure: 'rigid',
    dimsLabel: 'Inside dimensions',
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
    structure: 'rigid',
    dimsLabel: 'Inside dimensions',
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
  },
  {
    id: 'flowwrap',
    name: 'Flow Wrap (film)',
    brand: {code: 'FLOW WRAP', sub: 'Horizontal film wrap'},
    tier: 'primary',
    material: 'film',
    structure: 'flexible',
    // a flow wrap has no inside — these are the CONTENT ENVELOPE dims; the
    // outer (envelope + seals) is what actually sizes the carton
    dimsLabel: 'Content envelope',
    params: [
      {key: 'L', label: 'Pack length',   hint: 'repeat', group: 'dims', min: 1, step: 1, default: 90},
      {key: 'W', label: 'Pack width',    hint: 'front',  group: 'dims', min: 1, step: 1, default: 50},
      {key: 'H', label: 'Pack height',   hint: 'sides',  group: 'dims', min: 1, step: 1, default: 120},
      {key: 'sealType', label: 'Long. seal', hint: 'back', group: 'material', type: 'select', default: 'fin',
       choices: [{value: 'fin', label: 'Fin seal'}, {value: 'lap', label: 'Lap seal'}]},
      {key: 'finHeight',   label: 'Fin height',    hint: 'proud', group: 'material', min: 0, step: 0.5, default: 8},
      {key: 'finSealBand', label: 'Fin seal band', hint: 'sealed', group: 'material', min: 0, step: 0.5, default: 5},
      {key: 'finTreatment', label: 'Fin treatment', hint: '', group: 'material', type: 'select', default: 'folded',
       choices: [{value: 'folded', label: 'Folded down'}, {value: 'standing', label: 'Standing'}]},
      // the only two physically real closures for a HORIZONTAL wrapper —
      // a side face was never real (the seal can't land on the machine's
      // own direction of travel) and the compensation only ever grew H,
      // which was silently correct for these two and wrong for a side face
      // that was never actually offered a correct axis in the first place
      {key: 'finFace', label: 'Fin face', hint: 'closure', group: 'material', type: 'select', default: 'bottom',
       choices: [{value: 'bottom', label: 'Bottom (standard)'}, {value: 'top', label: 'Top'}]},
      {key: 'lapOverlap',   label: 'Lap overlap',   hint: 'lap only', group: 'material', min: 0, step: 0.5, default: 12},
      {key: 'endSealWidth', label: 'End seal width', hint: 'per end', group: 'material', min: 0, step: 0.5, default: 10},
      {key: 'endSealBleed', label: 'End seal bleed', hint: 'print',   group: 'material', min: 0, step: 0.5, default: 3},
      {key: 'girthBasis', label: 'Girth basis', hint: '', group: 'material', type: 'select', default: 'rectangular',
       choices: [{value: 'rectangular', label: 'Rectangular 2(W+H)'}, {value: 'round', label: 'Round π·d'}]},
      {key: 'roundDiameter', label: 'Round Ø', hint: 'round basis', group: 'material', min: 0, step: 0.5, default: 50},
      // film substance — NOT caliper; fixed units, never mm/in converted
      {key: 'gauge',   label: 'Film gauge', hint: '', group: 'material', min: 1, step: 1,    default: 30,   fixedUnit: 'µm'},
      {key: 'density', label: 'Density',    hint: '', group: 'material', min: 0.1, step: 0.01, default: 0.92, fixedUnit: 'g/cm³'}
    ],
    options: [],
    geometry: flowwrap,
    readouts: geo => [
      {label: 'Web width',  len: geo.meta.film.webWidth},
      {label: 'Repeat (cut length)', len: geo.meta.film.cutLength},
      {label: 'Film area / pack', text: `${geo.meta.film.filmAreaM2.toFixed(4)} m²`},
      {label: 'Packs / metre of web', text: geo.meta.film.packsPerMetre.toFixed(2)},
      {label: 'Film mass / 1000 packs', text: `${Math.round(geo.meta.film.massPer1000g)} g`}
    ],
    defaultOrientations: ['LWH', 'WLH'],
    defaultClearance: {wall: 0, between: 0}
  },
  {
    id: 'tray',
    name: 'FEFCO 0300 Tray',
    brand: {code: 'FEFCO 0300', sub: 'Die-cut tray, glued corners'},
    tier: 'tertiary',
    material: 'corrugated',
    structure: 'rigid',
    dimsLabel: 'Inside dimensions',
    params: [
      {key: 'L',       label: 'Length',        hint: 'L',     group: 'dims',     min: 1, step: 1,   default: 300},
      {key: 'W',       label: 'Width',         hint: 'W',     group: 'dims',     min: 1, step: 1,   default: 200},
      {key: 'H',       label: 'Height',        hint: 'H',     group: 'dims',     min: 1, step: 1,   default: 80},
      {key: 'caliper', label: 'Board caliper', hint: 't',     group: 'material', min: 0, step: 0.1, default: 3},
      {key: 'cornerFlapDepth', label: 'Corner flap depth', hint: '<=W/2', group: 'material', min: 0, step: 1, default: 40}
    ],
    options: [],
    geometry: trayGeometry,
    readouts: trayReadouts,
    defaultOrientations: ['LWH', 'WLH'],
    defaultClearance: {wall: 0, between: 0},
    // open top: the tray corrals FOOTPRINT only. Its own wall height (H) is
    // an independent design input, not solved from whatever's inside — a
    // level using this style may still override openTop: false (e.g. once
    // paired with a telescoping HSC cap, a future style, which DOES close it).
    defaultOpenTop: true
  },
  {
    id: 'sealend',
    name: 'Seal End Carton (glued overlap)',
    brand: {code: 'SEAL END', sub: 'Glued overlap closure'},
    tier: 'secondary',
    material: 'folding-carton',
    structure: 'rigid',
    dimsLabel: 'Inside dimensions',
    params: [
      {key: 'L',         label: 'Length',        hint: 'L',      group: 'dims',     min: 1, step: 1,    default: 100},
      {key: 'W',         label: 'Width',         hint: 'W',      group: 'dims',     min: 1, step: 1,    default: 60},
      {key: 'H',         label: 'Height',        hint: 'H',      group: 'dims',     min: 1, step: 1,    default: 150},
      {key: 'caliper',   label: 'Board caliper', hint: 't',      group: 'material', min: 0, step: 0.01, default: 0.457},
      {key: 'glueTab',   label: 'Glue tab',      hint: 'joint',  group: 'material', min: 0, step: 0.5,  default: 15},
      {key: 'dustDepth', label: 'Dust flap depth', hint: '0.625W', group: 'material', min: 0, step: 0.5, default: 37.5},
      {key: 'overlap',   label: 'Seal overlap',  hint: 'glue zone', group: 'material', min: 0, step: 0.5, default: 20},
      {key: 'cornerStyle', label: 'Corner style', hint: '45°',   group: 'material', type: 'select', default: 'chamfered',
       choices: [{value: 'chamfered', label: 'Chamfered 45°'}]}
    ],
    options: [],
    geometry: sealend,
    readouts: geo => [
      {label: 'Major flap depth (W/2)', len: geo.meta.majorFlapDepth},
      {label: 'Seal flap depth (W/2 + overlap/2)', len: geo.meta.sealFlapDepth},
      {label: 'Dust flap depth', len: geo.meta.dustDepth},
      {label: 'Overlap', len: geo.meta.overlap}
    ],
    defaultOrientations: ['LWH', 'WLH', 'LHW', 'HLW'],
    defaultClearance: {wall: 0.5, between: 0}
  }
];

export const styleById = id => styles.find(s => s.id === id);
