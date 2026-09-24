import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2500);

const probe = () => page.evaluate(() => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor, M = scene.getTransformMatrix().constructor;
  const obs = scene.onAfterRenderObservable.add(() => {
    scene.onAfterRenderObservable.remove(obs);
    const cam = g.camera.camera;
    const engine = scene.getEngine();
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const vp = cam.viewport.toGlobal(w, h);
    const project = (p) => {
      const s = V.Project(p, M.Identity(), scene.getTransformMatrix(), vp);
      return { x: +s.x.toFixed(0), y: +s.y.toFixed(0), z: +s.z.toFixed(3) };
    };
    const pos = g.player.position;
    const head = pos.add(new V(0, 0.45, 0));
    const hips = pos.add(new V(0, -0.45, 0));
    const feet = pos.add(new V(0, g.player.feetOffset, 0));
    const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
    const meshes = g.library.character.meshes;
    const onScreen = (s) => s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h && s.z > 0 && s.z < 1;
    resolve({
      render: w + 'x' + h,
      head: project(head), headVisible: onScreen(project(head)),
      hips: project(hips), feet: project(feet),
      muzzle: project(muzzle), muzzleVisible: onScreen(project(muzzle)),
      inFrustum: meshes.filter((m) => cam.isInFrustum(m)).length + '/' + meshes.length,
    });
  });
}));
console.log('hip :', JSON.stringify(await probe()));
await page.evaluate(() => window.__game.input.toggleAim(true));
await page.waitForTimeout(1800);
console.log('ads :', JSON.stringify(await probe()));
await page.evaluate(() => window.__game.input.toggleAim(false));
await browser.close();
