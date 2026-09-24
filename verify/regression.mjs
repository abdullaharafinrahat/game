/**
 * Regression checks for the three reported bugs:
 *   "all movement are reverse", "the gun has been reverse", "no animation".
 *
 * Each is measured, not eyeballed:
 *
 *  1. Movement     - press forward and check the movement vector agrees with the
 *                    camera's view direction (dot product should be ~ +1).
 *                    Also checks strafing (D should move to the camera's right).
 *  2. Aiming       - the character must face where the camera looks.
 *  3. Weapon       - the barrel must point along the character's visual forward
 *                    (its local +Z) and stay level.
 *  4. Animation    - leg bones must actually change across idle/walk/sprint/
 *                    stop transitions, with only one locomotion clip at weight.
 *  5. Facing       - while walking, the model's visual forward must match the
 *                    direction of travel.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${process.env.GAME_URL ?? 'http://localhost:5173'}/?q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });

const frames = async (n = 2) => {
  const s = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForFunction((x) => window.__game.scene.getFrameId() >= x, s + n, { timeout: 120000 });
};

await page.evaluate(() => window.__game.start());
await frames(8);

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
};

const vec = (v) => `(${v.map((n) => n.toFixed(2)).join(', ')})`;

/** Runs a movement command and reports where the player went vs. the view dir. */
async function tryMove(label, moveX, moveY, yaw) {
  await page.evaluate((y) => {
    const g = window.__game;
    g.camera.yaw = y;
    g.camera.pitch = -0.1;
  }, yaw);
  await frames(3);
  const before = await page.evaluate(() => {
    const g = window.__game;
    const p = g.player.position;
    const dir = g.camera.camera.getDirection(new (p.constructor)(0, 0, 1));
    // Camera-relative right, in Babylon's left-handed convention.
    const right = new (p.constructor)(dir.z, 0, -dir.x).normalize();
    return {
      x: p.x,
      z: p.z,
      view: [dir.x, dir.z],
      right: [right.x, right.z],
      modelForward: [g.player.root.forward.x, g.player.root.forward.z],
    };
  });
  await page.evaluate((m) => window.__game.input.setTouchMove(m[0], m[1]), [moveX, moveY]);
  await frames(30);
  const after = await page.evaluate(() => {
    const g = window.__game;
    const f = g.player.root.forward.clone();
    f.y = 0;
    f.normalize();
    return { x: g.player.position.x, z: g.player.position.z, yaw: g.player.root.rotation.y, forward: [f.x, f.z] };
  });
  await page.evaluate(() => window.__game.input.clearTouchMove());
  await frames(4);

  const d = [after.x - before.x, after.z - before.z];
  const len = Math.hypot(d[0], d[1]);
  const unit = len > 1e-6 ? [d[0] / len, d[1] / len] : [0, 0];
  const dotView = unit[0] * before.view[0] + unit[1] * before.view[1];
  const dotRight = unit[0] * before.right[0] + unit[1] * before.right[1];
  const dotModel = unit[0] * before.modelForward[0] + unit[1] * before.modelForward[1];
  // Facing is rate limited now, so compare the travel direction against where he
  // is looking AFTER the move — that is the steady state. (The old check used the
  // pre-move heading, which only passed because turning used to be an instant snap.)
  const dotModelSettled = unit[0] * after.forward[0] + unit[1] * after.forward[1];
  return { label, moved: len, dotView, dotRight, dotModel, dotModelSettled, yaw: after.yaw, view: before.view, dir: unit };
}

