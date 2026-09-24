/**
 * Which shadow configuration actually renders?
 *
 * Captures the same pose with shadows off (baseline) and then with several
 * ShadowGenerator filter setups, and reports the whole-frame mean luminance
 * delta plus where on screen the darkening lands. That separates "no shadow at
 * all" from "shadow in a spot I wasn't sampling".
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5173/?q=high', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 420000 });
await page.evaluate(() => window.__game.start());

const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((x) => window.__game.scene.getFrameId() >= x, s + n, { timeout: 300000 });
};
await frames(6);

// Lock the camera looking down at open ground so a shadow must be in frame.
await page.evaluate(() => {
  const g = window.__game;
  g.camera.update = () => undefined;
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.fov = (50 * Math.PI) / 180;
  cam.position.set(p.x, p.y + 12, p.z);
  cam.setTarget(new (p.constructor)(p.x, p.y - 1, p.z));
});

const meanLuma = (file) => {
  const png = PNG.sync.read(readFileSync(file));
  let sum = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    sum += 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
  }
  return sum / n;
};

const snapshot = async (file) => {
  await frames(6);
  await page.screenshot({ path: file });
  return meanLuma(file);
};

// --- baseline: shadows off --------------------------------------------------
await page.evaluate(() => {
  const g = window.__game;
  g.environment.sun.shadowEnabled = false;
  g.environment.shadowGenerator.getShadowMap().refreshRate = 0;
});
const off = await snapshot('/tmp/verify/exp-off.png');
console.log(`baseline (shadows off)      mean=${off.toFixed(2)}`);

const configs = [
  ['blur ESM (current)', 'sg.useBlurExponentialShadowMap = true; sg.usePercentageCloserFiltering = false; sg.useContactHardeningShadow = false; sg.blurKernel = 24; sg.depthScale = 40; sg.setDarkness(0.45); sg.bias = 0.006; sg.normalBias = 0.02;'],
  ['ESM, default depthScale', 'sg.useBlurExponentialShadowMap = true; sg.usePercentageCloserFiltering = false; sg.blurKernel = 4; sg.depthScale = 30; sg.setDarkness(0); sg.bias = 0.001; sg.normalBias = 0;'],
  ['PCF', 'sg.useBlurExponentialShadowMap = false; sg.usePercentageCloserFiltering = true; sg.filteringQuality = BABYLON?.ShadowGenerator?.QUALITY_MEDIUM ?? 1; sg.bias = 0.0005; sg.normalBias = 0.01; sg.setDarkness(0.2);'],
  ['hard shadow map', 'sg.useBlurExponentialShadowMap = false; sg.usePercentageCloserFiltering = false; sg.useExponentialShadowMap = false; sg.bias = 0.0005; sg.normalBias = 0.01; sg.setDarkness(0);'],
];

for (const [label, code] of configs) {
  await page.evaluate((source) => {
    const g = window.__game;
    const sg = g.environment.shadowGenerator;
    const BABYLON = { ShadowGenerator: { QUALITY_MEDIUM: 1 } };
    // eslint-disable-next-line no-new-func
    new Function('sg', 'BABYLON', source)(sg, BABYLON);
    sg.getShadowMap().refreshRate = 1;
    g.environment.sun.shadowEnabled = true;
  }, code);
  const on = await snapshot(`/tmp/verify/exp-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
  const delta = ((on - off) / off) * 100;
  console.log(`${label.padEnd(26)} mean=${on.toFixed(2)}  delta=${delta.toFixed(2)}%  ${delta < -1 ? '<-- rendering' : ''}`);
}

// Where does the darkening land? Coarse 8x6 grid of the best-known config.
await page.evaluate(() => {
  const g = window.__game;
  const sg = g.environment.shadowGenerator;
  sg.useBlurExponentialShadowMap = true;
  sg.blurKernel = 4;
  sg.depthScale = 30;
  sg.setDarkness(0);
  sg.bias = 0.001;
  sg.normalBias = 0;
  sg.getShadowMap().refreshRate = 1;
  g.environment.sun.shadowEnabled = true;
});
await snapshot('/tmp/verify/exp-grid-on.png');

const grid = (file) => {
  const png = PNG.sync.read(readFileSync(file));
  const cols = 8;
  const rows = 6;
  const out = [];
  for (let ry = 0; ry < rows; ry++) {
    const row = [];
    for (let rx = 0; rx < cols; rx++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor((ry * png.height) / rows); y < Math.floor(((ry + 1) * png.height) / rows); y++) {
        for (let x = Math.floor((rx * png.width) / cols); x < Math.floor(((rx + 1) * png.width) / cols); x++) {
          const o = (png.width * y + x) << 2;
          sum += 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
          n++;
        }
      }
      row.push((sum / n).toFixed(0).padStart(4));
    }
    out.push(row.join(' '));
  }
  return out.join('\n');
};
console.log('\nbaseline grid (shadows off):\n' + grid('/tmp/verify/exp-off.png'));
console.log('\nESM default-depth grid (shadows on):\n' + grid('/tmp/verify/exp-grid-on.png'));

await browser.close();
