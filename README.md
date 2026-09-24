# CRASS — third-person browser shooter

Built from the [crass `optimized_assets`](../../..) pack: a Mixamo-rigged hero, 27 animation
clips, a battleground, four buildings and a sniper rifle — running in the browser at **~7 MB**
instead of the pack's **~130 MB**.

Live demo: `npm run dev` (desktop and mobile layouts both supported).

---

## Which framework, and why

**Babylon.js 8 + Havok physics, in TypeScript, bundled by Vite.**

The deciding factor was reading the asset pack rather than the feature lists. Two things in it
settle the question:

**1. It is a 3D animation pack, so the 2D engines are out.** The 27 clips are not sprites — they
are skinned skeletal animation (195 channels each) on a single 65-joint Mixamo skeleton, and a
third-person shooter needs a character controller, camera occlusion and hit-scanning. That rules
out Phaser, PixiJS and Kaplay no matter how good they are, and it means you are choosing between
Babylon.js, Three.js (bare or React Three Fiber) and PlayCanvas.

**2. The pack ships a character with no animations, and animations with no character.** Every clip
GLB is a *bare skeleton*: an `Armature` node tree plus one Mixamo clip and **zero meshes**. The
character GLB has the meshes, the skin, and **zero clips**. So the first real engineering task is
binding 27 clips onto one skeleton at runtime — which is exactly the kind of work an engine with a
first-class animation system handles well, and the kind you would otherwise hand-roll.

Babylon won on that second point:

| What the pack demands | Babylon.js 8 | Three.js | R3F |
|---|---|---|---|
| Retarget 27 bare-skeleton clips onto one rig | `AnimationGroup` + bone lookup, we keep only keyframe data (`src/core/Retarget.ts`) | doable, but you build the mixer/weight layer | same as Three, plus a React layer |
| Blend locomotion by speed with matched feet | `AnimationGroup.weight` + `speedRatio` + `syncAllAnimationsWith()` | manual weights per action | manual weights per action |
| Capsule character with slopes, steps, coyote time | `PhysicsCharacterController` built in | assemble from Rapier | assemble from Rapier |
| Physics without a SIMD-capable CPU | Havok's WASM needs no `simd128` (verified — matters on mid-range Android) | Rapier WASM works too | same |
| Debug why the rig is sideways | Inspector, `scene.debugLayer` | custom | custom |

Babylon's built-in `PhysicsCharacterController` and animation-group blending are the two things
that turned a multi-week systems project into an afternoon of tuning, and `?q=low` on a mid-range
Android is a supported configuration rather than a rewrite. Pick Three.js instead if you want the
smallest possible core or you are porting Three-specific code; pick R3F if the HUD and menus are
going to be a real React app. Neither is wrong — Babylon is simply less code for *this* pack.

Character controller, physics and rendering all run client-side, so the build is fully static and
deploys to any file host.

---

## What the asset pack actually contains

Findings from `tools/inspect.mjs` and the pipeline, all of which shaped the code:

| Asset | Reality |
|---|---|
| `character.glb` | 56,258 tris, 65-joint rig (`mixamorig7:*`), **no animation clips**, **91.4 MB — six 4K PNG textures** (one is 23.7 MB) |
| 27 clip files | **Animation-only**, no mesh, no materials. Same 65 joints → they bind straight onto the character |
| `battleground.glb` | 2,708 tris, 13 meshes. **Authored in centimetres: 11,545 × 11,545 units (an 11.5 km map)** |
| `house*.glb` | ~0.8 units tall each — metre-ish scale, i.e. a *different* unit convention from the battleground |
| `weapon_sniper.glb` | 2,940 tris, longest axis is **X** (9.81 × 1.90 × 0.54), mesh node carries a 180° Z rotation and a mirroring Y scale |

Three unit conventions and a non-identity node transform in one pack, so nothing in this project
hardcodes a magic number: the pipeline measures and records unit scale, up-axis, clip duration and
root-motion drift; the runtime measures mesh bounds, foot offset, capsule clearance and weapon
orientation. `src/config.ts` only holds tuning.

