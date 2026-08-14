/**
 * Perforation → 3D. RENDER ONLY, and STYLE-AGNOSTIC.
 *
 * TWO STATES, ONE PATH. A perforated container renders either as it SHIPS —
 * intact, with the tear drawn on the surface as a line — or in DISPLAY state,
 * with everything above the tear gone and the retained walls carrying the
 * profile. Both are built from `geo.perf.path`, the same polygonised points
 * core/perf.js handed the dieline and the DXF. Nothing here samples a curve,
 * fillets a corner, or decides a height: a 3D silhouette that disagreed with
 * the drawn tear line would be the two-computations failure in its most
 * expensive form, because the drawing is what gets made.
 *
 * The frame is the pack's canonical local one — centred on the origin, FRONT
 * toward +Z — the same frame hierarchy3d's boxes and artwork3d's tube use, so
 * a display body drops into every place a closed pack goes.
 *
 * The girth walk comes from `meta.artMap.section`: corner i to corner i+1 for
 * panel i, exactly as core/perf.js indexes it. UVs follow artwork3d's carton
 * convention (the section walk carries u REVERSED, which is what keeps the
 * print unmirrored), so a printed pack looks the same opened as closed.
 *
 * Walls are triangulated as a STRIP under the profile rather than through a
 * general polygon triangulator: for every profile segment, one quad from the
 * base up to the profile. The profile is a function of s, so that is exact for
 * every shape this module can be handed — ramps, s-curves, bows, staircases,
 * risers — and it costs no earcut and no winding surprises.
 */

/** How far the surface line stands off the board, as a fraction of caliper.
 *  Enough to beat depth fighting on a wall it lies exactly on. */
const LINE_LIFT = 0.35;

/** How far a wall is extended past its corner, in board thicknesses, so two
 *  walls meeting at a right angle close the corner instead of leaving a
 *  t x t notch. Purely cosmetic and invisible: the overlap is inside board. */
const CORNER_OVERLAP = 1.0;

/**
 * The girth frame in 3D: for each panel, its corner endpoints in the pack's
 * local (x, z), the unit direction along it, and its outward normal.
 * Returns null for a geometry with no resolved perforation.
 */
export function perfFrames3d(geo){
  const path = geo && geo.perf && geo.perf.path;
  const am = geo && geo.meta && geo.meta.artMap;
  if(!path || !am || !Array.isArray(am.section)) return null;
  const sec = am.section;
  return path.panels.map(p => {
    const a = sec[p.fromCorner], b = sec[p.toCorner];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d = [(b[0] - a[0])/len, (b[1] - a[1])/len];
    return {
      panel: p,
      a, b, d,
      n: [d[1], -d[0]],                 // outward normal of a section walked this way
      len
    };
  });
}

/** Board thickness the way hierarchy3d derives it — from the compensation the
 *  style already applied, never from a caliper floor. */
const boardT = geo => Math.max((geo.outer.L - geo.inner.L)/2, 0.3);

/** A profile extended past both corners so adjacent walls interpenetrate and
 *  the corner closes. The extension carries the corner's own height, so the
 *  retained heights at the corner are untouched. */
function extendProfile(pts, over){
  if(!pts.length) return pts;
  const first = pts[0], last = pts[pts.length - 1];
  return [[first[0] - over, first[1]], ...pts, [last[0] + over, last[1]]];
}

/**
 * The retained body of a pack in display state: four profiled walls and a
 * floor, in the pack's canonical local frame.
 *
 * Material groups follow artwork3d's convention — 0 = the printed walls,
 * 1 = board (the floor) — so `packArtMaterials(canvas, board)` clads it
 * unchanged and an unprinted pack passes board for both.
 *
 * @param {import('../core/types.js').Geometry} geo  carrying `perf.path`
 * @returns {THREE.BufferGeometry|null}
 */
