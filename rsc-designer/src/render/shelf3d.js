/**
 * Retail shelf visualization — RENDER ONLY. The packing itself is core
 * containment: app.js's refreshShelf runs fitInto with the shelf opening
 * (width × depth × height) as the cavity and the sellable pack's outer as the
 * child, exactly like every other parent; this module only draws the result.
 *
 * A base surface the product sits on, a back wall, and the shelf above drawn
 * as a translucent ceiling plane (empty — it only sets the height ceiling).
 * Packs are stocked at the placements fitInto returned (subset to the user's
 * facings/stack/deep, filled from the back forward). The pack's front face —
 * toward the shopper at -Z — gets a distinct "label" material so the chosen
 * front panel reads at a glance and artwork can drop onto that face later.
 *
 * Coordinate mapping mirrors the pallet render: world x = across (placement x),
 * world y = up (placement z), world z = depth (placement y). All lengths mm.
 */
import {getPivot, setCamSpan, kraft, onFrame} from './fold3d.js';
import {packArtGeometry, packArtMaterials} from './artwork3d.js';
import {buildSellableCutaway, closedWrapParts, orientQuat} from './hierarchy3d.js';

let shelfGroup = null;
let shelfArtMat = null;                 // per-build art material+texture, disposed on rebuild
let shelfCutWalls = [];                 // {mesh, n} of the ONE opened front pack — near walls hidden per frame
let shelfFrameOff = null;               // the shelf's own frame loop, registered once
const SHOWN_CAP = 4000;            // instancing cap for absurd inputs
const PACK_GAP = 1.5;              // visual seam between packs
const SURFACE_T = 10;              // shelf / ceiling / wall board thickness, mm

const shelfMat = new THREE.MeshStandardMaterial({color: 0xCED4DA, roughness: 0.95, metalness: 0, side: THREE.DoubleSide});
const wallMat  = new THREE.MeshStandardMaterial({color: 0xDCE1E6, roughness: 0.95, metalness: 0, side: THREE.DoubleSide});
const ceilMat  = new THREE.MeshStandardMaterial({color: 0xC7CED5, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.26, side: THREE.DoubleSide});
// the shopper-facing panel — a light "label" tint so the front is unmistakable
const frontMat = new THREE.MeshStandardMaterial({color: 0xEFE7D2, roughness: 0.85, metalness: 0});
// BoxGeometry material groups are ordered +x,-x,+y,-y,+z,-z. The shopper faces
// -Z, so the front panel is group index 5.
const packMats = [kraft, kraft, kraft, kraft, kraft, frontMat];

/* The pack's canonical frame: x = L, y = H, z = W (hierarchy3d builds every
 * pack in it). meta.frontFace names the display face by the axis of its
 * outward normal, and the sign is POSITIVE — the flow wrap's printed band and
 * the tray's open top are both +H. */
const PACK_AXIS = {L: [1, 0, 0], H: [0, 1, 0], W: [0, 0, 1]};

/**
 * The orientation that puts the pack's declared display face where the shopper
 * can see it.
 *
 * orientQuat() maps AXES only — never front/back or up/down parity (orient.js
 * says so, and flips a horizontal column purely to keep the rotation proper).
 * So the declared front normal can land on the BACK, and it did: a wrapped tray
 * pointed its open top at the back wall and showed the shopper the underside of
 * the tray, cookies hidden. Nothing in the axis mapping can catch that, because
 * the axis was right.
 *
 * Here the pack is turned 180° about the VERTICAL when its front normal comes
 * out facing the shelf's back (local +Z) — the opposite face comes forward and
 * "up" is untouched, unlike a flip about the across axis, which would present
 * the face upside down. This also subsumes the art path's old hardcoded 180°:
 * the artMap's FRONT is +Z of ITS frame, which is exactly the declared front
 * axis, so an upright tube carton still gets the same turn it always got.
 */
function faceShopperQuat(frontO, frontAxis){
  const q = orientQuat(frontO);
  const n = new THREE.Vector3(...(PACK_AXIS[frontAxis] || PACK_AXIS.W)).applyQuaternion(q);
  if(n.z > 0.5)                                       // pointing at the back wall
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  return q;
}

