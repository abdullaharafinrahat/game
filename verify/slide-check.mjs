/**
 * Gun slide check: right hand must hold the GRIP, left hand must reach the
 * BARREL. Measures (in-engine):
 *   - right wrist -> grip point distance (should be ~0)
 *   - left hand -> barrel axis: perpendicular distance + where along the rifle
 *     it lands (fraction from muzzle)
 * and renders annotated close-ups (red=muzzle, green=right-hand grip,
 * blue=left hand).
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

const measure = await page.evaluate(() => {
  const g = window.__game;
  const V3 = g.player.position.constructor;
  const bone = (re) => g.library.character.skeleton.bones.find((b) => re.test(b.name)).getTransformNode();
  const rightHand = bone(/RightHand$/i);
  const leftHand = bone(/LeftHand$/i);
  const pivot = g.scene.getTransformNodeByName('weaponPivot');
  const grip = pivot.getAbsolutePosition();
  const muz = g.player.weapon.muzzleNode.getAbsolutePosition();
  const D = muz.subtract(grip).normalize();
  const rifleLen = V3.Distance(muz, grip) / (1 - 0.0); // grip->muzzle is (1-f) of full length
  const lw = leftHand.getAbsolutePosition();
  const rel = lw.subtract(grip);
  const along = V3.Dot(rel, D); // meters forward of the grip toward the muzzle
  const closest = grip.add(D.scale(along));
  const perp = V3.Distance(closest, lw);
  const rw = rightHand.getAbsolutePosition();
  const fw = g.player.root.forward.clone();
  fw.y = 0;
  fw.normalize();
  const barrelDot = V3.Dot(D, fw);
  return {
    rightWristToGrip: +V3.Distance(rw, grip).toFixed(3),
    leftHand: [lw.x, lw.y, lw.z].map((v) => +v.toFixed(2)),
    leftAlongBarrelM: +along.toFixed(3),
    leftPerpToBarrelM: +perp.toFixed(3),
    leftFractionFromMuzzle: +(1 - along / 1.06).toFixed(2), // grip->muzzle ~ 1 - 0.72 of 1.15 => ~0.322? measured live below
    barrelDotForward: +barrelDot.toFixed(3),
  };
});
console.log(JSON.stringify(measure, null, 1));

// Annotated overlay: red muzzle, green right-hand grip, blue left hand.
await page.evaluate(async () => {
  const g = window.__game;
  const MV = await import('/node_modules/@babylonjs/core/Maths/math.vector.js');
  window.__Matrix = MV.Matrix;
  const cv = document.createElement('canvas');
  cv.id = 'ov';
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:50';
  document.body.appendChild(cv);
  window.__draw = () => {
    const scene = g.scene;
    const engine = g.engine;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const bone = (re) => g.library.character.skeleton.bones.find((b) => re.test(b.name)).getTransformNode();
    const pts = {
      m: g.player.weapon.muzzleNode.getAbsolutePosition(),
      g: g.scene.getTransformNodeByName('weaponPivot').getAbsolutePosition(),
      l: bone(/LeftHand$/i).getAbsolutePosition(),
    };
    const viewport = scene.activeCamera.viewport.toGlobal(w, h);
    const vp = scene.getTransformMatrix();
    const screen = {};
    for (const [k, p] of Object.entries(pts)) {
      const s = g.player.position.constructor.Project(p, window.__Matrix.Identity(), vp, viewport);
      screen[k] = { x: s.x, y: s.y };
    }
    const dot = (p, color, r = 10) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(screen.g, 'rgba(40,230,90,0.95)');
    dot(screen.l, 'rgba(60,140,255,0.95)');
    dot(screen.m, 'rgba(255,45,45,0.95)');
    ctx.font = 'bold 20px monospace';
    ctx.fillStyle = '#ff2d2d';
    ctx.fillText('MUZZLE', screen.m.x + 12, screen.m.y - 10);
    ctx.fillStyle = '#28e65a';
    ctx.fillText('R-HAND/GRIP', screen.g.x + 12, screen.g.y + 22);
    ctx.fillStyle = '#3c8cff';
    ctx.fillText('L-HAND', screen.l.x + 12, screen.l.y + 24);
    return screen;
  };
});

await page.evaluate(() => window.__game.camera.setZoom(-4.9));
for (const [yaw, pitch, name] of [
  [Math.PI / 2, -0.02, 'side'],
  [Math.PI / 3, 0.85, 'topdown'],
  [0, -0.04, 'front'],
]) {
  await page.evaluate(([y, p]) => {
    window.__game.camera.yaw = y;
    window.__game.camera.pitch = p;
  }, [yaw, pitch]);
  await frames(8);
  console.log(name, JSON.stringify(await page.evaluate(() => window.__draw())));
  await page.screenshot({ path: `/home/user/slide-${name}.png` });
}
await browser.close();
console.log('saved slide-*.png');
