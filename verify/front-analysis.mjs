/**
 * FRONT-view gun analysis: the camera is placed in front of the character
 * (looking at his face/chest) so the barrel direction is unambiguous.
 * The muzzle flash marker is pinned to the muzzle node, so the bright end in
 * each shot IS the muzzle. Also measures dot(barrel, direction-to-camera):
 * from the front it must be strongly POSITIVE (gun points at the viewer).
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

// Pin the muzzle flash plane ON so the muzzle end is visible from any angle.
await page.evaluate(() => {
  const flash = window.__game.scene.getMeshByName('muzzleFlash');
  flash.setEnabled(true);
  flash.material.alpha = 1;
});
await frames(2);

const measure = (label) =>
  page.evaluate((lbl) => {
    const g = window.__game;
    const V3 = g.player.position.constructor;
    const pivot = g.scene.getTransformNodeByName('weaponPivot');
    const muz = g.player.weapon.muzzleNode.getAbsolutePosition();
    const grip = pivot.getAbsolutePosition();
    const camPos = g.camera.camera.globalPosition;
    const barrel = muz.subtract(grip).normalize();
    const toCamera = camPos.subtract(grip).normalize();
    const fw = g.player.root.forward.clone();
    fw.y = 0;
    fw.normalize();
    return {
      label: lbl,
      barrelDotCharForward: +V3.Dot(barrel, fw).toFixed(3),
      barrelDotToCamera: +V3.Dot(barrel, toCamera).toFixed(3),
      note: 'from the front, barrelDotToCamera must be POSITIVE (muzzle faces the viewer)',
    };
  }, label);

await page.evaluate(() => window.__game.camera.setZoom(-4.9));

// FRONT views: yaw = 0 puts the camera in front of the character (he faces it).
const views = [
  [0.0, -0.04, 'front-center'],
  [Math.PI / 4, -0.03, 'front-right-45'],
  [-Math.PI / 4, -0.03, 'front-left-45'],
];
for (const [yaw, pitch, name] of views) {
  await page.evaluate(([y, p]) => {
    window.__game.camera.yaw = y;
    window.__game.camera.pitch = p;
  }, [yaw, pitch]);
  await frames(8);
  console.log(JSON.stringify(await measure(name)));
  await page.screenshot({ path: `/home/user/front-${name}.png` });
}

// TOP-DOWN: highest clarity for forward/backward — pitch camera down from the
// front-side so we see head direction + rifle plane together.
await page.evaluate(() => {
  window.__game.camera.yaw = Math.PI / 3;
  window.__game.camera.pitch = 0.85;
});
await frames(8);
console.log(JSON.stringify(await measure('top-down')));
await page.screenshot({ path: '/home/user/front-topdown.png' });

// FIRING, seen from the front-left: flash must bloom toward the viewer.
await page.evaluate(() => {
  window.__game.camera.yaw = -Math.PI / 3;
  window.__game.camera.pitch = -0.02;
});
await frames(4);
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(4);
console.log(JSON.stringify(await measure('firing-front-left')));
await page.screenshot({ path: '/home/user/front-firing.png' });
await page.evaluate(() => window.__game.input.setTouchFire(false));

await browser.close();
console.log('saved front-*.png');
