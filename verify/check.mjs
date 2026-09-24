import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.GAME_URL ?? 'http://localhost:5173';
const OUT = '/home/user/verify';
mkdirSync(OUT, { recursive: true });

const logs = [];
const errors = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 240000 });
console.log('BOOT: ok');

/** Waits for real rendered frames — essential on a 3 fps software renderer. */
async function frames(n = 3) {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 30000 });
}
/** Runs a callback, then lets N frames render so the input is consumed. */
async function act(fn, n = 3) {
  await page.evaluate(fn);
  await frames(n);
}
const info = () => page.evaluate(() => window.__game.debugInfo());

await page.evaluate(() => window.__game.start());
await frames(20);
console.log('SETTLED:', JSON.stringify(await info()));
await page.screenshot({ path: `${OUT}/01-settled.png` });

// --- walk / sprint ------------------------------------------------------
await act(() => window.__game.input.setTouchMove(0, 1), 2);
await frames(30);
console.log('WALK   :', JSON.stringify(await info()));
await page.screenshot({ path: `${OUT}/02-walk.png` });

await act(() => window.__game.input.setTouchSprint(true), 2);
await frames(30);
console.log('SPRINT :', JSON.stringify(await info()));
await page.screenshot({ path: `${OUT}/03-sprint.png` });

await act(() => {
  window.__game.input.clearTouchMove();
  window.__game.input.setTouchSprint(false);
}, 2);
await frames(20);

// --- jump ---------------------------------------------------------------
await act(() => window.__game.input.pressJump(), 2);
console.log('JUMP   :', JSON.stringify(await info()));
await page.screenshot({ path: `${OUT}/04-jump.png` });
await frames(40);

// --- fire ---------------------------------------------------------------
const before = await page.evaluate(() => window.__game.player.weapon.mag);
await act(() => window.__game.input.setTouchFire(true), 2);
const fired = await page.evaluate(() => ({
  mag: window.__game.player.weapon.mag,
  clip: window.__game.player.animation.currentOverride,
  tracers: window.__game.scene.meshes.filter((m) => m.name === 'tracer').length,
  decals: window.__game.scene.meshes.filter((m) => m.name === 'decal').length,
}));
console.log('FIRE   :', JSON.stringify({ before, ...fired }));
await page.screenshot({ path: `${OUT}/05-fire.png` });
await act(() => window.__game.input.setTouchFire(false), 1);

// --- ADS ----------------------------------------------------------------
await act(() => window.__game.input.toggleAim(true), 2);
await frames(14);
console.log('ADS    :', JSON.stringify(await page.evaluate(() => ({
  aimBlend: +window.__game.camera.aimBlend.toFixed(2),
  fovDeg: +((window.__game.camera.camera.fov * 180) / Math.PI).toFixed(1),
}))));
await page.screenshot({ path: `${OUT}/06-ads.png` });
await act(() => window.__game.input.toggleAim(false), 1);

// --- geometry / scale ---------------------------------------------------
console.log('SCALE  :', JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  const bg = g.scene.getTransformNodeByName('battlegroundRoot');
  const spans = bg ? bg.getChildMeshes().map((m) => m.getBoundingInfo().boundingBox) : [];
  const width = spans.length ? Math.max(...spans.map((b) => b.maximumWorld.x - b.minimumWorld.x)) : 0;
  const tallest = spans.length ? Math.max(...spans.map((b) => b.maximumWorld.y - b.minimumWorld.y)) : 0;
  return {
    mapScale: bg ? +bg.scaling.x.toFixed(5) : null,
    mapWidthM: +width.toFixed(1),
    tallestBuildingM: +tallest.toFixed(1),
    characterM: +g.library.character.height.toFixed(2),
    houses: g.scene.getTransformNodeByName('house_0_root') ? 4 : 0,
  };
})));

// --- animation driving bones -------------------------------------------
console.log('BONES  :', JSON.stringify(await page.evaluate(async () => {
  const sk = window.__game.library.character.skeleton;
  const names = ['RightArm', 'LeftUpLeg', 'RightForeArm'];
  const bones = names.map((n) => sk.bones.find((b) => b.name.endsWith(n))).filter(Boolean);
  const read = () => bones.map((b) => b.getTransformNode().rotationQuaternion.asArray().map((v) => +v.toFixed(4)).join(','));
  const a = read();
  await new Promise((r) => setTimeout(r, 700));
  const b = read();
  return bones.map((b, i) => ({ bone: b.name.split(':')[1], animating: a[i] !== b[i] }));
})));

// --- inspection shots: park the camera manually (paused = no camera update)
await page.evaluate(() => {
  const g = window.__game;
  g.paused = true;
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.fov = (60 * Math.PI) / 180;
  cam.position.set(p.x + 2.6, p.y + 1.4, p.z + 2.6);
  cam.setTarget(new (p.constructor)(p.x, p.y + 0.2, p.z));
  // Keep the render loop from re-framing the camera on the next tick.
  g.camera.update = () => undefined;
});
await frames(4);
await page.screenshot({ path: `${OUT}/07-character-close.png` });

await page.evaluate(() => {
  const g = window.__game;
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.position.set(p.x - 1.6, p.y + 1.5, p.z - 1.6);
  cam.setTarget(new (p.constructor)(p.x, p.y + 0.1, p.z));
});
await frames(4);
await page.screenshot({ path: `${OUT}/08-character-front.png` });

// Bird's eye over the whole map.
await page.evaluate(() => {
  const g = window.__game;
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.fov = (70 * Math.PI) / 180;
  cam.position.set(p.x + 70, p.y + 95, p.z + 70);
  cam.setTarget(new (p.constructor)(p.x, p.y, p.z));
});
await frames(6);
await page.screenshot({ path: `${OUT}/09-birdseye.png` });

console.log('\n--- console (level/weapon/assets) ---');
for (const l of logs.filter((x) => /\[level\]|\[weapon\]|\[assets\]|error/i.test(x)).slice(0, 15)) console.log(l);
console.log('\n--- page errors ---');
console.log(errors.length ? errors.slice(0, 8).join('\n') : '(none)');
await browser.close();
