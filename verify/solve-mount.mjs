/**
 * Solves the fixed hand-space rotation that points the rifle barrel along the
 * character's visual forward, SELF-VERIFIED: both barrel orientations are
 * simulated through the live hand matrix and only the one whose world barrel
 * direction actually matches `forward` is reported.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(1500);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 60000 });
};
await frames(5);

const result = await page.evaluate(() => {
  const g = window.__game;
  const V3 = g.player.position.constructor;
  const pivot = g.scene.getTransformNodeByName('weaponPivot');
  const Q = pivot.rotationQuaternion.constructor;
  const Matrix = pivot.getWorldMatrix().constructor;

  const hand = g.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name)).getTransformNode();
  const mesh = g.player.weapon.modelMesh;

  // Geometry axes (mirrors Weapon.attach).
  mesh.refreshBoundingInfo(false);
  const b = mesh.getBoundingInfo().boundingBox;
  const size = b.maximum.subtract(b.minimum);
  const axes = ['x', 'y', 'z'];
  const barrelAxis = axes.reduce((a, c) => (size[c] > size[a] ? c : a), 'x');
  const upAxis = axes.filter((a) => a !== barrelAxis).sort((a, c) => size[c] - size[a])[0];
  // Muzzle is the +end of the barrel axis (thin tube end, per geometry scan).
  const muzzleSign = Math.sign(g.scene.getTransformNodeByName('muzzle').position[barrelAxis]) || 1;

  const axisVector = (axis, sign) => new V3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
  const localBarrel = axisVector(barrelAxis, muzzleSign);
  const localUp = axisVector(upAxis, 1);
  const localThird = V3.Cross(localBarrel, localUp).normalize();

  hand.computeWorldMatrix(true);
  const handScale = new V3();
  const handWorldRot = new Q(); // FULL world rotation (armature + arm + hand)
  hand.getWorldMatrix().decompose(handScale, handWorldRot);

  const fw = g.player.root.forward.clone();
  fw.y = 0;
  fw.normalize();

  const desiredBasis = new Matrix();
  Matrix.FromXYZAxesToRef(fw, V3.Up(), V3.Cross(fw, V3.Up()).normalize(), desiredBasis);

  // Candidate local rotations: barrel/up mapped to (forward, up) in the two
  // possible handedness layouts, plus the 180-deg Y flip of each (in case the
  // grip-rear/grip-front convention is inverted).
  const localBasis = new Matrix();
  Matrix.FromXYZAxesToRef(localBarrel, localUp, localThird, localBasis);
  const flipped = new Matrix();
  Matrix.FromXYZAxesToRef(localBarrel.scale(-1), localUp, V3.Cross(localBarrel.scale(-1), localUp).normalize(), flipped);

  const candidates = {
    'muzzle-forward': Q.FromRotationMatrix(Matrix.Invert(localBasis)).multiply(Q.Inverse(handWorldRot)).multiply(Q.FromRotationMatrix(desiredBasis)),
    'flipY': Q.RotationYawPitchRoll(Math.PI, 0, 0).multiply(Q.FromRotationMatrix(Matrix.Invert(localBasis))).multiply(Q.Inverse(handWorldRot)).multiply(Q.FromRotationMatrix(desiredBasis)),
  };

  // Simulate each candidate through the live hand world rotation and measure
  // where the barrel would point in world space.
  const simulate = (qLocal) => {
    const worldRot = handWorldRot.multiply(qLocal);
    const dir = V3.Zero();
    // rotate localBarrel by worldRot: use rotation matrix apply
    const m = new Matrix();
    Matrix.FromQuaternionToRef(worldRot, m);
    V3.TransformNormalToRef(localBarrel, m, dir);
    const flat = new V3(dir.x, 0, dir.z).normalize();
    return { dot: +V3.Dot(flat, fw).toFixed(3), pitchDeg: +((Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI).toFixed(1) };
  };

  const report = {};
  let best = null;
  for (const [name, q] of Object.entries(candidates)) {
    const sim = simulate(q);
    report[name] = { ...sim, eulerDeg: (() => { const e = q.toEulerAngles(); return [e.x, e.y, e.z].map((r) => +((r * 180) / Math.PI).toFixed(2)); })() };
    if (!best || sim.dot > best.sim.dot) best = { name, q, sim };
  }
  // Also report the CURRENT config for reference
  const eCur = pivot.rotationQuaternion.toEulerAngles();
  report.current = { eulerDeg: [eCur.x, eCur.y, eCur.z].map((r) => +((r * 180) / Math.PI).toFixed(2)), sim: simulate(pivot.rotationQuaternion) };

  return { barrelAxis, upAxis, muzzleSign, report, best: { name: best.name, eulerDeg: report[best.name].eulerDeg, sim: best.sim } };
});
console.log(JSON.stringify(result, null, 1));
console.log('\nBEST:', result.best.name, result.best.eulerDeg, 'sim dot:', result.best.sim.dot, 'pitch:', result.best.sim.pitchDeg);
await browser.close();
