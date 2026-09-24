/**
 * Diagnoses the three reported symptoms with measurements, not guesses:
 *
 *  1. "all movement are reverse"  -> compare W-movement direction against the
 *     camera's actual view direction.
 *  2. "the gun has been reversed" -> where does the muzzle sit relative to the
 *     character's *visual* forward (determined from renders, see the images).
 *  3. "no animation is happening" -> sample a leg bone over time through a
 *     sequence of state transitions and count how often it actually changes.
 *
 * Also renders the model from -Z and +Z with rotation.y = 0 so the visual
 * forward axis can be read off directly (the face is unmistakable).
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:5173/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__dev && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });

const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((x) => window.__game.scene.getFrameId() >= x, s + n, { timeout: 120000 });
};

await page.evaluate(() => window.__game.start());
await frames(6);

// ---------------------------------------------------------------- 1. axes
// Freeze everything, zero the model's yaw, and look at the character from the
// world -Z then the world +Z side. The face tells us the visual forward axis.
await page.evaluate(() => {
  const g = window.__game;
  g.paused = true;
  g.camera.update = () => undefined;
  g.player.root.rotation.y = 0;
  g.player.root.computeWorldMatrix(true);
  const p = g.player.position;
  const cam = g.camera.camera;
  cam.fov = (40 * Math.PI) / 180;
  cam.position.set(p.x, p.y + 1.35, p.z - 2.6);
  cam.setTarget(new (p.constructor)(p.x, p.y + 0.1, p.z));
});
await frames(5);
await page.screenshot({ path: '/home/user/verify/diag-from-neg-z.png' });

await page.evaluate(() => {
  const p = window.__game.player.position;
  const cam = window.__game.camera.camera;
  cam.position.set(p.x, p.y + 1.35, p.z + 2.6);
  cam.setTarget(new (p.constructor)(p.x, p.y + 0.1, p.z));
});
await frames(5);
await page.screenshot({ path: '/home/user/verify/diag-from-pos-z.png' });

// ------------------------------------------------------- 2. direction maths
console.log('=== camera / model vectors (yaw = 0) ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  g.camera.yaw = 0;
  g.camera.update(0.016, { position: g.player.eyePoint }, { x: 0, y: 0 }, false);
  const cam = g.camera.camera;
  const aim = cam.getDirection(new (g.player.position.constructor)(0, 0, 1));
  const facing = g.camera.facing;
  const rootFwd = g.player.root.forward.clone();
  return {
    yaw: g.camera.yaw,
    aimDirection_viewDir: aim.asArray().map((v) => +v.toFixed(3)),
    cameraFacing: facing.asArray().map((v) => +v.toFixed(3)),
    modelLocalPlusZ_inWorld: rootFwd.asArray().map((v) => +v.toFixed(3)),
    modelRotationY: +g.player.root.rotation.y.toFixed(3),
    dot_facing_vs_view: +facing.x * aim.x + facing.z * aim.z > 0 ? 'same side' : 'OPPOSITE (bug)',
  };
}), null, 1));

// Movement direction: press W for a while and compare the delta to the view dir.
await page.evaluate(() => {
  const g = window.__game;
  g.paused = false;
  delete g.camera.update;
  g.camera.yaw = 0;
  g.camera.pitch = -0.1;
});
await frames(4);
const before = await page.evaluate(() => {
  const p = window.__game.player.position;
  const cam = window.__game.camera.camera;
  return {
    pos: [+p.x.toFixed(3), +p.z.toFixed(3)],
    view: cam.getDirection(new (p.constructor)(0, 0, 1)).asArray().map((v) => +v.toFixed(3)),
    facing: window.__game.camera.facing.asArray().map((v) => +v.toFixed(3)),
  };
});
await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await frames(30);
const after = await page.evaluate(() => {
  const g = window.__game;
  const p = g.player.position;
  return {
    pos: [+p.x.toFixed(3), +p.z.toFixed(3)],
    modelYaw: +g.player.root.rotation.y.toFixed(3),
  };
});
await page.evaluate(() => window.__game.input.clearTouchMove());
const moved = [after.pos[0] - before.pos[0], after.pos[1] - before.pos[1]];
const movedLen = Math.hypot(moved[0], moved[1]) || 1e-6;
console.log('\n=== movement vs view ===');
console.log('view direction   :', before.view, ' facing:', before.facing);
console.log('moved (x,z)      :', moved.map((v) => +v.toFixed(3)), ' len', movedLen.toFixed(2));
console.log('dot(view, move)  :', ((before.view[0] * moved[0] + before.view[2] * moved[1]) / movedLen).toFixed(3), '(negative = walking backwards)');
console.log('model yaw        :', after.modelYaw);

// ----------------------------------------------------------- 3. gun facing
console.log('\n=== weapon vs model ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  const mesh = g.player.weapon.modelMesh;
  const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
  const pivot = g.scene.getTransformNodeByName('weaponPivot').getAbsolutePosition();
  const dir = muzzle.subtract(pivot).normalize();
  const rootPlusZ = g.player.root.forward.clone();
  const rootMinusZ = rootPlusZ.scale(-1);
  return {
    muzzleRelativeToPivot: dir.asArray().map((v) => +v.toFixed(3)),
    modelLocalPlusZ_world: rootPlusZ.asArray().map((v) => +v.toFixed(3)),
    dotMuzzleVsPlusZ: +(dir.x * rootPlusZ.x + dir.y * rootPlusZ.y + dir.z * rootPlusZ.z).toFixed(3),
    dotMuzzleVsMinusZ: +(dir.x * rootMinusZ.x + dir.y * rootMinusZ.y + dir.z * rootMinusZ.z).toFixed(3),
  };
}), null, 1));

// ------------------------------------------------------ 4. animation health
// Walk -> sprint -> stop -> walk, sampling a leg bone each step. A frozen bone
// (constant quaternion) means the blend lost its driver.
const anim = await page.evaluate(async () => {
  const g = window.__game;
  const bone = g.library.character.skeleton.bones.find((b) => /LeftUpLeg$/i.test(b.name));
  const read = () => bone.getTransformNode().rotationQuaternion.asArray().map((v) => +v.toFixed(4)).join(',');
  const measure = async (label, setup, ms) => {
    if (setup) setup();
    const seen = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      seen.add(read());
      await new Promise((r) => setTimeout(r, 60));
    }
    return { label, distinctPoses: seen.size, frozen: seen.size <= 1 };
  };
  const out = [];
  out.push(await measure('idle', null, 1200));
  out.push(await measure('walk', () => g.input.setTouchMove(0, 1), 2000));
  g.input.setTouchSprint(true);
  out.push(await measure('sprint', null, 2000));
  g.input.setTouchSprint(false);
  g.input.clearTouchMove();
  out.push(await measure('stopped', null, 1500));
  out.push(await measure('walk again', () => g.input.setTouchMove(0, 1), 2000));
  g.input.clearTouchMove();
  out.push(await measure('idle again', null, 1500));
  out.push(await measure('after firing', () => { g.input.setTouchFire(true); g.input.setTouchFire(false); }, 1500));

  // Which layers think they are running, and are their frames advancing?
  const layers = [...g.player.animation.layers.entries()].map(([name, l]) => ({
    name,
    weight: +l.weight.toFixed(3),
    active: l.active,
    groupPlaying: l.group.isPlaying,
    frame: +(l.group.animatables[0]?.masterFrame?.toFixed(1) ?? -1),
  }));
  return { steps: out, layers, override: g.player.animation.currentOverride };
});
console.log('\n=== animation health ===');
for (const s of anim.steps) console.log(`  ${s.label.padEnd(14)} distinctPoses=${String(s.distinctPoses).padEnd(3)} ${s.frozen ? 'FROZEN' : 'animating'}`);
console.log('  layers:', JSON.stringify(anim.layers));
console.log('  override:', anim.override);

await browser.close();
