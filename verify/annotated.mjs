/**
 * Annotated gun-direction proof: projects muzzle / grip / facing into SCREEN
 * space and draws markers onto an overlay canvas:
 *   RED dot   = muzzle node (rounds come from here)
 *   GREEN dot = grip/pivot (the hands)
 *   BLUE arrow= the character's facing direction (from his feet, 0.7 m long)
 * If the RED dot sits on the barrel end pointing the same way as the BLUE
 * arrow — from the FRONT and from ABOVE — the gun is correct. No guessing.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(1500);

const frames = async (n = 3) => {
  const start = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((s) => window.__game.scene.getFrameId() >= s, start + n, { timeout: 60000 });
};
await frames(5);

// Overlay canvas + projection helper, installed once.
await page.evaluate(async () => {
  const g = window.__game;
  const MV = await import('/node_modules/@babylonjs/core/Maths/math.vector.js');
  window.__Matrix = MV.Matrix;
  const cv = document.createElement('canvas');
  cv.id = 'markerOverlay';
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:50';
  document.body.appendChild(cv);
  window.__drawMarkers = () => {
    const V3 = g.player.position.constructor;
    const scene = g.scene;
    const engine = g.engine;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const proj = (p) => {
      const t = V3.Project(p, scene.getTransformMatrix(), scene.getTransformMatrix().clone().setRowFromFloats(3, 0, 0, 0, 1), scene.activeCamera.toGlobalScreenMatrix ? undefined : undefined) ?? null;
      return null;
    };
    // simpler: use Vector3.Project with proper args
    const toScreen = (p) => {
      const camera = scene.activeCamera;
      // Babylon: Vector3.Project(vector, world, transform, viewport)
      const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
      const viewProjection = scene.getTransformMatrix();
      const projected = V3.Project(p, window.__Matrix.Identity(), viewProjection, viewport);
      return { x: projected.x, y: projected.y, z: projected.z };
    };
    const pivot = scene.getTransformNodeByName('weaponPivot');
    const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
    const grip = pivot.getAbsolutePosition();
    const feet = g.player.position.clone();
    feet.y += g.player.feetOffset ?? -0.6;
    const fw = g.player.root.forward.clone();
    fw.y = 0;
    fw.normalize();
    const ahead = feet.add(fw.scale(0.9));

    const m = toScreen(muzzle);
    const gr = toScreen(grip);
    const fd = toScreen(ahead);
    const ft = toScreen(feet);

    ctx.lineWidth = 6;
    // facing arrow (blue)
    ctx.strokeStyle = 'rgba(60,140,255,0.95)';
    ctx.beginPath();
    ctx.moveTo(ft.x, ft.y);
    ctx.lineTo(fd.x, fd.y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(60,140,255,0.95)';
    ctx.beginPath();
    ctx.arc(fd.x, fd.y, 9, 0, Math.PI * 2);
    ctx.fill();
    // grip (green)
    ctx.fillStyle = 'rgba(40,230,90,0.95)';
    ctx.beginPath();
    ctx.arc(gr.x, gr.y, 11, 0, Math.PI * 2);
    ctx.fill();
    // muzzle (red)
    ctx.fillStyle = 'rgba(255,45,45,0.95)';
    ctx.beginPath();
    ctx.arc(m.x, m.y, 11, 0, Math.PI * 2);
    ctx.fill();
    // labels
    ctx.font = 'bold 22px monospace';
    ctx.fillStyle = '#ff2d2d';
    ctx.fillText('MUZZLE', m.x + 14, m.y - 10);
    ctx.fillStyle = '#28e65a';
    ctx.fillText('GRIP', gr.x + 14, gr.y + 22);
    ctx.fillStyle = '#3c8cff';
    ctx.fillText('FACING', fd.x + 12, fd.y + 6);
    return { m, gr, fd, ft };
  };
});

const shoot = async (yaw, pitch, name) => {
  await page.evaluate(([y, p]) => {
    window.__game.camera.yaw = y;
    window.__game.camera.pitch = p;
    window.__game.camera.setZoom(-4.9);
  }, [yaw, pitch]);
  await frames(8);
  const coords = await page.evaluate(() => window.__drawMarkers());
  await page.screenshot({ path: `/home/user/annotated-${name}.png` });
  const V3 = await page.evaluate(() => {
    const g = window.__game;
    const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
    const grip = g.scene.getTransformNodeByName('weaponPivot').getAbsolutePosition();
    const fw = g.player.root.forward.clone();
    fw.y = 0;
    fw.normalize();
    const barrel = muzzle.subtract(grip).normalize();
    return { dotFwd: +g.player.position.constructor.Dot(barrel, fw).toFixed(3) };
  });
  console.log(`${name}: red(muzzle)@${Math.round(coords.m.x)},${Math.round(coords.m.y)} green(grip)@${Math.round(coords.gr.x)},${Math.round(coords.gr.y)} blue(facing)@${Math.round(coords.fd.x)},${Math.round(coords.fd.y)} | barrel·forward=${V3.dotFwd}`);
};

await shoot(0, -0.04, 'front');
await shoot(Math.PI / 3, 0.85, 'topdown');
await shoot(Math.PI / 2, -0.02, 'side');
await browser.close();
console.log('saved annotated-*.png');