console.log('=== movement ===');
const fwd = await tryMove('forward', 0, 1, 0);
check('W moves along the view direction', fwd.moved > 1 && fwd.dotView > 0.9, `moved ${fwd.moved.toFixed(1)} m, dot(view) = ${fwd.dotView.toFixed(3)}`);
const back = await tryMove('back', 0, -1, 0);
check('S moves away from the view', back.moved > 1 && back.dotView < -0.9, `moved ${back.moved.toFixed(1)} m, dot(view) = ${back.dotView.toFixed(3)}`);
const right = await tryMove('right', 1, 0, 0);
check('D strafes to the camera right', right.moved > 1 && right.dotRight > 0.9, `moved ${right.moved.toFixed(1)} m, dot(right) = ${right.dotRight.toFixed(3)}`);
const fwdYaw = await tryMove('forward, yaw=pi/2', 0, 1, Math.PI / 2);
check('W honours the camera yaw', fwdYaw.moved > 1 && fwdYaw.dotView > 0.9, `moved ${fwdYaw.moved.toFixed(1)} m, dot(view) = ${fwdYaw.dotView.toFixed(3)}`);
check('model faces direction of travel', fwdYaw.dotModelSettled > 0.9, `dot(travel, model forward) = ${fwdYaw.dotModelSettled.toFixed(3)}`);

