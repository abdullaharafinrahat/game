/**
 * Checks the solved weapon mount: is the barrel horizontal, on the right side
 * of the hand, and pointing the way the character faces?
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => {
  if (/\[weapon\]/.test(m.text())) console.log(m.text());
});

await page.goto('http://localhost:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 240000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(3000);

const measure = () =>
  page.evaluate(() => {
    const g = window.__game;
    const sniper = g.player.weapon.modelMesh;
    const root = g.library.character.root;
    const pivot = g.scene.getTransformNodeByName('weaponPivot');
    const hand = g.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name)).getTransformNode();

    sniper.computeWorldMatrix(true);
    const box = sniper.getBoundingInfo().boundingBox;
    const size = box.maximumWorld.subtract(box.minimumWorld);
    const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
    const pivotPos = pivot.getAbsolutePosition();
    const handPos = hand.getAbsolutePosition();

    const barrelDir = muzzle.subtract(pivotPos);
    const len = barrelDir.length() || 1;
    barrelDir.scaleInPlace(1 / len);

    // CharNode.forward is the model's local +Z in world space.
    const facing = root.forward.clone();
    facing.y = 0;
    facing.normalize();
    const barrelFlat = barrelDir.clone();
    barrelFlat.y = 0;
    barrelFlat.normalize();

    return {
      rifleWorldSize: size.asArray().map((v) => +v.toFixed(2)),
      rifleLengthM: +Math.max(size.x, size.y, size.z).toFixed(2),
      verticalRatio: +(size.y / Math.max(size.x, size.z)).toFixed(2),
      barrelDir: barrelDir.asArray().map((v) => +v.toFixed(2)),
      barrelPitchDeg: +(Math.asin(Math.max(-1, Math.min(1, barrelDir.y))) * (180 / Math.PI)).toFixed(1),
      barrelYawVsFacingDeg: +((Math.acos(Math.max(-1, Math.min(1, barrelDir.x * facing.x + barrelDir.z * facing.z))) * 180) / Math.PI).toFixed(1),
      facing: facing.asArray().map((v) => +v.toFixed(2)),
      muzzleToHandM: +handPos.subtract(muzzle).length().toFixed(2),
      handToRifleBodyM: +handPos.subtract(box.minimumWorld.add(box.maximumWorld).scale(0.5)).length().toFixed(2),
      muzzleY: +muzzle.y.toFixed(2),
      handY: +handPos.y.toFixed(2),
    };
  });

console.log('BARREL:', JSON.stringify(await measure(), null, 1));

// Also check it while walking (muscle pose changes the hand orientation a lot).
await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await page.waitForTimeout(2500);
console.log('WHILE WALKING:', JSON.stringify(await measure(), null, 1));
await page.evaluate(() => window.__game.input.clearTouchMove());
await page.waitForTimeout(800);

// Parked-camera inspection shots.
await page.evaluate(() => {
  const g = window.__game;
  g.scene.fogMode = 0;
  g.paused = true;
  g.camera.update = () => undefined;
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.fov = (50 * Math.PI) / 180;
  cam.position.set(p.x + 2.2, p.y + 1.3, p.z + 2.2);
  cam.setTarget(p);
});
await page.waitForTimeout(900);
await page.screenshot({ path: '/home/user/verify/w2-grip.png' });

await page.evaluate(() => {
  const g = window.__game;
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.position.set(p.x - 0.6, p.y + 1.25, p.z - 2.4);
  cam.setTarget(p);
});
await page.waitForTimeout(900);
await page.screenshot({ path: '/home/user/verify/w3-front.png' });

await browser.close();
