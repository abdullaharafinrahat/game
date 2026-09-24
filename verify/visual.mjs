/**
 * Visual pass: gameplay-camera shots plus inspection shots (fog off, camera
 * parked) so the framing, scale and weapon placement can actually be judged.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = '/home/user/verify';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 240000 });

await page.evaluate(() => window.__game.start());
await page.waitForTimeout(3000);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 30000 });
};

console.log('SETTLED:', JSON.stringify(await page.evaluate(() => window.__game.debugInfo())));
console.log('COLUMN :', JSON.stringify(await page.evaluate(() => window.__dev.probeColumn())));
await page.screenshot({ path: `${OUT}/a-spawn.png` });

// Gameplay framing, aiming down the street.
await page.evaluate(() => {
  const g = window.__game;
  g.camera.yaw = Math.PI * 1.5;
  g.camera.pitch = -0.1;
});
await frames(6);
await page.screenshot({ path: `${OUT}/b-gameplay.png` });

// Walk a little so the locomotion blend is at walking weight.
await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await frames(25);
console.log('WALKING:', JSON.stringify(await page.evaluate(() => window.__game.debugInfo())));
await page.screenshot({ path: `${OUT}/c-walking.png` });
await page.evaluate(() => window.__game.input.clearTouchMove());

// ADS.
await page.evaluate(() => window.__game.input.toggleAim(true));
await frames(14);
await page.screenshot({ path: `${OUT}/d-ads.png` });
console.log('ADS    :', JSON.stringify(await page.evaluate(() => window.__game.debugInfo())));
await page.evaluate(() => window.__game.input.toggleAim(false));

// Fire, capture the frame right after the shot.
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(1);
await page.screenshot({ path: `${OUT}/e-fire.png` });
await page.evaluate(() => window.__game.input.setTouchFire(false));

// ---- Inspection shots: fog off, camera parked, loop paused --------------
await page.evaluate(() => {
  const g = window.__game;
  g.scene.fogMode = 0;
  g.paused = true;
  g.camera.update = () => undefined;
});
await frames(3);

const pose = async (dx, dy, dz, targetDy, file, fovDeg = 55) => {
  await page.evaluate(
    ({ dx, dy, dz, targetDy, fovDeg }) => {
      const g = window.__game;
      const p = g.player.position;
      const cam = g.camera.camera;
      cam.fov = (fovDeg * Math.PI) / 180;
      cam.position.set(p.x + dx, p.y + dy, p.z + dz);
      cam.setTarget(new (p.constructor)(p.x, p.y + targetDy, p.z));
    },
    { dx, dy, dz, targetDy, fovDeg },
  );
  await frames(3);
  await page.screenshot({ path: `${OUT}/${file}` });
};

await pose(2.4, 1.5, 2.4, 0.1, 'f-character-3q.png');
await pose(-1.5, 1.4, -1.5, 0.1, 'g-character-front.png');
await pose(0.9, 1.0, 0.9, 0.3, 'h-weapon-grip.png', 40);

// Wide shot from above the player to judge the street, buildings and scale.
await pose(26, 16, 26, 0, 'i-wide.png', 70);
console.log('\nerrors:', errors.length ? errors.slice(0, 5).join(' | ') : '(none)');
await browser.close();
