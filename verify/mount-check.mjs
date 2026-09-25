/**
 * Verify the fixed mount: grip at the hand, barrel along the character's
 * forward, and close-up screenshots from several angles.
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

const m = await page.evaluate(() => {
  const g = window.__game;
  const V3 = g.player.position.constructor;
  const pivot = g.scene.getTransformNodeByName('weaponPivot');
  const muzzle = g.player.weapon.muzzleNode;
  const hand = g.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name)).getTransformNode();
  const wrist = hand.getAbsolutePosition();
  const grip = pivot.getAbsolutePosition();
  const muz = muzzle.getAbsolutePosition();
  const barrel = muz.subtract(grip).normalize();
  const fw = g.player.root.forward.clone();
  fw.y = 0;
  fw.normalize();
  const dot = V3.Dot(barrel, fw);
  const e = pivot.rotationQuaternion.toEulerAngles().scale(180 / Math.PI);
  return {
    gripAtWrist: +V3.Distance(wrist, grip).toFixed(3),
    barrelDotForward: +dot.toFixed(3),
    barrelPitchDeg: +((Math.asin(Math.max(-1, Math.min(1, barrel.y))) * 180) / Math.PI).toFixed(1),
    rotationDeg: [e.x, e.y, e.z].map((v) => +v.toFixed(2)),
    position: pivot.position.asArray().map((v) => +v.toFixed(3)),
    muzzleY: +muz.y.toFixed(2),
    wristY: +wrist.y.toFixed(2),
  };
});
console.log(JSON.stringify(m, null, 1));
console.log('GUN IN HANDS (barrel forward):', m.barrelDotForward > 0.9, '| grip at wrist:', m.gripAtWrist < 0.15);

// Screenshots: idle close-ups from 3 angles
await page.evaluate(() => window.__game.camera.setZoom(-4.9));
const views = [
  [Math.PI, -0.05, 'idle-behind'],
  [Math.PI * 0.55, -0.02, 'idle-side'],
  [Math.PI * 1.5, -0.1, 'idle-other-side'],
];
for (const [yaw, pitch, name] of views) {
  await page.evaluate(([y, p]) => {
    window.__game.camera.yaw = y;
    window.__game.camera.pitch = p;
  }, [yaw, pitch]);
  await frames(8);
  await page.screenshot({ path: `/home/user/mount-${name}.png` });
}

// Fire a burst so we see the rifle during the FireRifle pose too
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(4);
await page.evaluate(() => {
  window.__game.camera.yaw = Math.PI;
  window.__game.camera.pitch = -0.05;
});
await frames(3);
await page.screenshot({ path: '/home/user/mount-firing.png' });
await page.evaluate(() => window.__game.input.setTouchFire(false));

// And while walking (arm swing vs fixed mount)
await page.evaluate(() => {
  window.__game.input.setTouchMove(0, 1);
});
await frames(30);
await page.screenshot({ path: '/home/user/mount-walking.png' });
await page.evaluate(() => window.__game.input.clearTouchMove());
console.log('saved mount-*.png');
await browser.close();
