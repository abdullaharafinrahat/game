/**
 * Regression guard for Babylon tree-shaking side effects.
 *
 * Babylon 8 is side-effect free, so features that hook into the Scene (shadow
 * generators, for instance) must have their component module imported or the
 * engine logs "<X> needs to be imported before as it contains a side-effect
 * required by your code." That only shows up on the code path that uses the
 * feature, which is how a shadow-generator warning slipped through a low-tier
 * test run where shadows are disabled.
 *
 * This script boots the game once per quality tier and fails if ANY such
 * warning appears, so a missing import cannot hide behind a quality preset.
 */
import { chromium } from 'playwright';

const TIERS = ['low', 'medium', 'high'];
const BASE = process.env.GAME_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

let failures = 0;

for (const tier of TIERS) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const messages = [];
  page.on('console', (m) => messages.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/?q=${tier}`, { waitUntil: 'load', timeout: 60000 });
  // Shadow maps on a software rasteriser are extremely slow (well under 1 fps
  // at 2048x2048), so these timeouts are deliberately generous.
  // Note: `window.__dev` only exists in dev builds, so production verification
  // waits on the start overlay instead.
  await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 420000 });

  const frames = async (n = 2) => {
    const start = await page.evaluate(() => window.__game.scene.getFrameId());
    await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 300000 });
  };

  // Exercise every code path that touches a lazily-registered scene feature:
  // shadows (constructor + refresh), particles/decals (fire + explosion),
  // ray picking, animation, physics, IBL.
  await page.evaluate(() => window.__game.start());
  await frames(4);
  await page.evaluate(() => window.__game.input.setTouchFire(true));
  await frames(2);
  await page.evaluate(() => window.__game.input.setTouchFire(false));
  await frames(2);
  await page.evaluate(() => {
    const g = window.__game;
    const barrel = g.scene.meshes.find((m) => m.metadata?.explosive && m.isEnabled());
    if (barrel) g.level.explode(barrel);
  });
  await frames(3);
  // Quality switch re-touches the shadow map and anisotropy.
  await page.evaluate((t) => window.__game.applyQuality(t), tier === 'high' ? 'medium' : 'high');
  await frames(2);
  await page.evaluate((t) => window.__game.applyQuality(t), tier);
  await frames(2);

  const bad = messages.filter((m) => /needs to be imported|side-effect required/i.test(m));
  const errors = messages.filter((m) => /^pageerror|^error:/i.test(m));
  const shadows = await page.evaluate(() => ({
    tier: window.__game.tier,
    shadows: window.__game.quality.shadows,
    generator: Boolean(window.__game.environment?.shadowGenerator),
    casters: window.__game.environment?.shadowGenerator?.getShadowMap()?.renderList?.length ?? 0,
  }));

  const ok = bad.length === 0 && errors.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  tier=${tier.padEnd(6)} shadows=${String(shadows.shadows).padEnd(5)} generator=${String(shadows.generator).padEnd(5)} casters=${shadows.casters}`);
  for (const line of bad) console.log(`      side-effect: ${line}`);
  for (const line of errors) console.log(`      error: ${line}`);
  if (ok && !shadows.generator && shadows.shadows) console.log('      (warning: shadows enabled but no generator)');

  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} tier(s) FAILED` : '\nall tiers clean — no missing side-effect imports');
process.exit(failures ? 1 : 0);
