import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2500);

const probe = () => page.evaluate(() => {
  const g = window.__game;
  const scene = g.scene, cam = g.camera.camera;
  const V = g.player.position.constructor;
  const fwd = cam.getDirection(new V(0, 0, 1));
  const head = g.player.position.add(new V(0, 0.55, 0));
  const toHead = head.subtract(cam.globalPosition);
  const dist = toHead.length();
  const angle = Math.acos(Math.max(-1, Math.min(1, V.Dot(toHead.normalize(), fwd)))) * 180 / Math.PI;
  const planes = scene.frustumPlanes;
  const meshes = g.library.character.meshes;
  let inFrustum = 0;
  for (const m of meshes) if (cam.isInFrustum(m)) inFrustum++;
  const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
  const toMuzzle = muzzle.subtract(cam.globalPosition).normalize();
  return {
    fovDeg: +(cam.fov * 180 / Math.PI).toFixed(1),
    halfFovDeg: +(cam.fov * 90 / Math.PI).toFixed(1),
    headAngleFromViewAxis: +angle.toFixed(1),
    headDistance: +dist.toFixed(2),
    characterMeshes: meshes.length,
    inFrustum,
    muzzleAngle: +(Math.acos(Math.max(-1, Math.min(1, V.Dot(toMuzzle, fwd)))) * 180 / Math.PI).toFixed(1),
    aspect: +(scene.getEngine().getAspectRatio(cam)).toFixed(2),
    planesOk: planes?.length ?? 0,
  };
});
console.log('hip :', JSON.stringify(await probe()));
await page.evaluate(() => window.__game.input.toggleAim(true));
await page.waitForTimeout(1800);
console.log('ads :', JSON.stringify(await probe()));
await page.screenshot({ path: '/home/user/verify/fix-06-ads-frame.png' });
await page.evaluate(() => { window.__game.input.toggleAim(false); });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/home/user/verify/fix-07-hip-frame.png' });
await browser.close();
