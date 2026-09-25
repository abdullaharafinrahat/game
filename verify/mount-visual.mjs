/**
 * Close-range visual proof: the muzzle flash plane (pinned to the muzzle node)
 * is forced always-on, so the screenshots show exactly which end is the muzzle.
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

// Force the muzzle flash plane on: it is parented to the muzzle node, so it
// glows exactly where rounds come from.
await page.evaluate(() => {
  const g = window.__game;
  const flash = g.scene.getMeshByName('muzzleFlash');
  flash.setEnabled(true);
  flash.material.alpha = 1;
  window.__flash = flash;
});
await frames(2);

const m = await page.evaluate(() => {
  const g = window.__game;
  const V3 = g.player.position.constructor;
  const pivot = g.scene.getTransformNodeByName('weaponPivot');
  const muzzle = g.player.weapon.muzzleNode;
  const grip = pivot.getAbsolutePosition();
  const muz = muzzle.getAbsolutePosition();
  const barrel = muz.subtract(grip).normalize();
  const fw = g.player.root.forward.clone();
  fw.y = 0;
  fw.normalize();
  // muzzle node local X in pivot space tells the sign directly
  return {
    muzzleLocalX: +g.scene.getTransformNodeByName('muzzle').position.x.toFixed(3),
    barrelDotForward: +V3.Dot(barrel, fw).toFixed(3),
    barrelPitchDeg: +((Math.asin(Math.max(-1, Math.min(1, barrel.y))) * 180) / Math.PI).toFixed(1),
    flashPos: muz.asArray().map((v) => +v.toFixed(2)),
  };
});
console.log(JSON.stringify(m));
console.log('muzzle on +X:', m.muzzleLocalX > 0, '| barrel dot forward:', m.barrelDotForward);

await page.evaluate(() => window.__game.camera.setZoom(-4.9));
const views = [
  [Math.PI, -0.05, 'A-behind'],
  [Math.PI * 0.5, -0.02, 'B-side-profile'],
  [Math.PI * 0.78, 0.0, 'C-side-close'],
];
for (const [yaw, pitch, name] of views) {
  await page.evaluate(([y, p]) => {
    window.__game.camera.yaw = y;
    window.__game.camera.pitch = p;
  }, [yaw, pitch]);
  await frames(8);
  await page.screenshot({ path: `/home/user/fix-${name}.png` });
}

// One firing frame: flash light + sparks from the muzzle end.
await page.evaluate(() => {
  window.__game.camera.yaw = Math.PI * 0.8;
  window.__game.camera.pitch = -0.03;
});
await frames(2);
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(1);
await page.screenshot({ path: '/home/user/fix-D-firing.png' });
await page.evaluate(() => window.__game.input.setTouchFire(false));
console.log('saved fix-*.png');
await browser.close();
