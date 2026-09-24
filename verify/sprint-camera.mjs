/**
 * Sprint camera: while sprinting it must ride level and straight behind the
 * player — no vertical movement (no pitch, no bob), no sideways sway — while
 * horizontal steering still works. Walking must keep the normal free camera.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${process.env.GAME_URL ?? 'http://localhost:5173'}/?q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && !document.getElementById('start').classList.contains('hidden'), null, { timeout: 300000 });
await page.evaluate(() => window.__game.start());
await page.waitForTimeout(2500);

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

/**
 * Runs the scenario and samples, every frame, the camera's own position and
 * orientation together with the player's ground position.
 */
const run = (setup, frames = 150, lookPerFrame = [0, 0]) => page.evaluate(([fn, n, look]) => new Promise((resolve) => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor;
  // eslint-disable-next-line no-new-func
  new Function('g', fn)(g);
  const samples = [];
  const obs = scene.onBeforeRenderObservable.add(() => {
    if (look[0] || look[1]) g.input.addLook(look[0], look[1]);
    const cam = g.camera.camera;
    samples.push({
      camY: cam.globalPosition.y,
      cam: [cam.globalPosition.x, cam.globalPosition.z],
      pitch: g.camera.pitch,
      yaw: g.camera.yaw,
      viewY: cam.getDirection(V.Forward()).y,
      player: [g.player.position.x, g.player.position.z],
      speed: g.player.speed,
      sprinting: g.player.sprinting,
      grounded: g.player.grounded,
      lock: g.camera.sprintLock ?? null,
    });
    if (samples.length >= n) {
      scene.onBeforeRenderObservable.remove(obs);
      const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
      const last = samples[samples.length - 1];

      // Vertical stability and straightness are asserted only while the lock is
      // engaged on the ground: a kerb or ledge briefly lifts the lock (by design,
      // so a jump cannot strand the camera), which would otherwise make these
      // metrics depend on which route the sprint happened to take.
      const steady = samples.slice(Math.min(45, samples.length - 1)).filter((s) => s.lock > 0.9 && s.grounded);
      const steadyIndex = new Set(steady);

      const s0 = steady.length ? steady[Math.min(5, steady.length - 1)] : null;
      const dir = s0 ? [last.player[0] - s0.player[0], last.player[1] - s0.player[1]] : [1, 0];
      const dl = Math.hypot(dir[0], dir[1]) || 1;
      const u = [dir[0] / dl, dir[1] / dl];

      let maxPerp = 0;
      let maxStepY = 0;
      let maxStep = 0;
      // Distinguish a slow settle over sloping ground (intended, one direction)
      // from bob/jitter (must be zero, and flips sign frame after frame).
      let yFlips = 0;
      let lastYSign = 0;
      for (let i = 1; i < samples.length; i++) {
        if (!steadyIndex.has(samples[i]) || !steadyIndex.has(samples[i - 1])) continue;
        const dx = samples[i].cam[0] - samples[i - 1].cam[0];
        const dz = samples[i].cam[1] - samples[i - 1].cam[1];
        maxStep = Math.max(maxStep, Math.hypot(dx, dz));
        const dy = samples[i].camY - samples[i - 1].camY;
        maxStepY = Math.max(maxStepY, Math.abs(dy));
        const sign = Math.abs(dy) < 1e-4 ? lastYSign : Math.sign(dy);
        if (lastYSign !== 0 && sign !== 0 && sign !== lastYSign) yFlips += 1;
        if (Math.abs(dy) >= 1e-4) lastYSign = sign;
        if (s0) {
          const v = [samples[i].cam[0] - s0.cam[0], samples[i].cam[1] - s0.cam[1]];
          maxPerp = Math.max(maxPerp, Math.abs(v[0] * u[1] - v[1] * u[0]));
        }
      }

      resolve({
        speedAvg: +(samples.reduce((a, s) => a + s.speed, 0) / samples.length).toFixed(2),
        sprintFrames: samples.filter((s) => s.sprinting).length,
        steadyFrames: steady.length,
        lockEnd: +(last.lock ?? -1).toFixed(2),
        steadyCamYSpread: +spread(steady.map((s) => s.camY)).toFixed(4),
        maxStepY: +maxStepY.toFixed(4),
        maxStep: +maxStep.toFixed(3),
        yFlips,
        pitchSpread: +spread(samples.map((s) => s.pitch)).toFixed(4),
        pitchEnd: +last.pitch.toFixed(4),
        yawTravel: +(last.yaw - samples[0].yaw).toFixed(3),
        viewYSpread: +spread(samples.map((s) => s.viewY)).toFixed(4),
        maxPerpDeviation: +maxPerp.toFixed(3),
        travelled: +dl.toFixed(1),
      });
    }
  });
}), [setup, frames, lookPerFrame]);