### The clips

All 27 bind with **0 unmatched bones**. Retargeting keeps keyframes only and points them at the
character's joints; the clip's own skeleton is then discarded, so the header notes scenes that
drop a `Skin` node come from that cleanup.

Playback logic is speed-driven: the armed and unarmed sets (`Idle/RifleIdle`, `Walk/RifleWalk`,
`Run/RifleRun`, `Sprint`, `Jump/RifleJump`) blend by weight against real movement speed and are
phase-synced, so the feet do not pop between cycles of different length (Walk 1.03 s vs Sprint
0.52 s). One-shots (`FireRifle`, `Reload`, `ProneToKneel`, `Dying`, …) fade in as overlays and
suppress locomotion while they run.

**Root motion is stripped and measured.** Mixamo bakes travel into the Hips translation track
(`Sprint` walks 3.45 m per 0.52 s cycle). Gameplay code owns the transform, so the two horizontal
axes are pinned to the clip's first key while the vertical axis is left alone so bobbing and jump
arcs survive. The pipeline reports each clip's drift, and the measured value is used to compute
playback rate — `Sprint` gives 6.6 m/s, which is where `MOVE.sprint` comes from.

---

## Running it

```bash
npm install
npm run assets      # pulls the pack from the crass repo, optimizes it into public/assets
npm run dev         # http://localhost:5173
```

`npm run assets` is required once before the first run — it is what turns 130 MB of 4K PNGs into a
~7 MB payload (91.4 MB character → 3.2 MB, textures resized to 1024 px and re-encoded as WebP).
Sources are cached in `.asset-cache/` (gitignored).

```bash
npm run build       # typecheck + production build into dist/
npm run preview     # serve the build
npm run assets:check # validate the manifest and the built files
```

The production bundle is fully static and uses relative paths, so `dist/` drops onto GitHub
Pages, Netlify, S3 or a subfolder of any host. A Pages workflow is included as
`tools/deploy-workflow.yml` — copy it to `.github/workflows/deploy.yml` to enable CI deploys
(that step needs a token with the `workflow` scope).

### Controls

| Desktop | |
|---|---|
| `WASD` | move |
| Mouse | look (click to lock the pointer); orbits the camera, and the character turns with it when moving or aiming |
| `Shift` | sprint |
| `Space` | jump (coyote time + input buffering) |
| `Ctrl` / `C` | crouch |
| `LMB` / `RMB` | fire / aim down sights |
| `R` | reload |
| Wheel | camera distance |
| `Esc` / `P` | pause |
| `F3` | debug overlay |
| `Q` | cycle quality tier |

Touch: dragging the right half orbits the camera exactly like the mouse; the character turns with it
when moving or aiming. Left stick moves (push to the rim to sprint), and the
on-screen buttons fire, jump, reload, aim, crouch and toggle sprint. The layout is chosen from
`pointer: coarse`, and the same `InputManager` state feeds both paths, so gameplay code never
branches on platform.

---

## Camera and facing

The camera always orbits the player (it is never first-person), and the character
follows it differently depending on what he is doing:

| State | Character | Camera |
| --- | --- | --- |
| Standing still | keeps his heading | free — the mouse orbits him, so you can walk the camera round and look at him |
| Moving | turns toward his direction of travel, rate limited (~480°/s) | follows him |
| Aiming or firing | turns to the camera, rate limited (~920°/s) | tight, with the ADS shoulder offset |

Turns are rate limited rather than instant. A hard snap to the camera yaw is
*invisible*: because the camera is always behind him, rotating the character
produces no change on screen at all — the entire world appears to spin while the
mute model stays pinned centre-frame. That is what "the camera moves, not the
character" turned out to describe. A bounded turn rate makes the pivot something
you can actually see, and free-orbit idle means the mouse does not drag him
around while he is standing.

A shot holds his facing on the camera for `TURN.fireHold` (0.5 s), so firing
while standing does not swing the rifle off target.

