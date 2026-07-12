/**
 * Fold-builder lookup, keyed by style id. This registry dispatch is the
 * ONE place a style id selects behaviour on the render side — renderers
 * themselves contain no style conditionals.
 */
import {fefco201Fold} from './fefco201.js';
import {a6120Fold} from './a6120.js';
import {flowwrapFold} from './flowwrap.js';

export const foldBuilders = {
  fefco201: fefco201Fold,
  a6120: a6120Fold,
  flowwrap: flowwrapFold
};