console.log('=== sprint: level and straight ===');
const sprint = await run('g.input.setTouchMove(0,1); g.input.setTouchSprint(true); g.camera.yaw = 0; g.camera.pitch = 0;', 160, [0, 0]);
check('sprint engages the lock', sprint.lockEnd > 0.9 && sprint.speedAvg > 5, `lock ${sprint.lockEnd}, avg speed ${sprint.speedAvg} m/s`);
check('enough steady-state frames to judge', sprint.steadyFrames >= 10, `${sprint.steadyFrames} locked-and-grounded frames`);
check('no vertical camera travel while sprinting', sprint.yFlips <= 2 && sprint.steadyCamYSpread < 0.06,
  `${sprint.yFlips} vertical direction changes, ${sprint.steadyCamYSpread} m total (${(sprint.maxStepY * 1000).toFixed(1)} mm worst frame) over ${sprint.travelled} m travelled`);
check('camera stays level', sprint.pitchSpread < 0.01 && Math.abs(sprint.pitchEnd) < 0.02, `pitch spread ${sprint.pitchSpread}, ends at ${sprint.pitchEnd} rad`);
check('camera path is straight', sprint.maxPerpDeviation < 0.05,
  `max sideways deviation ${sprint.maxPerpDeviation} m in steady state (per frame ${(sprint.maxStep * 1000 / 1).toFixed(0)} mm)`);

console.log('\n=== sprint: vertical look is ignored ===');
const up = await run('g.input.clearTouchMove(); g.camera.pitch = 0; g.camera.yaw = 0; g.input.setTouchMove(0,1); g.input.setTouchSprint(true);', 90, [0, 60]);
check('mouse-up cannot tilt the sprint camera', Math.abs(up.pitchEnd) < 0.02, `pitch ended at ${up.pitchEnd} rad after 90 frames of drag-up`);
const upAfterLock = await run('g.input.setTouchMove(0,1); g.input.setTouchSprint(true);', 90, [0, 60]);
check('still level under sustained drag-up', Math.abs(upAfterLock.pitchEnd) < 0.02 && upAfterLock.pitchSpread < 0.02, `pitch ${upAfterLock.pitchEnd}, spread ${upAfterLock.pitchSpread}`);

console.log('\n=== sprint: horizontal steering still works ===');
const steer = await run('g.input.setTouchMove(0,1); g.input.setTouchSprint(true);', 120, [10, 0]);
check('mouse still yaws the sprint camera', Math.abs(steer.yawTravel) > 0.2, `yaw travelled ${steer.yawTravel} rad`);
check('steering keeps the camera level', steer.pitchSpread < 0.02 && steer.yFlips <= 2 && steer.steadyCamYSpread < 0.06,
  `pitch spread ${steer.pitchSpread}, ${steer.yFlips} vertical direction changes, ${steer.steadyCamYSpread} m total over the turn`);