/**
 * @param {{l:number,w:number,h:number}} od  oriented pack dims (l across, w deep, h up)
 * @param {{width:number,depth:number,height:number}} shelf
 * @param {{x:number,y:number,z:number}[]} placements  fitInto placements (subset), cavity-centred
 * @param {boolean} visible
 * @param {{am:object, canvas:HTMLCanvasElement}|null} [art]  the sellable pack's
 *        artwork: every facing pack shows it, printed FRONT to the shopper. The
 *        caller packs in the print-front orientation ('LWH') so the pack's
 *        canonical footprint (L across, W deep, H up) matches od.
 * @param {number} [rotDeg]  in-plane spin of the forward face about the DEPTH
 *        axis (0/90/180/270), clockwise to the shopper. The SAME face stays
 *        forward — a side/back is never shown; picking the forward face is the
 *        caller's `front` selector, orthogonal to this. `od` is always the
 *        pack's TRUE front-facing dims; the box is built from them and spun, and
 *        the caller lays the placement grid on the ROTATED footprint (across↔up
 *        swapped at 90°/270°) so the spun box lands exactly in its cell. Rigid
 *        rotation → artwork turns with the face, never flips or mirrors.
 */
/**
 * @param {object} [opts]  {cutaway, bundle, noun, frontO} — when cutaway is true
 *        and a bundle is given, the ONE shopper-facing pack (front row, centred,
 *        bottom) is drawn opened (translucent shell + real contents) while every
 *        other facing stays a solid printed/board pack. `noun` is the sellable
 *        tier ('carton'|'case'); `frontO` is the pack's front-panel orientation.
 */
/**
 * The roll (0/90/180/270°, about the DEPTH axis) that stands the pack's
 * declared display face THE RIGHT WAY UP.
 *
 * meta.frontFace says which face the shopper sees; faceShopperQuat gets that
 * face pointing forward. Neither says which way is UP on it — an orientation
 * string maps axes only, so of the two directions perpendicular to the front
 * normal, "up" is whichever one the string happens to name, and for the flow
 * wrap that is the wrong one: the girth walk puts the template's up toward −W
 * on the top face, the orientation puts +W up, and every printed wrap on the
 * shelf stood on its head. Rotate 90° was the only way to correct it by hand.
 *
 * meta.frontUp names the pack-frame direction that is up on the display face
 * ('+H', '-W', ...), and this returns the quarter-turn that takes it there.
 * The result composes with the user's own Rotate 90° — it is the same in-plane
 * spin about the same axis — so the caller adds the two and the fill and the
 * render both follow one number.
 *
 * @param {string} frontO   the orientation the pack is presented in
 * @param {string} frontAxis  meta.frontFace
 * @param {string} frontUp  meta.frontUp, or null/undefined for no roll
 * @returns {number} degrees, one of 0/90/180/270
 */
export function faceUpRoll(frontO, frontAxis, frontUp){
  if(!frontUp) return 0;
  const sign = frontUp[0] === '-' ? -1 : 1;
  const ax = PACK_AXIS[frontUp.replace(/^[+-]/, '')];
  if(!ax) return 0;
  const v = new THREE.Vector3(...ax).multiplyScalar(sign)
    .applyQuaternion(faceShopperQuat(frontO, frontAxis));
  // the declared up should lie in the shopper's view plane; if the caller has
  // presented a face that consumes it (up pointing at the shopper), there is
  // no roll that helps
  if(Math.hypot(v.x, v.y) < 1e-6) return 0;
  const deg = Math.round((90 - Math.atan2(v.y, v.x)*180/Math.PI)/90)*90;
  return ((deg % 360) + 360) % 360;
}

