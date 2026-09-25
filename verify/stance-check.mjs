/**
 * Stance & unarmed verification:
 *   1. SheatheRifle -> unarmed, rifle hidden
 *   2. Punch (ComboPunch) plays on fire while unarmed, no rounds fired
 *   3. Strafe: unarmed + aiming + sideways -> WalkForwardLeft/Right blends
 *   4. DrawRifle -> back to rifle stance, rifle visible, shooting works again
 * Screenshots along the way.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(1500);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 60000 });
};
const state = () =>
  page.evaluate(() => {
    const g = window.__game;
    return {
      stance: g.player.stance,
      override: g.player.animation.currentOverride,
      rifleVisible: g.player.weapon.modelMesh?.isEnabled() ?? null,
      shots: g.player.weapon.shotsFired,
      stanceLine: document.getElementById('stance')?.textContent,
    };
  });
const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${detail}`);
};

await frames(5);

// --- 1. Sheathe: KeyX -> SheatheRifle -> unarmed, rifle hidden -------------
await page.keyboard.press('KeyX');
await frames(3);
let s = await state();
check('sheathe plays SheatheRifle', s.override === 'SheatheRifle', String(s.override));
await frames(70); // 1.8 s overlay + margin
s = await state();
check('now unarmed, rifle hidden', s.stance === 'unarmed' && s.rifleVisible === false, JSON.stringify({ stance: s.stance, rifleVisible: s.rifleVisible }));
await page.evaluate(() => window.__game.camera.setZoom(-4.9));
await page.evaluate(() => {
  window.__game.camera.yaw = Math.PI * 0.8;
  window.__game.camera.pitch = -0.05;
});
await frames(8);
await page.screenshot({ path: '/home/user/stance-unarmed-idle.png' });

// --- 2. Punch: hold fire unarmed -> ComboPunch, no rounds ------------------
const shotsBefore = s.shots;
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(4);
s = await state();
check('punch plays ComboPunch', s.override === 'ComboPunch', String(s.override));
check('punch fires no rounds', s.shots === shotsBefore, `${shotsBefore} -> ${s.shots}`);
await page.screenshot({ path: '/home/user/stance-punch.png' });
await frames(24);
s = await state();
check('punch combos while held', s.override === 'ComboPunch' && s.shots === shotsBefore, `still unarmed, ${s.shots - shotsBefore} shots`);
await page.evaluate(() => window.__game.input.setTouchFire(false));
await frames(30);

// --- 3. Strafe: unarmed + aiming + sideways -> WalkForwardLeft/Right -------
await page.evaluate(() => window.__game.input.toggleAim(true));
await frames(20);
await page.evaluate(() => window.__game.input.setTouchMove(1, 0)); // move right
await frames(30);
const strafe = await page.evaluate(() => {
  const ac = window.__game.player.animation;
  const L = ac.layers.get('WalkForwardLeft');
  const R = ac.layers.get('WalkForwardRight');
  const W = ac.layers.get('Walk');
  return { left: +(L?.weight ?? 0).toFixed(2), right: +(R?.weight ?? 0).toFixed(2), walk: +(W?.weight ?? 0).toFixed(2), speed: +window.__game.player.speed.toFixed(2) };
});
check('strafe blends WalkForwardRight', strafe.right > 0.3 && strafe.speed > 0.3, JSON.stringify(strafe));
await page.screenshot({ path: '/home/user/stance-strafe.png' });
await page.evaluate(() => window.__game.input.setTouchMove(-1, 0));
await frames(30);
const strafeL = await page.evaluate(() => {
  const ac = window.__game.player.animation;
  return { left: +(ac.layers.get('WalkForwardLeft')?.weight ?? 0).toFixed(2), right: +(ac.layers.get('WalkForwardRight')?.weight ?? 0).toFixed(2) };
});
check('strafe switches to WalkForwardLeft', strafeL.left > 0.3, JSON.stringify(strafeL));
await page.evaluate(() => window.__game.input.clearTouchMove());
await page.evaluate(() => window.__game.input.toggleAim(false));
await frames(20);

// --- 4. Draw: KeyX again -> DrawRifle -> rifle stance, shooting works ------
await page.keyboard.press('KeyX');
await frames(3);
s = await state();
check('draw plays DrawRifle', s.override === 'DrawRifle', String(s.override));
await frames(70);
s = await state();
check('now rifle stance, rifle visible', s.stance === 'rifle' && s.rifleVisible === true, JSON.stringify({ stance: s.stance, rifleVisible: s.rifleVisible }));
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(20);
s = await state();
check('shooting works again', s.shots > shotsBefore, `${shotsBefore} -> ${s.shots}`);
await page.evaluate(() => window.__game.input.setTouchFire(false));

console.log(`\nsummary: ${results.filter(Boolean).length}/${results.length} checks passed`);
console.log('page errors:', errors.length ? errors.slice(0, 4).join(' | ') : '(none)');
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
