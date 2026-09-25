/** Close-up screenshot while aiming, to inspect the gun mount visually. */
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

// Zoom the camera in a touch and aim, so the rifle fills more of the frame.
await page.evaluate(() => {
  window.__game.camera.setZoom(-4.8); // clamps at min distance 1.6
  window.__game.camera.pitch = -0.06;
});
await frames(5);
await page.evaluate(() => window.__game.input.toggleAim(true));
await frames(30);
await page.screenshot({ path: '/home/user/game-aim-closeup.png' });
console.log('saved game-aim-closeup.png');
await browser.close();
