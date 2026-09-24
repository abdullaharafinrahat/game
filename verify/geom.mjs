import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !window.__game.scene.isLoading, null, { timeout: 300000 }).catch(() => {});
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2500);
const probe = () => page.evaluate(() => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const obs = scene.onAfterRenderObservable.add(() => {
    scene.onAfterRenderObservable.remove(obs);
    const root = g.library.character.root;
    // World extents of every character mesh (rig-scale independent).
    let minY = Infinity, maxY = -Infinity;
    for (const m of g.library.character.meshes) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      minY = Math.min(minY, bb.minimumWorld.y);
      maxY = Math.max(maxY, bb.maximumWorld.y);
    }
    resolve({
      modelFeetY: +minY.toFixed(3), modelHeadY: +maxY.toFixed(3), modelHeight: +(maxY - minY).toFixed(3),
      pivotY: +g.camera.pivot.y.toFixed(3), pivotAboveModelFeet: +(g.camera.pivot.y - minY).toFixed(3),
      camY: +g.camera.camera.globalPosition.y.toFixed(3),
      playerPosY: +g.player.position.y.toFixed(3), feetOffset: +g.player.feetOffset.toFixed(3),
      rootY: +root.getAbsolutePosition().y.toFixed(3),
      eyePointY: +g.player.eyePoint.y.toFixed(3),
    });
  });
}));
console.log('hip :', JSON.stringify(await probe(), null, 1));
await browser.close();