// --------------------------------------------------------------- facing/aim
console.log('\n=== facing & aim ===');
const aimCheck = await page.evaluate(async () => {
  const g = window.__game;
  g.camera.yaw = 2.1;
  g.input.toggleAim(true);
  await new Promise((r) => setTimeout(r, 900));
  const out = { yaw: g.camera.yaw, modelYaw: g.player.root.rotation.y, aimBlend: g.camera.aimBlend };
  g.input.toggleAim(false);
  return out;
});
const yawDelta = Math.abs(((aimCheck.modelYaw - aimCheck.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
check('aiming faces the camera direction', yawDelta < 0.25, `model yaw ${aimCheck.modelYaw.toFixed(2)} vs camera yaw ${aimCheck.yaw.toFixed(2)} (delta ${yawDelta.toFixed(3)})`);

// ----------------------------------------------------------------- facing
console.log('\n=== facing policy ===');

/** Yaw of the character's forward axis, and the camera's, on the next frame. */
const yawPair = () => page.evaluate(() => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor;
  const obs = scene.onAfterRenderObservable.add(() => {
    scene.onAfterRenderObservable.remove(obs);
    const f = g.player.root.forward.clone();
    f.y = 0;
    f.normalize();
    resolve({
      model: Math.atan2(f.x, f.z),
      camera: g.camera.yaw,
      speed: g.player.speed,
      t: performance.now(),
    });
  });
}));

// Standing still, the camera must orbit WITHOUT the character turning.
await page.evaluate(() => { window.__game.input.clearTouchMove(); window.__game.camera.yaw = 0; });
await frames(6);
const standBefore = await yawPair();
await page.evaluate(() => window.__game.input.addLook(160, 0));
await frames(8);
const standAfter = await yawPair();
const camMoved = Math.abs(standAfter.camera - standBefore.camera);
const modelMoved = Math.abs(((standAfter.model - standBefore.model + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
check('standing: mouse orbits the camera only', camMoved > 0.08 && modelMoved < 0.03,
  `camera ${camMoved.toFixed(3)} rad, character ${modelMoved.toFixed(3)} rad`);

// Moving: he turns to follow the camera's new heading (rate limited).
await page.evaluate(() => { window.__game.camera.yaw = 0; window.__game.input.setTouchMove(0, 1); });
await frames(25);
await page.evaluate(() => { window.__game.camera.yaw += Math.PI; });
const turn = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor;
  const samples = [];
  const obs = scene.onAfterRenderObservable.add(() => {
    const f = g.player.root.forward.clone();
    f.y = 0;
    f.normalize();
    samples.push({ yaw: Math.atan2(f.x, f.z), t: performance.now() / 1000 });
    if (samples.length >= 10) {
      scene.onAfterRenderObservable.remove(obs);
      let maxRate = 0;
      for (let i = 1; i < samples.length; i++) {
        let d = samples[i].yaw - samples[i - 1].yaw;
        d = ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const dt = samples[i].t - samples[i - 1].t;
        if (dt > 1e-4) maxRate = Math.max(maxRate, Math.abs(d) / dt);
      }
      resolve({ maxRate, seconds: samples[samples.length - 1].t - samples[0].t });
    }
  });
}));
// TURN.moving is 8.4 rad/s; allow a little slack for frame quantisation.
check('turning is rate limited, not a snap', turn.maxRate > 0.5 && turn.maxRate <= 12,
  `peak ${turn.maxRate.toFixed(1)} rad/s over ${turn.seconds.toFixed(2)}s (cap 8.4)`);

// ...and he does arrive at the new heading.
await frames(20);
const afterMove = await yawPair();
const camDir = await page.evaluate(() => {
  const g = window.__game;
  const V = g.player.position.constructor;
  const d = g.camera.camera.getDirection(V.Forward());
  d.y = 0;
  d.normalize();
  return Math.atan2(d.x, d.z);
});
const settle = Math.abs(((afterMove.model - camDir + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
check('he ends up facing the new heading', settle < 0.15, `${settle.toFixed(3)} rad off the camera direction`);
await page.evaluate(() => window.__game.input.clearTouchMove());
await frames(6);

// Aiming locks him to the camera even from a standing start.
await page.evaluate(() => { window.__game.camera.yaw = -1.1; });
await frames(4);
const standStill = await yawPair();
await page.evaluate(() => window.__game.input.toggleAim(true));
await frames(14);
const aimed = await yawPair();
await page.evaluate(() => window.__game.input.toggleAim(false));
const movedWhileStanding = Math.abs(((standStill.model - standStill.camera + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
const aimedAtCamera = Math.abs(((aimed.model - aimed.camera + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
check('aiming turns him to the camera from standing', movedWhileStanding > 0.2 && aimedAtCamera < 0.12,
  `${movedWhileStanding.toFixed(2)} rad away before, ${aimedAtCamera.toFixed(3)} after`);
await frames(4);

// ------------------------------------------------------------ look controls
console.log('\n=== look controls ===');
const lookSample = (setter) => page.evaluate((fn) => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor;
  // eslint-disable-next-line no-new-func
  new Function('g', fn)(g);
  const obs = scene.onAfterRenderObservable.add(() => {
    scene.onAfterRenderObservable.remove(obs);
    const d = g.camera.camera.getDirection(V.Forward());
    d.y = 0;
    d.normalize();
    resolve({ yaw: g.camera.yaw, pitch: g.camera.pitch, x: d.x, z: d.z });
  });
}), setter);

const base = await lookSample('g.camera.yaw = 0; g.camera.pitch = 0;');
const lookRight = await lookSample('g.camera.yaw = 0; g.input.addLook(120, 0);');
const lookDown = await lookSample('g.camera.pitch = 0; g.input.addLook(0, 120);');
// The camera's right vector at yaw 0 is +X, so a rightward turn must move the
// view direction toward positive X.
check('mouse right turns the view right', lookRight.x > 0.05, `view x ${base.x.toFixed(2)} -> ${lookRight.x.toFixed(2)}, yaw ${lookRight.yaw.toFixed(2)}`);
check('mouse down looks down', lookDown.pitch > base.pitch, `pitch ${base.pitch.toFixed(2)} -> ${lookDown.pitch.toFixed(2)}`);
await page.evaluate(() => { window.__game.camera.yaw = 0; window.__game.camera.pitch = 0; });
await frames(3);

// ------------------------------------------------------------------ weapon
console.log('\n=== weapon ===');
const weapon = async (label) => {
  const w = await page.evaluate(() => {
    const g = window.__game;
    const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
    const pivot = g.scene.getTransformNodeByName('weaponPivot').getAbsolutePosition();
    const dir = muzzle.subtract(pivot).normalize();
    const fwd = g.player.root.forward.clone();
    fwd.y = 0;
    fwd.normalize();
    return {
      pitchDeg: Math.asin(Math.max(-1, Math.min(1, dir.y))) * (180 / Math.PI),
      dotForward: dir.x * fwd.x + dir.z * fwd.z,
      lengthM: +g.player.weapon.modelMesh.getBoundingInfo().boundingBox.extendSize.length().toFixed(2),
    };
  });
  check(`barrel points forward (${label})`, weapon.dotForwardResult ?? w.dotForward > 0.9, `dot(barrel, model forward) = ${w.dotForward.toFixed(3)}`);
  check(`barrel stays level (${label})`, Math.abs(w.pitchDeg) < 12, `pitch ${w.pitchDeg.toFixed(1)} deg`);
  return w;
};
void weapon;

const wIdle = await page.evaluate(() => {
  const g = window.__game;
  const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
  const pivot = g.scene.getTransformNodeByName('weaponPivot').getAbsolutePosition();
  const dir = muzzle.subtract(pivot).normalize();
  const fwd = g.player.root.forward.clone();
  fwd.y = 0;
  fwd.normalize();
  return { pitch: Math.asin(dir.y) * (180 / Math.PI), dot: dir.x * fwd.x + dir.z * fwd.z };
});
check('barrel points forward (idle)', wIdle.dot > 0.9, `dot = ${wIdle.dot.toFixed(3)}`);
check('barrel stays level (idle)', Math.abs(wIdle.pitch) < 12, `pitch ${wIdle.pitch.toFixed(1)} deg`);

await page.evaluate(() => window.__game.input.setTouchMove(0, 1));
await frames(25);
const wWalk = await page.evaluate(() => {
  const g = window.__game;
  const muzzle = g.player.weapon.muzzleNode.getAbsolutePosition();
  const pivot = g.scene.getTransformNodeByName('weaponPivot').getAbsolutePosition();
  const dir = muzzle.subtract(pivot).normalize();
  const fwd = g.player.root.forward.clone();
  fwd.y = 0;
  fwd.normalize();
  return { pitch: Math.asin(dir.y) * (180 / Math.PI), dot: dir.x * fwd.x + dir.z * fwd.z };
});
check('barrel points forward (walking)', wWalk.dot > 0.9, `dot = ${wWalk.dot.toFixed(3)}`);
check('barrel stays level (walking)', Math.abs(wWalk.pitch) < 12, `pitch ${wWalk.pitch.toFixed(1)} deg`);
await page.evaluate(() => window.__game.input.clearTouchMove());
await frames(4);

// --------------------------------------------------------------- animation
console.log('\n=== animation ===');
const anim = await page.evaluate(async () => {
  const g = window.__game;
  const bones = ['LeftUpLeg', 'RightArm', 'Spine'].map((n) => g.library.character.skeleton.bones.find((b) => b.name.endsWith(n)));
  const read = () => bones.map((b) => b.getTransformNode().rotationQuaternion.asArray().map((v) => +v.toFixed(4)).join(','));
  const sample = async (ms) => {
    const seen = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      seen.add(read().join('|'));
      await new Promise((r) => setTimeout(r, 60));
    }
    return seen.size;
  };
  const steps = [];
  steps.push({ label: 'idle', poses: await sample(1200) });
  g.input.setTouchMove(0, 1);
  steps.push({ label: 'walk', poses: await sample(2000) });
  g.input.setTouchSprint(true);
  steps.push({ label: 'sprint', poses: await sample(2000) });
  g.input.setTouchSprint(false);
  g.input.clearTouchMove();
  await new Promise((r) => setTimeout(r, 900));
  steps.push({ label: 'stopped', poses: await sample(1500) });

  const layers = [...g.player.animation.layers.entries()].map(([name, l]) => ({
    name,
    weight: +l.weight.toFixed(2),
    playing: l.group.isPlaying,
    frame: +(l.group.animatables[0]?.masterFrame ?? -1).toFixed(1),
  }));
  const total = layers.reduce((a, l) => a + (l.playing ? l.weight : 0), 0);
  return { steps, layers, totalWeight: +total.toFixed(2) };
});
for (const s of anim.steps) {
  check(`bones animate while ${s.label}`, s.poses > 3, `${s.poses} distinct poses sampled`);
}
const playing = anim.layers.filter((l) => l.playing);
check('single locomotion clip at weight', anim.totalWeight <= 1.05, `total weight ${anim.totalWeight} across ${playing.length} playing: ${playing.map((l) => `${l.name}=${l.weight}`).join(', ')}`);

console.log(`\nsummary: ${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
