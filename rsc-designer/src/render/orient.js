/**
 * Orientation → rotation basis. Pure (no THREE) so it can be unit-tested.
 *
 * A containment orientation string ABC means: the child's A dimension lies
 * along cavity L (world X), B along cavity W (world Z, depth), C along cavity
 * H (world Y, vertical). The child's local frame is x=L, y=H, z=W.
 *
 * Every orientation MUST resolve to a proper rotation (determinant +1). A bare
 * axis permutation is a reflection for odd permutations — a mirrored body,
 * which for a handed part is a mirrored dieline and a scrapped die. We flip a
 * HORIZONTAL column (never the vertical/up axis) to restore det +1; depth/
 * lateral sign is immaterial for a centred arrangement, and "up" is preserved.
 */

// world unit vector for each cavity slot: 0 -> X, 1 -> Z (depth), 2 -> Y (up)
const SLOT = [[1, 0, 0], [0, 0, 1], [0, 1, 0]];

const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

/** Determinant of the matrix whose columns are [colX, colY, colZ]. */
export const det3 = cols => dot(cols[0], cross(cols[1], cols[2]));

/**
 * @param {string} o  one of LWH WLH LHW HLW WHL HWL
 * @returns {number[][]} basis columns [image of local x(L), y(H), z(W)],
 *          guaranteed a proper rotation (det = +1).
 */
export function orientBasis(o){
  const cols = [SLOT[o.indexOf('L')].slice(), SLOT[o.indexOf('H')].slice(), SLOT[o.indexOf('W')].slice()];
  if(det3(cols) < 0){
    const vert = cols.findIndex(c => Math.abs(c[1]) > 0.5);   // the column pointing "up"
    const flip = (vert + 1) % 3;                              // a horizontal column
    cols[flip] = cols[flip].map(v => -v);
  }
  return cols;
}

export const ORIENTATIONS = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'];