### The sprint camera

While sprinting the camera rides **level and straight behind the player**: it does
not rise or fall, does not bob with the run, and does not tilt. Measured on a
34 m sprint: pitch spread **0.000 rad**, total height change **2.5 mm**, path
deviation **1 mm**. Horizontal steering is untouched — a 150° turn still tracks
the mouse, and the camera stays level throughout.

Four things had to be neutralised to get there, each of which is a real camera
motion source:

1. **Vertical look.** `look.y` is faded out while sprinting (this also covers touch
   drag, which feeds the same axis), and the pitch eases back to level rather than
   holding whatever tilt it had. Recoil pitch is faded out too.
2. **The vertical component of the spring arm.** The arm points slightly upward, so
   when it shortens against geometry the camera rides up and down with it —
   measured at **36 mm per frame** while turning past the level's buildings. The
   rig is now pinned to a level plane while sprinting and the look target is
   shifted by the same amount, so the view direction is untouched while the arm
   still shortens horizontally when it must.
3. **The shoulder offset.** A sideways camera offset swings the view left and right
   every time the yaw moves, which is the "not a straight line" motion. It fades
   out, leaving the camera centred behind him on the same line he is running.
4. **Camera shake.** Recoil shake is suppressed during the sprint.

Eye height is held steady instead of tracking the capsule, so ground bumps and the
gait cycle cannot move the camera; it still settles onto a slope over about a
second, with a safety net (`CAMERA.sprintHeightLag`) that snaps it if the terrain
drops away further than it will follow.

The lock is **grounded-gated**: jumping releases it quickly
(`CAMERA.sprintLockAirborneRate`) so the camera follows him into the air instead of
watching him leave the frame — verified with a sprint-jump (he rises 0.93 m, the
camera follows 0.94 m, and he never leaves the view).

## Architecture

```
src/
  main.ts                  boot, fixed game loop, dev measurement tools
  config.ts                every tuning constant + quality presets
  core/
    Assets.ts              manifest-driven loading, progress, character binding
    Retarget.ts            clip -> skeleton binding, root-motion stripping
    Environment.ts         sky dome, sun, shadows, IBL probe (no .hdr to download)
    ThirdPersonCamera.ts   spring arm, ADS blend, recoil, occlusion
    Quality.ts             device tiering (cores / GPU / DPR)
    Audio.ts               procedural WebAudio SFX — zero audio bytes
  entities/
    Player.ts              Havok character controller + animation state machine
    AnimationController.ts weighted locomotion blend + one-shot overlays
    Weapon.ts              hit-scan, muzzle-flash, tracers, decals, explosions
  input/                   InputManager (unified) + TouchControls (DOM)
  world/Level.ts           scaled map, colliders, houses, shootable props
  ui/Hud.ts                DOM HUD, menus, settings
tools/
  asset-manifest.mjs       source -> output mapping and texture budgets
  fetch-assets.mjs         the pipeline
  inspect.mjs              rig/unit/bbox inspector for any GLB
  check-assets.mjs         manifest + built-file validator
verify/                    Playwright harnesses used to validate the build
```

Two decisions worth knowing about:

- **The HUD is DOM, not Babylon GUI.** It costs no draw calls, stays crisp at any DPR, is trivial
  to make responsive, and keeps UI out of the scene graph.
- **Audio is synthesised, not shipped.** The pack has no sound at all; gunshots, impacts, reload
  clicks and footsteps are generated with WebAudio oscillators and noise. Zero bytes, and on a
  mobile connection the whole soundscape is cheaper than one MP3.

### Physics notes

- The character rests exactly `capsuleHeight / 2 + keepDistance` above the surface (0.60 m for a
  1.1 m capsule). Babylon's `capsuleHeight` is the **total** height, not the cylinder length —
  getting this wrong sinks the character 0.2 m into the road.
- The battleground uses an exact triangle-mesh collider (2.7k tris is cheap); the four houses use
  convex hulls, because four exact 56k-tri colliders is a lot of BVH to build on a phone.