export function perfBodyGeometry(geo){
  const frames = perfFrames3d(geo);
  if(!frames) return null;
  const am = geo.meta.artMap, CW = am.canvas.w, CH = am.canvas.h;
  const t = boardT(geo);
  const yBody = -geo.inner.H/2;                 // h = 0 is the body's bottom crease
  const yFloor = -geo.outer.H/2;                // the outside of the base

  const wallP = [], wallU = [], floorP = [], floorU = [];
  const tri = (P, Q, R, uP, uQ, uR, pA, uA) => { pA.push(...P, ...Q, ...R); uA.push(...uP, ...uQ, ...uR); };
  const quad = (A, B, C, D, uA, uB, uC, uD, pA, uAr) => {
    tri(A, B, C, uA, uB, uC, pA, uAr); tri(A, C, D, uA, uC, uD, pA, uAr);
  };

  for(const f of frames){
    const p = f.panel;
    // (s, h, off) -> local xyz. `off` is the distance outward from the inner
    // face, so 0 is the cavity side and t the printed side.
    const at = (s, h, off) => [
      f.a[0] + f.d[0]*s + f.n[0]*off,
      yBody + h,
      f.a[1] + f.d[1]*s + f.n[1]*off
    ];
    // artwork3d's carton mapping walks the section with u REVERSED — that is
    // what keeps the print unmirrored — so the display body reads the template
    // exactly as the closed body does.
    const uvAt = (s, h) => [(p.u1 - Math.min(Math.max(s, 0), p.width))/CW, (p.v0 + Math.max(h, 0))/CH];

    const prof = extendProfile(p.pts, t*CORNER_OVERLAP);
    for(let i = 0; i < prof.length - 1; i++){
      const [s0, h0] = prof[i], [s1, h1] = prof[i + 1];
      if(Math.abs(s1 - s0) < 1e-9 && Math.abs(h1 - h0) < 1e-9) continue;
      const u00 = uvAt(s0, 0), u10 = uvAt(s1, 0), u11 = uvAt(s1, h1), u01 = uvAt(s0, h0);
      // outer face, wound CCW seen from +n
      quad(at(s0, 0, t), at(s1, 0, t), at(s1, h1, t), at(s0, h0, t), u00, u10, u11, u01, wallP, wallU);
      // inner face, the other way round
      quad(at(s0, 0, 0), at(s0, h0, 0), at(s1, h1, 0), at(s1, 0, 0), u00, u01, u11, u10, wallP, wallU);
      // the torn edge itself: the band of board between the two faces
      quad(at(s0, h0, 0), at(s0, h0, t), at(s1, h1, t), at(s1, h1, 0), u01, u01, u11, u11, wallP, wallU);
    }
  }

  // floor: the outside of the base and the inside of the cavity. Its sides are
  // inside the walls, so they are never drawn.
  const oL = geo.outer.L/2, oW = geo.outer.W/2, iL = geo.inner.L/2, iW = geo.inner.W/2;
  quad([-oL, yFloor, -oW], [oL, yFloor, -oW], [oL, yFloor, oW], [-oL, yFloor, oW],
       [0, 0], [1, 0], [1, 1], [0, 1], floorP, floorU);
  quad([-iL, yBody, -iW], [-iL, yBody, iW], [iL, yBody, iW], [iL, yBody, -iW],
       [0, 0], [0, 1], [1, 1], [1, 0], floorP, floorU);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(wallP.concat(floorP), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(wallU.concat(floorU), 2));
  g.computeVertexNormals();
  const wallVerts = wallP.length/3, floorVerts = floorP.length/3;
  g.addGroup(0, wallVerts, 0);
  if(floorVerts) g.addGroup(wallVerts, floorVerts, 1);
  g.userData.spanMax = Math.max(geo.outer.L, geo.outer.W, geo.outer.H);
  // A RENDER IDENTITY TAG. A pin that calls this builder directly proves the
  // builder works and nothing about whether the app CALLS it — measured: two
  // wiring mutations (the hierarchy shell and the shelf facings both ignoring
  // display state) passed a pin written that way. The tag lets a pin read the
  // scene for the thing itself.
  g.userData.perfDisplay = true;
  return g;
}

/**
 * The tear as a SURFACE LINE — what shipping state shows. A line, not a cut
 * and not a gap: the pack is intact, and this is where it will open.
 *
 * Same points as the display profile and the drawn dieline, lifted a fraction
 * of a board thickness off the wall so it cannot z-fight with it.
 * @returns {THREE.BufferGeometry|null}  a LineSegments geometry
 */
export function perfLineGeometry(geo){
  const frames = perfFrames3d(geo);
  if(!frames) return null;
  const t = boardT(geo), yBody = -geo.inner.H/2, off = t*(1 + LINE_LIFT);
  const pos = [];
  for(const f of frames){
    const p = f.panel;
    const at = (s, h) => [
      f.a[0] + f.d[0]*s + f.n[0]*off,
      yBody + h,
      f.a[1] + f.d[1]*s + f.n[1]*off
    ];
    for(let i = 0; i < p.pts.length - 1; i++){
      pos.push(...at(p.pts[i][0], p.pts[i][1]), ...at(p.pts[i + 1][0], p.pts[i + 1][1]));
    }
  }
  if(!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** The surface-line material. Green, matching the 2D PERF layer and the DXF
 *  pen — one layer, one colour, wherever it is drawn. */
export function perfLineMaterial(){
  return new THREE.LineBasicMaterial({color: 0x1b8a4b, transparent: true, opacity: 0.95, depthTest: true});
}

/**
 * The pack as its state says to draw it, or null when it has no perforation.
 * Callers pass materials rather than a flag, so every site agrees about what a
 * state looks like — the same idiom `wrapMaterials` established for the wrap's
 * opened/closed pair.
 *
 * @param {Object} geo
 * @param {THREE.Material|THREE.Material[]} mats  [walls, board] or one material
 * @returns {THREE.Object3D|null}  display body, or null in shipping state
 */
export function perfDisplayBody(geo, mats){
  const g = perfBodyGeometry(geo);
  if(!g) return null;
  return new THREE.Mesh(g, mats);
}

/** The shipping-state overlay, ready to add beside an intact pack. */
export function perfSurfaceLine(geo){
  const g = perfLineGeometry(geo);
  return g ? new THREE.LineSegments(g, perfLineMaterial()) : null;
}
