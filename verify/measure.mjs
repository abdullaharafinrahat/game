/**
 * Measurement pass: reads the REAL numbers for the two things that were wrong
 * (capsule resting height, weapon hand placement) so the constants can be
 * corrected from data instead of by eye.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 240000 });
console.log('BOOT ok');

// --- 1. Where does the character controller actually rest a capsule? ------
console.log('\n=== capsule rest measurements ===');
console.log('box  collider:', JSON.stringify(await page.evaluate(() => window.__dev.measureCapsuleRest('box'))));
console.log('mesh collider:', JSON.stringify(await page.evaluate(() => window.__dev.measureCapsuleRest('mesh'))));

// --- 2. In-game: capsule centre vs ground vs model feet -------------------
console.log('\n=== in-game alignment ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  const p = g.player.position;
  const ground = g.probeGround(p.x, p.z);
  return {
    capsuleCentreY: +p.y.toFixed(3),
    groundY: ground === null ? null : +ground.toFixed(3),
    centreAboveGround: ground === null ? null : +(p.y - ground).toFixed(3),
    assumedHalfHeight: +(g.player.feetOffset * -1).toFixed(3),
    modelFeetY: +(p.y + g.player.feetOffset).toFixed(3),
    modelFeetBelowGround: ground === null ? null : +(p.y + g.player.feetOffset - ground).toFixed(3),
    characterBindingFeetOffset: +g.library.character.feetOffset.toFixed(3),
    characterHeight: +g.library.character.height.toFixed(3),
  };
})));

// --- 3. Character mesh bounds in world space (posed) ----------------------
console.log('\n=== character mesh bounds (idle pose) ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of g.library.character.meshes) {
    m.computeWorldMatrix(true);
    const b = m.getBoundingInfo().boundingBox;
    minY = Math.min(minY, b.minimumWorld.y);
    maxY = Math.max(maxY, b.maximumWorld.y);
  }
  const ground = g.probeGround(g.player.position.x, g.player.position.z) ?? 0;
  return {
    meshMinY: +minY.toFixed(3),
    meshMaxY: +maxY.toFixed(3),
    meshHeight: +(maxY - minY).toFixed(3),
    groundY: +ground.toFixed(3),
    feetVsGround: +(minY - ground).toFixed(3),
  };
})));

// --- 4. Weapon placement --------------------------------------------------
console.log('\n=== weapon probe ===');
console.log(JSON.stringify(await page.evaluate(() => window.__dev.probeWeapon()), null, 1));

await browser.close();