- Boxes and barrels are dynamic bodies, imparted by hit-scan strikes; barrels flagged `explosive`
  detonate, shoving everything within 6.5 m and applying falloff damage to the player.

### Performance

Quality tiers are chosen from core count, `maxTextureSize` and the GPU string, and can be cycled
with `Q` or `?q=low|medium|high`. Measured payload: **3.2 MB character + 2.0 MB props + 2.3 MB
clips ≈ 7.5 MB**, against ~130 MB for the pack as shipped. Draw distance, anisotropy, shadow map
size, particle count and decal budget all scale per tier.

One deliberate behaviour: the loop clamps `dt` to 50 ms, so on a machine that cannot keep up the
game runs in slow motion rather than allowing large physics steps (which would tunnel the
character through the ground). On the software renderer used in CI that shows up as ~6× slow
motion at 3 fps; on any GPU it is invisible.

---

## Verified, not assumed

`verify/` holds the Playwright harnesses used while building this, and they were run against the
real game with a software GL renderer. They ship with the repo so the numbers below can be
re-measured: `npm install --no-save playwright && npx playwright install --with-deps chromium`,
start the game, then `node verify/regression.mjs`. See `verify/README.md`.

- `functional.mjs` — 14/14 passing: fire consumes a round and plays `FireRifle`, decals spawn,
  reload refills, crouch engages, ADS narrows FOV to 48°, barrels detonate, death plays `Dying`,
  respawn restores health, a 30 m fall lands, quality switches, pause toggles, and all 27 clips
  bind with 0 unmatched bones. No page errors.
- `measure.mjs` — reads real numbers instead of trusting constants. The capsule rest height (0.60 m),
  the map scale (11,545 units → 260 m, tallest building 14 m), the character's foot offset, and the
  weapon orientation all came out of this.
- `barrel.mjs` — asserts the rifle is horizontal (pitch −4°), pointing forward (10° off facing),
  and gripped 0.23 m from its centre — the intended 30%-from-muzzle hold.
- `regression.mjs` — 21/21 passing on both the dev server and the production build. It presses each
  movement key and checks the *measured* travel direction against the camera's view axis, samples
  leg-bone quaternions across idle → walk → sprint → stop to prove the skeleton is moving, reads the
  rifle's barrel direction against the character's facing, asserts the look axes are not inverted,
  and pins the facing policy above (camera orbits without turning him when he stands, he turns when
  he moves, turning is rate limited rather than snapped, and aiming locks him to the camera). This
  is the harness that pinned the "movement is reversed / gun is reversed / nothing animates"
  reports.

Bugs these caught that guesswork would not have:

1. The character stood 0.2 m sunk into the road (wrong capsule formula).
2. The spawn point was on a **rooftop**, because the middle of this map is a building.
3. The map was 11.5 km across, so the character was invisible; the level now measures and rescales.
4. The rifle floated **0.01 m** from the hand — the hand bone inherits a 0.01 armature scale, so
   metre-based offsets were being divided by 100.
5. The rifle pointed at the sky, from picking the *thinnest* axis as "up" when up is the *middle*
   axis (a rifle is long, tall-thin, and narrow-thinner).
6. The rifle was mounted backwards; the muzzle end is now detected by measuring which end of the
   barrel geometry is thinnest (a muzzle is a tube, a stock is a wedge), not by guessing from the
   pivot.

### The reported "everything is reversed / nothing animates" bug

Three symptoms, three unrelated causes — each measured before being changed:

1. **Movement was mirrored.** `camera.facing` was computed by hand as `-(sin yaw, cos yaw)`, which is
   the opposite of where the camera looks, and the player drives movement from it. It now derives
   from the camera's own view vector, so it cannot drift out of sync. Measured: `dot(view, travel)`
   went from −1.000 (exactly backwards) to 1.000 for W, S and D.