export function buildShelf(od, shelf, placements, visible, art, rotDeg = 0, opts = {}){
  const pivot = getPivot();
  if(shelfGroup){ pivot.remove(shelfGroup); shelfGroup.traverse(o => { if(o.geometry) o.geometry.dispose(); }); }
  if(shelfArtMat){ if(shelfArtMat.map) shelfArtMat.map.dispose(); shelfArtMat.dispose(); shelfArtMat = null; }
  shelfCutWalls = [];                             // reset the opened-pack cutaway state each build
  shelfGroup = new THREE.Group();
  const W = shelf.width, D = shelf.depth, H = shelf.height, t = SURFACE_T;

  // the fixture (base/back/ceiling) is NAMED so a measurement can tell the
  // shelf itself from what is stocked on it — the packs are what any pin about
  // orientation or draw calls is actually asking about
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, t, D), shelfMat);
  base.name = 'shelfFixture';
  base.position.set(0, -t/2, 0);                        // top surface at y = 0
  shelfGroup.add(base);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(W, H + t, t), wallMat);
  wall.name = 'shelfFixture';
  wall.position.set(0, (H + t)/2 - t, D/2 + t/2);       // back wall at the far depth (+Z)
  shelfGroup.add(wall);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(W, t, D), ceilMat);
  ceil.name = 'shelfFixture';
  ceil.position.set(0, H + t/2, 0);                     // the shelf above (empty ceiling)
  shelfGroup.add(ceil);

  // Cutaway mode: the single shopper-facing pack (front row, centred across,
  // bottom) opens; all others stay solid. -1 when solid mode, no bundle, or no
  // packs — then nothing is skipped and the instanced fill is bit-identical.
  const cut = !!(opts.cutaway && opts.bundle && placements.length);
  const openIdx = cut ? frontCenterIndex(placements) : -1;

  const shown = Math.min(placements.length, SHOWN_CAP);
  if(shown > 0){
    // the opened pack (if any) is drawn separately below; skip it in the fill
    const solidPl = openIdx < 0 ? placements : placements.filter((_, i) => i !== openIdx);
    const printed = !!(art && art.am && art.canvas);
    // THE PACK, not a stand-in. A filmed wrap is a pillow with ramped, crimped
    // ends; drawn as a rectangular box, every facing except the opened one lied
    // about the product's own shape — on the one view whose entire job is what
    // the shopper sees. The parts come from the SAME builder the hierarchy's
    // closed wraps use (closedWrapParts), in the same canonical frame, so the
    // facings and the opened pack can never be two different packs. Still ONE
    // InstancedMesh per part, so draw calls stay flat in the facing count
    // exactly as the single box did.
    // A WRAP always comes from closedWrapParts — printed or not. The artwork
    // path used to fork here to packArtGeometry, the flat-pattern art TUBE,
    // whose cross-section is built from the artMap's girth BAND WIDTHS
    // (template mm, not the pack's physical dims) and whose crimped ends are
    // open (`ends` present -> no caps): printed facings rendered as hollow
    // planes you could see straight through, while unprinted facings were
    // correct pillows. The texture is a MATERIAL, not a shape —
    // closedWrapParts carries it on the real body via the bundle's own art.
    const wrapParts = opts.wrapBundle ? closedWrapParts(opts.wrapBundle) : [];
    if(wrapParts.length){
      // the parts are canonical-frame, so they take the SAME orientation the
      // opened pack takes (front-panel quat, then the in-plane spin) — one
      // placement rule for every facing, opened or not
      const q = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotDeg*Math.PI/180)
        .multiply(faceShopperQuat(opts.frontO || 'LWH', opts.frontAxis));
      const M = new THREE.Matrix4();
      for(const pd of wrapParts){
        const inst = new THREE.InstancedMesh(pd.geo, pd.mat, solidPl.length);
        solidPl.forEach((p, i) => {
          M.makeRotationFromQuaternion(q);
          M.setPosition(p.x, p.z, p.y);                  // (across, up, depth)
          inst.setMatrixAt(i, M);
        });
        shelfGroup.add(inst);
      }
    }else{
      let pgeo, pmat, rot = false;
      if(printed){
        // printed pack: the shared closed art body. packArtGeometry's FRONT is
        // +Z; the shelf's front (frontMat) is local -Z, so rotate each pack 180°
        // about the vertical to match — then the group's own 180° (below) carries
        // both to the shopper side. One shared texture across every facing pack.
        pgeo = packArtGeometry(art.am);
        const mats = packArtMaterials(art.canvas, kraft);
        shelfArtMat = mats[0];
        pmat = mats; rot = true;
      }else{
        pgeo = new THREE.BoxGeometry(Math.max(od.l - PACK_GAP, 1), Math.max(od.h - PACK_GAP, 1), Math.max(od.w - PACK_GAP, 1));
        pmat = packMats;
      }
      const inst = new THREE.InstancedMesh(pgeo, pmat, solidPl.length);
      // TWO rotations about DIFFERENT axes, kept separate:
      //  • A — art-front alignment (art packs only): packArtGeometry already
      //    builds the tube laid out for the pack's OWN front orientation (an
      //    upright carton comes out L across / H up / W deep, a flow wrap L
      //    across / W up / H deep), so the tube needs no orientation rotation —
      //    only the 180° about the VERTICAL that turns its FRONT (+Z of that
      //    frame, i.e. the shelf's back) toward the shopper. Running it through
      //    faceShopperQuat instead applies the orientation TWICE and stands the
      //    pack on the wrong axis; measured, it put a printed wrap 49mm tall
      //    where it should be 172.
      //  • S — the user's Rotate 90°: spin the forward face IN ITS OWN PLANE, about
      //    the DEPTH axis (local Z, the shopper→back axis). The same face stays
      //    forward — only its content turns — so a side/back face is never shown.
      //    +rotDeg reads CLOCKWISE to the shopper (verified from the ViewCube
      //    FRONT: the → arrow goes right→bottom→left→top over the cycle). Because
      //    S is about Z and the front normal IS the Z axis, S never disturbs which
      //    face points forward.
      // rotDeg=0 → S is identity, so the matrix is exactly the pre-rotation one
      // (bit-identical default: identity for board packs, A for art packs).
      const A = new THREE.Matrix4().makeRotationY(Math.PI);
      const S = new THREE.Matrix4().makeRotationZ(rotDeg*Math.PI/180);
      const M = new THREE.Matrix4();
      for(let i = 0; i < solidPl.length; i++){
        const p = solidPl[i];
        if(rot) M.copy(A); else M.identity();
        M.premultiply(S);                                // spin in-plane about the depth axis
        M.setPosition(p.x, p.z, p.y);                     // (across, up, depth)
        inst.setMatrixAt(i, M);
      }
      shelfGroup.add(inst);
    }
  }

  // the ONE opened front pack: canonical-frame cutaway (shell + real contents),
  // oriented to the front panel (orientQuat) then spun in-plane about the depth
  // axis to match the solid packs, positioned in the same (across, up, depth)
  // frame. Its near walls are hidden per-frame by the shelf's own loop below.
  if(cut && openIdx >= 0){
    const p = placements[openIdx];
    const {group: packG, walls} = buildSellableCutaway(opts.bundle, opts.noun);
    const openG = new THREE.Group();
    openG.add(packG);
    openG.quaternion.copy(faceShopperQuat(opts.frontO || 'LWH', opts.frontAxis));
    openG.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotDeg*Math.PI/180));
    openG.position.set(p.x, p.z, p.y);
    shelfGroup.add(openG);
    shelfCutWalls = walls;
  }

  shelfGroup.position.y = -H/2;                         // centre vertically for orbit
  // The shelf was built with the pack fronts at local -Z and the back wall at
  // +Z, but the ViewCube's FRONT looks down the opposite axis — so a straight
  // FRONT view showed the pack backs. Rotate the whole assembly 180° about the
  // vertical so its front IS the world front the ViewCube names.
  shelfGroup.rotation.y = Math.PI;
  shelfGroup.visible = visible;
  pivot.add(shelfGroup);
  setCamSpan(Math.max(W, D, H)*0.95);
  ensureCutFrame();
}

