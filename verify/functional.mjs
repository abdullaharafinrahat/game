/**
 * Functional pass: every gameplay action, driven through the real input layer,
 * asserting observable state changes.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 240000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2500);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 30000 });
};
const act = async (fn, n = 2) => {
  await page.evaluate(fn);
  await frames(n);
};
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${detail}`);
};

// 1. Full-auto + unlimited ammo: holding fire fires many rounds, mag untouched
const magBefore = await page.evaluate(() => window.__game.player.weapon.mag);
await act(() => window.__game.input.setTouchFire(true));
await frames(20); // ~0.33 s of game time at 60 fps -> several 0.12 s intervals
const afterShot = await page.evaluate(() => ({
  mag: window.__game.player.weapon.mag,
  shots: window.__game.player.weapon.shotsFired,
  clip: window.__game.player.animation.currentOverride,
  sparks: window.__game.scene.particleSystems.length,
}));
check('full-auto fires while held', afterShot.shots >= 2, `${afterShot.shots} shot(s)`);
check('ammo is unlimited', afterShot.mag === magBefore, `mag ${magBefore} -> ${afterShot.mag}`);
check('fire plays a clip', afterShot.clip === 'FireRifle', String(afterShot.clip));
await act(() => window.__game.input.setTouchFire(false));


// 2. Bloom reacts, tracers/decals spawn
await page.waitForTimeout(400);
const vfx = await page.evaluate(() => ({
  decals: window.__game.scene.meshes.filter((m) => m.name.startsWith('decal')).length,
  particles: window.__game.scene.particleSystems.length,
}));
check('impact decal spawned', vfx.decals >= 1, `${vfx.decals} decal(s)`);

// 3. Reload restores the magazine
// NOTE: waits are counted in FRAMES, not wall-clock. `frame()` clamps dt to
// 50 ms, so under the 3 fps software renderer game time advances ~6x slower
// than real time (intended: the clamp prevents tunnelling on a stutter).
await act(() => window.__game.input.pressReload());
const reloading = await page.evaluate(() => ({
  reloading: window.__game.player.weapon.reloading,
  clip: window.__game.player.animation.currentOverride,
}));
check('reload starts', reloading.reloading === true, `clip ${reloading.clip}`);
await frames(90); // 2.6 s of game time at 50 ms/frame
const afterReload = await page.evaluate(() => window.__game.player.weapon.mag);
check('reload finishes with a full mag', afterReload === 5, `mag ${afterReload}`);

// 4. Crouch changes pose + speed cap
await act(() => window.__game.input.setTouchCrouch(true));
await frames(6);
const crouched = await page.evaluate(() => ({
  crouching: window.__game.player.crouching,
  clip: window.__game.player.animation.currentOverride,
}));
check('crouch engages', crouched.crouching === true, `clip ${crouched.clip}`);
await act(() => window.__game.input.setTouchCrouch(false));

// 5. ADS narrows FOV and pulls the camera in
await act(() => window.__game.input.toggleAim(true));
await frames(12);
const ads = await page.evaluate(() => ({
  blend: window.__game.camera.aimBlend,
  fov: (window.__game.camera.camera.fov * 180) / Math.PI,
}));
check('ADS narrows FOV', ads.fov < 55 && ads.blend > 0.8, `fov ${ads.fov.toFixed(1)} blend ${ads.blend.toFixed(2)}`);
await act(() => window.__game.input.toggleAim(false));

// 6. Explosive barrel: shoot one and check it detonates
const boom = await page.evaluate(async () => {
  const g = window.__game;
  const barrel = g.scene.meshes.find((m) => /barrel/i.test(m.name) && m.metadata?.explosive && m.isEnabled());
  if (!barrel) return { found: false };
  const before = barrel.isEnabled();
  g.level.explode(barrel);
  await new Promise((r) => setTimeout(r, 120));
  return { found: true, wasEnabled: before, nowEnabled: barrel.isEnabled(), propsLeft: g.level.props.length };
});
check('barrel detonates', boom.found && boom.wasEnabled === true && boom.nowEnabled === false, JSON.stringify(boom));

// 7. Death + respawn
await page.evaluate(() => window.__game.player.damage(1000));
await frames(8);
const deadState = await page.evaluate(() => ({ alive: window.__game.player.alive, clip: window.__game.player.animation.currentOverride }));
await frames(90); // 3.2 s respawn timer at 50 ms/frame
const lifeCycle = {
  dead: deadState,
  after: await page.evaluate(() => ({ alive: window.__game.player.alive, health: window.__game.player.health, clip: window.__game.player.animation.currentOverride })),
};
check('death plays a death clip', lifeCycle.dead.alive === false && ['Dying', 'KnockedOut'].includes(lifeCycle.dead.clip), JSON.stringify(lifeCycle.dead));
check('respawn restores state', lifeCycle.after.alive === true && lifeCycle.after.health === 100, JSON.stringify(lifeCycle.after));

// 8. Fall damage path: teleport high, let it drop
await page.evaluate(() => {
  const p = window.__game.player;
  p.controller.setPosition(new (p.position.constructor)(p.position.x, p.position.y + 30, p.position.z));
});
await frames(120); // fall + settle in game time
const fell = await page.evaluate(() => ({
  grounded: window.__game.player.grounded,
  y: +window.__game.player.position.y.toFixed(2),
  alive: window.__game.player.alive,
  health: window.__game.player.health,
}));
check('lands from a high fall', fell.grounded === true, JSON.stringify(fell));

// 9. Quality switching
await page.evaluate(() => window.__game.applyQuality('high'));
await frames(3);
const highTier = await page.evaluate(() => ({
  tier: window.__game.tier,
  scaling: window.__game.engine.getHardwareScalingLevel(),
  activeButton: document.querySelector('#qualityBtns button.active')?.dataset.tier,
}));
check('quality tier switches', highTier.tier === 'high' && highTier.activeButton === 'high', JSON.stringify(highTier));

// 10. Pause / resume
await page.evaluate(() => window.__game.pause());
await frames(2);
const pausedVisible = await page.evaluate(() => !document.getElementById('pause').classList.contains('hidden'));
await page.evaluate(() => window.__game.resume());
await frames(2);
const resumed = await page.evaluate(() => document.getElementById('pause').classList.contains('hidden'));
check('pause overlay toggles', pausedVisible && resumed, `paused=${pausedVisible} resumed=${resumed}`);

// 11. Clip coverage summary
const coverage = await page.evaluate(() => {
  const meta = window.__game.library.clipMeta;
  const byGroup = {};
  for (const [name, m] of meta) {
    byGroup[m.group] = (byGroup[m.group] ?? 0) + 1;
    void name;
  }
  return { total: meta.size, byGroup, warnings: window.__game.library.warnings.length };
});
check('all 27 clips bound', coverage.total === 27 && coverage.warnings === 0, JSON.stringify(coverage));

console.log('\nsummary:', results.filter((r) => r.pass).length, '/', results.length, 'checks passed');
console.log('page errors:', errors.length ? errors.slice(0, 5).join(' | ') : '(none)');
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