2. **The rifle pointed backwards.** Two compounding faults. The alignment targeted the character's
   local −Z (a Three.js habit) while this model's visual forward is its local **+Z** — verified by
   rendering it at `rotation.y = 0` and photographing which side the face is on. And the mount was
   solved once from the rest pose, so the arm animation carried the rifle away from the solve.
3. **Nothing animated.** `setLocomotion()` only wrote targets for clips present in the new blend, so
   a clip leaving the blend kept its old target of 1 forever. Two contradictory full-body clips at
   full weight average into a mush that reads as a frozen character while every layer still reports
   `weight: 1, isPlaying: true`. Unnamed layers are now ramped back to zero.

A fourth one surfaced while testing the first three: **horizontal look was inverted**, so moving the
mouse right swung the camera left (`yaw -= look.x`). Yaw *increases* clockwise seen from above — the
camera's right vector at yaw 0 is +X — so looking right means adding to yaw. Mouse-down already
looked down correctly, which made the mismatched horizontal axis easy to miss. `regression.mjs` now
asserts both axes against the camera's own basis.

### A note on this model's -Z

The character's **visual** forward is his local **+Z** (established by rendering
him at `rotation.y = 0` and photographing which side his face is on), which is
the opposite of the usual convention. Free-look made that concrete: standing at
`yaw = 0` with the camera behind him, the camera reports looking at **180°**,
because a camera placed "behind" a +Z-forward model sits on its -Z side. So
anything that assumes -Z forward — a camera offset, a muzzle direction, a
behaviour tree's "am I facing the target", an NPC's aim — needs the same flip.

### Babylon pitfalls this cost real time on

- **`TransformNode.rotationQuaternion.copyFrom(q)` does not dirty the node.** Only the *setter*
  marks it for recomposition, so writing into the existing quaternion leaves the cached world matrix
  in place. The weapon "reversed itself" for exactly this reason: the rotation was applied once at
  attach time and every later write was silently discarded. Assign a fresh `Quaternion` instead.
- **`Quaternion` and `Matrix` products disagree about operand order.** The same expression —
  `inverse(localBasis) * inverse(handRotation) * desiredWorld` — mounted the rifle perfectly as three
  quaternion `multiply` calls and pointed it straight up when composed as matrices. All twelve
  plausible orderings were measured in-engine and the winner is the one in the code.
- **`Matrix.invert()` mutates its operand**; `Matrix.Invert(m)` returns a new matrix. Mixing them up
  silently corrupts the matrix in `A.invert().multiply(B)`.
- **Align attachments after the skeleton, not during gameplay.** Solving the rifle mount inside the
  normal update reads a hand matrix from the previous frame's pose, which is invisible when standing
  still and up to 20° of error while running. It is now recomputed from
  `onAfterAnimationsObservable`.
- **The camera orbit centre was 1.6 m above the character's head.** The camera adds a fixed 1.55 m to
  its target's position, which was correct when that position was the feet; it is now the eye point,
  so the offset double-counted and the pivot sat at 3.43 m. Measured, that left the character 33° off
  the view axis at hip and entirely outside the frustum while aiming. With the pivot at head height
  and a 0.34 m aiming shoulder offset, the character stays framed in both.

## Roadmap

The vertical slice is single-player, as scoped. Natural next steps, in order: AI targets using the
`Dying`/`KnockedOut` clips (the health metadata path is already wired), then networked play via
Colyseus or a WebSocket tick server — for which the character controller would move server-side.

One known gap: the pack has no dedicated aim-down-sights pose (the clip list jumps from `RifleIdle`
to `FireRifle`), so aiming keeps the low-ready arm pose while the camera zooms. The barrel is
verified to point exactly along the character's forward in every state; a raised-sights pose would
need either a new clip or a procedural arm adjustment.

## Credits

Assets: [crass](https://github.com/abdullaharafinrahat/crass) `optimized_assets` (originally Mixamo
rigs and clips). Engine: [Babylon.js](https://babylonjs.com) + [Havok](https://www.havok.com/).
