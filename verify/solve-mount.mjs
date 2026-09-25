/**
 * Solves the fixed hand-space rotation that puts the rifle barrel along the
 * character's visual forward with the stock in the hands, and prints it as
 * Euler degrees for WEAPON.mountRotationDeg in config.ts.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(1500);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 60000 });
};
await frames(5);

console.log('--- attach log ---');
logs.filter((l) => l.includes('[weapon]')).forEach((l) => console.log(l));

const solved = await page.evaluate(() => {
  const g = window.__game;
  const V3 = g.player.position.constructor;
  const pivot = g.scene.getTransformNodeByName('weaponPivot');
  const Q = pivot.rotationQuaternion.constructor;
  const Matrix = pivot.getWorldMatrix().constructor;

  const hand = g.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name)).getTransformNode();
  const mesh = g.player.weapon.modelMesh;

  // Geometry axes in mesh-local space (same logic as Weapon.attach).
  mesh.refreshBoundingInfo(false);
  const b = mesh.getBoundingInfo().boundingBox;
  const size = b.maximum.subtract(b.minimum);
  const axes = ['x', 'y', 'z'];
  const barrelAxis = axes.reduce((a, c) => (size[c] > size[a] ? c : a), 'x');
  const upAxis = axes.filter((a) => a !== barrelAxis).sort((a, c) => size[c] - size[a])[0];
  // Muzzle direction along the barrel axis, read from the muzzle node (pivot space).
  const muzzle = g.player.weapon.muzzleNode;
  const muzzleSign = Math.sign(muzzle.position[barrelAxis]) || 1;

  const axisVector = (axis, sign) => new V3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
  const localBarrel = axisVector(barrelAxis, muzzleSign);
  const localUp = axisVector(upAxis, 1);
  const localThird = V3.Cross(localBarrel, localUp).normalize();

  hand.computeWorldMatrix(true);
  const handScale = new V3();
  const handRot = new Q();
  hand.getWorldMatrix().decompose(handScale, handRot);

  const fw = g.player.root.forward.clone();
  fw.y = 0;
  fw.normalize();

  const localBasis = new Matrix();
  Matrix.FromXYZAxesToRef(localBarrel, localUp, localThird, localBasis);
  const desiredBasis = new Matrix();
  Matrix.FromXYZAxesToRef(fw, V3.Up(), V3.Cross(fw, V3.Up()).normalize(), desiredBasis);

  // Same composition the old per-frame solve used (verified in-engine then):
  //   qLocal = inv(localBasis) * inv(handRotation) * desiredWorld
  const qLocal = Q.FromRotationMatrix(Matrix.Invert(localBasis))
    .multiply(Q.Inverse(handRot))
    .multiply(Q.FromRotationMatrix(desiredBasis));

  const e = qLocal.toEulerAngles();
  const deg = [e.x, e.y, e.z].map((r) => +(r * 180) / Math.PI);
  const norm = deg.map((d) => +d.toFixed(2));

  // Simulate: what world direction would the barrel point with this fixed quat?
  // pivotWorld = handWorld * T(pos) * R(qLocal) * S(1/handUnit); barrel = R(qLocal)*localBarrel in hand space -> world
  const barrelWorld = V3.TransformNormal(localBarrel, hand.getWorldMatrix().multiply(new Matrix()));
  // (proper check happens after applying it for real — this is informational)
  return {
    barrelAxis,
    upAxis,
    muzzleSign,
    solvedEulerDeg: norm,
    solvedQuat: qLocal.asArray().map((v) => +v.toFixed(4)),
    currentEulerDeg: (() => {
      const ce = pivot.rotationQuaternion.toEulerAngles();
      return [ce.x, ce.y, ce.z].map((r) => +((r * 180) / Math.PI).toFixed(2));
    })(),
  };
});
console.log('SOLVED:', JSON.stringify(solved, null, 1));
await browser.close();
