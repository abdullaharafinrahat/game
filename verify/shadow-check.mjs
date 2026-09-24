/**
 * Objective shadow check.
 *
 * Eyeballing a 4 fps software render can't tell "shadow" from "dark texture", so
 * this measures pixels: the same camera pose is captured with shadows on and
 * off, and the mean luminance of the ground *beside the character* is compared
 * against a control patch of ground further away. A working contact shadow makes
 * the near-ground measurably darker relative to the control.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5173/?q=high', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 420000 });
await page.evaluate(() => window.__game.start());

const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((x) => window.__game.scene.getFrameId() >= x, s + n, { timeout: 300000 });
};
await frames(6);

/** Parks the camera above/behind the character on open ground and captures. */
async function capture(file, shadows) {
  await page.evaluate((on) => {
    const g = window.__game;
    g.paused = true;
    g.camera.update = () => undefined;
    g.environment.sun.shadowEnabled = on;
    if (g.environment.shadowGenerator) {
      g.environment.shadowGenerator.getShadowMap().refreshRate = on ? 1 : 0;
    }
    const p = g.player.position;
    const cam = g.camera.camera;
    cam.fov = (45 * Math.PI) / 180;
    // Look down at the character from behind so the ground beside them fills the frame.
    cam.position.set(p.x + 3.5, p.y + 4.2, p.z + 3.5);
    cam.setTarget(new (p.constructor)(p.x, p.y, p.z));
  }, shadows);
  await frames(6);
  await page.screenshot({ path: file });
}

const lum = (file, x0, y0, x1, y1) => {
  const png = PNG.sync.read(readFileSync(file));
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (png.width * y + x) << 2;
      sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      count++;
    }
  }
  return sum / count;
};

await capture('/tmp/verify/shadow-on.png', true);
await capture('/tmp/verify/shadow-off.png', false);

// The character stands near screen centre; sample the ground just below/right of
// them, and a control patch at the top of the frame (far ground).
const regions = {
  'ground beside player': [520, 400, 700, 470],
  'control (distant ground)': [100, 60, 280, 130],
};

for (const [label, box] of Object.entries(regions)) {
  const on = lum('/tmp/verify/shadow-on.png', ...box);
  const off = lum('/tmp/verify/shadow-off.png', ...box);
  const delta = ((on - off) / off) * 100;
  console.log(`${label.padEnd(26)} shadows-on=${on.toFixed(1)}  off=${off.toFixed(1)}  delta=${delta.toFixed(1)}%`);
}

const onNear = lum('/tmp/verify/shadow-on.png', ...regions['ground beside player']);
const offNear = lum('/tmp/verify/shadow-off.png', ...regions['ground beside player']);
console.log(
  onNear < offNear - 3
    ? '\nPASS  near-ground is measurably darker with shadows enabled'
    : '\nFAIL  no measurable shadow darkening',
);

const casters = await page.evaluate(() => ({
  casters: window.__game.environment.shadowGenerator?.getShadowMap()?.renderList?.length ?? 0,
  characterIsCaster: window.__game.library.character.meshes.every((m) =>
    (window.__game.environment.shadowGenerator?.getShadowMap()?.renderList ?? []).includes(m),
  ),
  frustum: window.__game.environment.sun.orthoRight,
}));
console.log('casters:', JSON.stringify(casters));

await browser.close();
