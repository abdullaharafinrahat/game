import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${process.env.GAME_URL ?? 'http://localhost:5173'}/?q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => { window.__game.start(); });
await page.waitForTimeout(2500);

// Walk forward for a while, then photograph what the player sees.
await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await page.waitForTimeout(3000);
const walking = await page.evaluate(() => {
  const g = window.__game;
  const cam = g.camera.camera;
  const p = g.player.position;
  const toPlayer = p.subtract(cam.globalPosition);
  toPlayer.y = 0; toPlayer.normalize();
  const view = cam.getDirection(new (p.constructor)(0,0,1)); view.y = 0; view.normalize();
  return {
    cameraBehindPlayer: +(toPlayer.x*view.x + toPlayer.z*view.z).toFixed(3),
    speed: +g.player.speed.toFixed(2),
    animLayers: [...g.player.animation.layers.entries()].filter(([,l]) => l.group.isPlaying && l.weight > 0.01).map(([n,l]) => `${n}=${l.weight.toFixed(2)}`),
  };
});
console.log('walking:', JSON.stringify(walking));
await page.screenshot({ path: '/home/user/verify/fix-01-walking.png' });

await page.evaluate(() => { window.__game.input.clearTouchMove(); window.__game.input.setTouchSprint(true); });
await page.waitForTimeout(200);
await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await page.waitForTimeout(2500);
await page.screenshot({ path: '/home/user/verify/fix-02-sprinting.png' });
await page.evaluate(() => { window.__game.input.clearTouchMove(); window.__game.input.setTouchSprint(false); });
await page.waitForTimeout(1200);

// Aim down the sights, then fire.
await page.evaluate(() => window.__game.input.toggleAim(true));
await page.waitForTimeout(1500);
await page.screenshot({ path: '/home/user/verify/fix-03-aiming.png' });
await page.evaluate(() => window.__game.input.setTouchFire(true));
await page.waitForTimeout(120);
await page.screenshot({ path: '/home/user/verify/fix-04-firing.png' });
await page.waitForTimeout(900);
await page.evaluate(() => window.__game.input.toggleAim(false));
await page.screenshot({ path: '/home/user/verify/fix-05-after-fire.png' });
console.log('shots written');
await browser.close();