// The shopper-facing pack: front row (smallest depth y), then centred across
// (smallest |x|), then bottom (smallest up z). This is the pack a shopper reaches
// for, so it's the one the cutaway opens.
function frontCenterIndex(placements){
  let best = -1, by = 0, bx = 0, bz = 0;
  placements.forEach((p, i) => {
    if(best < 0 || p.y < by - 1e-6 ||
       (Math.abs(p.y - by) < 1e-6 && (Math.abs(p.x) < bx - 1e-6 ||
       (Math.abs(Math.abs(p.x) - bx) < 1e-6 && p.z < bz - 1e-6)))){
      best = i; by = p.y; bx = Math.abs(p.x); bz = p.z;
    }
  });
  return best;
}

// One persistent frame loop hides the opened front pack's near walls as the
// camera orbits — the same rule the hierarchy cutaway uses (a wall whose outward
// normal points toward the camera is hidden). Reads module state, so it is inert
// (empty wall list, or shelf hidden) in every other view and when solid.
const _wp = new THREE.Vector3(), _wn = new THREE.Vector3(), _q = new THREE.Quaternion(), _toCam = new THREE.Vector3();
function ensureCutFrame(){
  if(shelfFrameOff) return;
  shelfFrameOff = onFrame(cam => {
    if(!shelfGroup || !shelfGroup.visible || !shelfCutWalls.length) return;
    for(const {mesh, n} of shelfCutWalls){
      mesh.getWorldPosition(_wp); mesh.getWorldQuaternion(_q);
      _wn.copy(n).applyQuaternion(_q);
      _toCam.copy(cam.position).sub(_wp);
      mesh.visible = _wn.dot(_toCam) <= 0;              // hide walls facing the camera
    }
  });
}

export function showShelf(v){ if(shelfGroup) shelfGroup.visible = v; }
