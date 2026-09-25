/**
 * Post-fix verification: one-shot animations, full-auto, unlimited ammo,
 * fixed gun mount values.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(1500);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 60000 });
};

// --- Weapon mount values ---------------------------------------------------
const mount = await page.evaluate(() => {
  const pivot = window.__game.scene.getTransformNodeByName('weaponPivot');
  const q = pivot.rotationQuaternion;
  const euler = q ? q.toEulerAngles().scale(180 / Math.PI) : null;
  return {
    position: pivot.position.asArray().map((v) => +v.toFixed(3)),
    rotationDeg: euler ? [euler.x, euler.y, euler.z].map((v) => +v.toFixed(2)) : null,
    parent: pivot.parent?.name,
  };
});
console.log('MOUNT position:', JSON.stringify(mount.position), '(want [-0.05,-0.02,-0.03])');
console.log('MOUNT rotation (deg, from quat):', JSON.stringify(mount.rotationDeg), '(want ~[15.19,-16.35,170.13])');
console.log('MOUNT parent:', mount.parent);
const mountOK =
  JSON.stringify(mount.position) === JSON.stringify([-0.05, -0.02, -0.03]) &&
  mount.rotationDeg &&
  Math.abs(mount.rotationDeg[0] - 15.19) < 0.5 &&
  Math.abs(mount.rotationDeg[1] + 16.35) < 0.5 &&
  Math.abs(mount.rotationDeg[2] - 170.13) < 0.5;
console.log('MOUNT OK:', mountOK);

const handQ = () =>
  page.evaluate(() => {
    const b = window.__game.library.character.skeleton.bones.find((x) => /RightHand$/i.test(x.name));
    return b.getTransformNode().rotationQuaternion.asArray().map((v) => +v.toFixed(4)).join(',');
  });

// --- FIRE: one-shot now visible? -------------------------------------------
console.log('\n=== FIRE ===');
const q0 = await handQ();
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(2);
const duringFire = await page.evaluate(() => {
  const ac = window.__game.player.animation;
  const layer = ac.layers.get('FireRifle');
  return {
    ov: ac.currentOverride,
    layerW: +layer.weight.toFixed(2),
    grpW: +Number(layer.group.weight).toFixed(2),
    animW: [...new Set(layer.group.animatables.map((a) => Number(a._weight).toFixed(2)))].join(','),
  };
});
await frames(8);
const q1 = await handQ();
await page.evaluate(() => window.__game.input.setTouchFire(false));
await frames(30);
console.log('override:', duringFire.ov, 'layerW:', duringFire.layerW, 'groupW:', duringFire.grpW, 'animatableW:', duringFire.animW);
console.log('hand q before:', q0);
console.log('hand q during:', q1);
console.log('FIRE ANIM VISIBLE:', duringFire.ov === 'FireRifle' && duringFire.grpW > 0.5 && q0 !== q1);

// --- FULL AUTO + UNLIMITED ---------------------------------------------------
console.log('\n=== FULL AUTO (hold 2s) ===');
const shotsBefore = await page.evaluate(() => window.__game.player.weapon.shotsFired);
await page.evaluate(() => window.__game.input.setTouchFire(true));
await frames(90);
const auto = await page.evaluate(() => ({
  shots: window.__game.player.weapon.shotsFired,
  mag: window.__game.player.weapon.mag,
  reserve: window.__game.player.weapon.reserve,
}));
await page.evaluate(() => window.__game.input.setTouchFire(false));
console.log(`shots fired while held: ${auto.shots - shotsBefore} (want >1 — full-auto)`);
console.log(`mag: ${auto.mag} (want 5, never drains)  reserve: ${auto.reserve === Infinity ? '∞' : auto.reserve}`);
console.log('FULL-AUTO OK:', auto.shots - shotsBefore > 1, ' UNLIMITED OK:', auto.mag === 5 && auto.reserve === Infinity);

// --- RELOAD -----------------------------------------------------------------
console.log('\n=== RELOAD ===');
await page.evaluate(() => window.__game.input.pressReload());
await frames(3);
const reloadStart = await page.evaluate(() => {
  const ac = window.__game.player.animation;
  const layer = ac.layers.get('Reload');
  return {
    ov: ac.currentOverride,
    grpW: +Number(layer.group.weight).toFixed(2),
    animW: [...new Set(layer.group.animatables.map((a) => Number(a._weight).toFixed(2)))].join(','),
    spd: +layer.group.speedRatio.toFixed(2),
  };
});
const qs = [];
for (let i = 0; i < 6; i++) {
  qs.push(await handQ());
  await frames(15);
}
const reloadEnd = await page.evaluate(() => ({ ov: window.__game.player.animation.currentOverride, reloading: window.__game.player.weapon.reloading }));
console.log('override:', reloadStart.ov, 'groupW:', reloadStart.grpW, 'animatableW:', reloadStart.animW, 'speedRatio:', reloadStart.spd);
console.log('hand samples during reload:');
qs.forEach((q, i) => console.log(`  t${i}: [${q}]`));
const distinct = new Set(qs).size;
console.log('RELOAD ANIM MOVES HAND:', reloadStart.ov === 'Reload' && reloadStart.grpW > 0.5 && distinct >= 4, `(${distinct}/6 distinct poses)`);
console.log('reload finished cleanly:', reloadEnd.ov === null && reloadEnd.reloading === false);

// --- Screenshot for the user ------------------------------------------------
await page.waitForTimeout(500);
await page.screenshot({ path: '/home/user/game-fixed.png' });
console.log('\nscreenshot saved: game-fixed.png');

console.log('\n=== PAGE ERRORS ===');
console.log(errors.length ? errors.slice(0, 5).join('\n') : '(none)');
await browser.close();