console.log('\n=== sprint-jump keeps him in frame ===');
// The lock is grounded-gated: a jump must release it, or the camera would stay
// pinned to the ground and watch the player leave the frame. The jump is fired
// from Node between frames — the one-shot `jumpPressed` flag is cleared by
// `input.endFrame()` at the end of each frame, so setting it from inside a render
// observer is swallowed before the next update ever sees it.
await page.evaluate(() => {
  const g = window.__game, scene = g.scene;
  const V = g.player.position.constructor;
  const M = scene.getTransformMatrix().constructor;
  window.__jumpSamples = [];
  g.input.setTouchMove(0, 1);
  g.input.setTouchSprint(true);
  window.__jumpObserver = scene.onBeforeRenderObservable.add(() => {
    const cam = g.camera.camera;
    const w = scene.getEngine().getRenderWidth(), h = scene.getEngine().getRenderHeight();
    const vp = cam.viewport.toGlobal(w, h);
    const head = g.player.position.add(new V(0, 0.45, 0));
    const screen = V.Project(head, M.Identity(), scene.getTransformMatrix(), vp);
    window.__jumpSamples.push({
      grounded: g.player.grounded,
      lock: g.camera.sprintLock,
      playerY: g.player.position.y,
      camY: cam.globalPosition.y,
      screenY: screen.y / h,
      screenX: screen.x / w,
    });
  });
});
await page.waitForTimeout(900);
await page.evaluate(() => window.__game.input.pressJump());
await page.waitForTimeout(2000);
const jump = await page.evaluate(() => {
  const scene = window.__game.scene;
  scene.onBeforeRenderObservable.remove(window.__jumpObserver);
  const samples = window.__jumpSamples;
  const air = samples.filter((s) => !s.grounded);
  return {
    totalFrames: samples.length,
    airFrames: air.length,
    playerRose: +(Math.max(...samples.map((s) => s.playerY)) - Math.min(...samples.map((s) => s.playerY))).toFixed(2),
    camFollowed: air.length ? +(Math.max(...air.map((s) => s.camY)) - Math.min(...air.map((s) => s.camY))).toFixed(2) : 0,
    lockInAir: air.length ? +Math.max(...air.map((s) => s.lock)).toFixed(2) : 0,
    lockEndOfAir: air.length ? +air[air.length - 1].lock.toFixed(2) : -1,
    lockMinInAir: air.length ? +Math.min(...air.map((s) => s.lock)).toFixed(2) : -1,
    screenYRange: +(Math.max(...samples.map((s) => s.screenY)) - Math.min(...samples.map((s) => s.screenY))).toFixed(2),
    onScreen: samples.every((s) => s.screenY > 0 && s.screenY < 1 && s.screenX > 0 && s.screenX < 1),
  };
});
// The lock fades rather than snapping (an instant release pops the camera), so
// assert it has *disengaged* by the end of the jump rather than at its first frame.
check('the lock releases while airborne', jump.airFrames > 3 && jump.lockEndOfAir < 0.2 && jump.lockMinInAir < 0.2,
  `${jump.airFrames} of ${jump.totalFrames} frames airborne, lock ${jump.lockInAir} -> ${jump.lockEndOfAir}`);
check('the camera follows a sprint-jump', jump.playerRose > 0.5 && jump.camFollowed > 0.3,
  `player rose ${jump.playerRose} m, camera followed ${jump.camFollowed} m`);
check('the player stays framed', jump.onScreen && jump.screenYRange < 0.6,
  `vertical screen travel ${jump.screenYRange} of frame, always on screen: ${jump.onScreen}`);
await page.evaluate(() => { window.__game.input.clearTouchMove(); window.__game.input.setTouchSprint(false); });
await page.waitForTimeout(600);

console.log('\n=== walking is unaffected ===');
const walk = await run('g.input.clearTouchMove(); g.input.setTouchSprint(false); g.camera.pitch = 0; g.camera.yaw = 0; g.input.setTouchMove(0,1);', 90, [0, 60]);
check('walking still allows vertical look', Math.abs(walk.pitchEnd) > 0.1, `pitch ended at ${walk.pitchEnd} rad (free camera preserved)`);

console.log(`\nsummary: ${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
