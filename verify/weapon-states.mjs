import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2000);

const probe = (label) => page.evaluate((lbl) => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor;
  const samples = [];
  const obs = scene.onAfterRenderObservable.add(() => {
    const pivot = scene.getTransformNodeByName('weaponPivot');
    const muzzle = g.player.weapon.muzzleNode;
    const dir = muzzle.getAbsolutePosition().subtract(pivot.getAbsolutePosition());
    const len = dir.length();
    const d = dir.normalize();
    const fwd = g.player.root.forward.clone(); fwd.y = 0; fwd.normalize();
    samples.push({ dot: +(d.x*fwd.x + d.z*fwd.z).toFixed(3), pitch: +(Math.asin(Math.max(-1,Math.min(1,d.y)))*180/Math.PI).toFixed(1), len: +len.toFixed(2) });
    if (samples.length >= 12) {
      scene.onAfterRenderObservable.remove(obs);
      const dots = samples.map((s) => s.dot);
      resolve({ label: lbl, dotMin: Math.min(...dots), dotMax: Math.max(...dots), pitchAvg: +(samples.reduce((a,s)=>a+s.pitch,0)/samples.length).toFixed(1), barrelLen: samples[0].len, aimBlend: +g.camera.aimBlend.toFixed(2) });
    }
  });
}), label);

console.log(JSON.stringify(await probe('hip idle')));
await page.evaluate(() => window.__game.input.toggleAim(true));
await page.waitForTimeout(1500);
console.log(JSON.stringify(await probe('ADS')));
await page.evaluate(() => window.__game.input.setTouchFire(true));
await page.waitForTimeout(150);
await page.evaluate(() => window.__game.input.setTouchFire(false));
await page.waitForTimeout(400);
console.log(JSON.stringify(await probe('ADS after firing')));
await page.evaluate(() => { window.__game.input.toggleAim(false); });
await page.waitForTimeout(1200);
await page.evaluate(() => { window.__game.input.setTouchSprint(true); window.__game.input.setTouchMove(0,1); });
await page.waitForTimeout(2200);
console.log(JSON.stringify(await probe('sprint')));
await browser.close();
