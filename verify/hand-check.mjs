/**
 * Hand-vs-gun diagnostic: measures where the right hand bone and the rifle
 * actually are in world space, and takes close-ups from several angles.
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

const measure = await page.evaluate(() => {
  const g = window.__game;
  const V = g.player.position.constructor;
  const bone = (re) => g.library.character.skeleton.bones.find((b) => re.test(b.name));
  const hand = bone(/RightHand$/i);
  const handIndex = [...g.library.character.skeleton.bones].findIndex((b) => /RightHandIndex/i.test(b.name));
  const handNode = hand.getTransformNode();
  const wrist = handNode.getAbsolutePosition();
  const pivot = g.scene.getTransformNodeByName('weaponPivot');
  const grip = pivot.getAbsolutePosition(); // pivot origin == grip point on the rifle
  const finger = handIndex >= 0 ? bone(new RegExp('RightHandIndex[0-9]*$|RightHandIndex$')).getTransformNode().getAbsolutePosition() : null;
  const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();

  // Hand-space offset between hand bone origin and the grip point
  const inv = handNode.getWorldMatrix().clone().invert();
  const gripInHand = V.TransformCoordinates(grip, inv);
  const gunMesh = g.player.weapon.modelMesh;
  gunMesh.computeWorldMatrix(true);
  const gb = gunMesh.getBoundingInfo().boundingBox;
  const gunLen = gb.maximumWorld.subtract(gb.minimumWorld).length();

  // hand scale
  const s = new V(), q = new (V.constructor === Object ? Object : Object)();
  const sv = new V(); const qv = { x: 0, y: 0, z: 0, w: 1 };
  handNode.getWorldMatrix().decompose(sv, qv);
  return {
    handScale: +sv.x.toFixed(4),
    wrist: [wrist.x, wrist.y, wrist.z].map((v) => +v.toFixed(3)),
    gripPoint: [grip.x, grip.y, grip.z].map((v) => +v.toFixed(3)),
    indexFinger: finger ? [finger.x, finger.y, finger.z].map((v) => +v.toFixed(3)) : null,
    muzzle: [muzzle.x, muzzle.y, muzzle.z].map((v) => +v.toFixed(3)),
    wristToGrip: +V.Distance(wrist, grip).toFixed(3),
    gripInHandSpace: [gripInHand.x, gripInHand.y, gripInHand.z].map((v) => +v.toFixed(3)),
    gunWorldLength: +gunLen.toFixed(2),
    handPosName: handNode.name,
  };
});
console.log(JSON.stringify(measure, null, 1));

// Close-ups from 4 angles: zoom in, orbit around the character
await page.evaluate(() => window.__game.camera.setZoom(-4.9)); // min distance 1.6
const yaws = [Math.PI, Math.PI * 0.6, Math.PI * 1.4, Math.PI + 0.9];
for (let i = 0; i < yaws.length; i++) {
  await page.evaluate((yaw) => {
    window.__game.camera.yaw = yaw;
    window.__game.camera.pitch = -0.05;
  }, yaws[i]);
  await frames(8);
  await page.screenshot({ path: `/home/user/hand-view-${i + 1}.png` });
}
console.log('saved hand-view-1..4.png');
await browser.close();
