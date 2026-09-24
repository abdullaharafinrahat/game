/**
 * Boot + game loop.
 *
 * Order matters here: engine -> quality tier -> Havok -> assets -> level ->
 * player. Everything that can fail (no WebGL2, no WASM, missing assets) fails
 * loudly in the loading screen instead of leaving a black canvas.
 */
import './styles.css';
// Registers Babylon scene components that are otherwise only pulled in
// implicitly. Must come before any Babylon class is constructed.
import './core/babylonSideEffects';

import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { CharacterSupportedState } from '@babylonjs/core/Physics/v2/characterController';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import { Ray } from '@babylonjs/core/Culling/ray';
import HavokPhysics from '@babylonjs/havok';
// Vite turns the plugin's .wasm into a real URL we can hand to the loader.
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';

import { AssetLibrary } from './core/Assets';
import { GameAudio } from './core/Audio';
import { createEnvironment, type Environment } from './core/Environment';
import { detectProfile, nextTier, type DeviceProfile, type QualityTier } from './core/Quality';
import { ThirdPersonCamera } from './core/ThirdPersonCamera';
import { Player } from './entities/Player';
import { InputManager } from './input/InputManager';
import { TouchControls } from './input/TouchControls';
import { Hud } from './ui/Hud';
import { buildLevel, type LevelHandle } from './world/Level';
import { GAME, PLAYER, QUALITY, WEAPON } from './config';
import type { QualitySettings } from './config';

class Game {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly audio = new GameAudio();
  readonly library = new AssetLibrary();
  readonly hud: Hud;
  readonly input: InputManager;
  readonly camera: ThirdPersonCamera;
  readonly touch: TouchControls;

  profile: DeviceProfile;
  quality: QualitySettings;
  tier: QualityTier;
  environment: Environment | null = null;
  level: LevelHandle | null = null;
  player: Player | null = null;

  paused = true;
  started = false;
  sensitivity = 1;
  private debugVisible = false;
  private frameSamples: number[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, this.antialiasRequested(), {
      preserveDrawingBuffer: false,
      stencil: false,
      doNotHandleContextLost: false,
      powerPreference: 'high-performance',
      adaptToDeviceRatio: true,
    });
    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;

    this.profile = detectProfile(this.engine);
    this.tier = this.profile.tier;
    this.quality = QUALITY[this.tier];
    this.engine.setHardwareScalingLevel(this.quality.hardwareScaling);

    this.hud = new Hud({
      onPlay: () => this.start(),
      onResume: () => this.resume(),
      onQuality: (tier) => this.applyQuality(tier),
      onSensitivity: (value) => {
        this.sensitivity = value;
        this.camera.sensitivityScale = value;
      },
      onVolume: (value) => this.audio.setVolume(value),
      onInvertY: (value) => {
        this.camera.invertY = value;
      },
      onDebugToggle: (value) => this.setDebug(value),
    });

    this.input = new InputManager(canvas, {
      onTogglePause: () => (this.paused ? this.resume() : this.pause()),
      onCycleQuality: (delta) => this.applyQuality(nextTier(this.tier, delta)),
      onZoom: (delta) => this.camera.setZoom(delta),
      onPointerLockChange: (locked) => {
        if (!locked && this.started && !this.paused) this.pause();
      },
    });

    this.camera = new ThirdPersonCamera(this.scene);
    this.touch = new TouchControls(document.body, this.input);

    window.addEventListener('resize', () => this.engine.resize());
    window.addEventListener('keydown', (ev) => {
      if (ev.code === 'F3') {
        ev.preventDefault();
        this.setDebug(!this.debugVisible);
      }
    });
  }

  /** MSAA is the first thing to go on weak GPUs. */
  private antialiasRequested(): boolean {
    const cores = navigator.hardwareConcurrency ?? 4;
    const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
    return !mobile && cores >= 6;
  }

  async boot(): Promise<void> {
    this.hud.setLoading(0.04, 'Starting engine…', '');
    this.hud.setSensitivity(this.sensitivity);
    this.hud.setQuality(this.tier);

    // --- Physics ----------------------------------------------------------
    this.hud.setLoading(0.08, 'Loading Havok physics…', 'WebAssembly, no SIMD required');
    const havok = await HavokPhysics({ locateFile: () => havokWasmUrl });
    this.scene.enablePhysics(new Vector3(0, GAME.gravity, 0), new HavokPlugin(false, havok));

    // --- World scaffolding ------------------------------------------------
    this.environment = createEnvironment(this.scene, this.quality);
    this.hud.setLoading(0.14, 'Loading assets…', 'character, level and 27 animation clips');

    const { library, hud } = this;
    await library.loadAll(this.scene, (progress) => {
      hud.setLoading(0.14 + progress.ratio * 0.8, progress.label, `${(progress.loaded / 1e6).toFixed(1)} / ${(progress.total / 1e6).toFixed(1)} MB`);
    });

    if (library.warnings.length) console.warn('[assets] retarget warnings:', library.warnings);
    console.info(
      `[assets] ${library.clips.size} clips bound, ${library.reports.reduce((a, r) => a + r.channels, 0)} channels, ` +
        `character ${library.character.height.toFixed(2)} m`,
    );

    // --- Level ------------------------------------------------------------
    this.level = buildLevel(this.scene, library, this.environment, this.audio, {
      onExplosion: (point, radius) => this.onExplosion(point, radius),
    });

    // --- Player -----------------------------------------------------------
    this.player = new Player(
      this.scene,
      library,
      this.camera,
      this.audio,
      {
        onDamage: (_amount, health) => {
          this.hud.setHealth(health, PLAYER.maxHealth);
          this.hud.damageFlash();
        },
        onDeath: () => this.hud.toast('You are down — respawning'),
        onRespawn: () => {
          this.hud.setHealth(PLAYER.maxHealth, PLAYER.maxHealth);
          this.hud.toast('Respawned');
        },
        onFootstep: () => undefined,
        onLanding: () => undefined,
        weapon: {
          onAmmo: (mag, reserve) => this.hud.setAmmo(mag, reserve),
          onHit: (damage) => this.hud.hitMarker(damage > 0),
          onBloom: (amount) => this.hud.addBloom(amount),
          onReload: (duration) => {
            this.hud.setReloading(true);
            window.setTimeout(() => this.hud.setReloading(false), duration * 1000);
          },
          onExplosive: (mesh) => this.level?.explode(mesh),
        },
      },
      this.level.spawnPoint,
      () => this.quality,
    );

    // The player has to be a shadow caster or they float on the ground with no
    // contact shadow — the single biggest read of "is this grounded?".
    this.environment?.addShadowCaster(library.character.meshes);
    if (this.player.weapon.modelMesh) this.environment?.addShadowCaster(this.player.weapon.modelMesh);

    // Camera starts behind the player looking at the level centre. The player
    // has to be turned to match, or the free-orbit idle (standing still he keeps
    // his heading) leaves the opening shot staring at his face.
    this.camera.yaw = Math.PI;
    this.camera.pitch = -0.12;
    this.player.setFacing(this.camera.yaw);
    this.camera.sensitivityScale = this.sensitivity;
    this.hud.setHealth(PLAYER.maxHealth, PLAYER.maxHealth);
    this.hud.setAmmo(WEAPON.magSize, WEAPON.reserveAmmo);

    // --- Ready ------------------------------------------------------------
    const triangles = library.manifest.character.tris + library.manifest.props.reduce((a, p) => a + p.tris, 0);
    const megabytes = (library.manifest.character.bytes + library.manifest.props.reduce((a, p) => a + p.bytes, 0) + library.manifest.clips.reduce((a, c) => a + c.bytes, 0)) / 1e6;

    this.hud.setLoading(1, 'Ready', `${library.clips.size} clips · ${triangles.toLocaleString()} triangles · ${megabytes.toFixed(1)} MB`);
    this.hud.hideLoading();
    this.hud.showStart({
      tier: this.tier,
      mobile: this.isTouch(),
      cores: this.profile.cores,
      renderer: this.profile.renderer,
      triangles,
      clips: library.clips.size,
      megabytes,
    });
    if (this.isTouch()) this.touch.setVisible(true);

    this.input.attach();
    this.engine.runRenderLoop(() => this.frame());
    (window as unknown as { __game: Game }).__game = this;

    if (import.meta.env.DEV) await this.exposeDevTools();
  }

  /**
   * Dev-only measurement helpers. Guessing physics offsets by eye is how you
   * end up with a character standing ankle-deep in the road, so these measure
   * the real numbers: where the capsule actually rests, and where the weapon
   * mesh actually ends up in hand space.
   */
  private async exposeDevTools(): Promise<void> {
    const [{ MeshBuilder }, { StandardMaterial }, { Color3 }, { PhysicsAggregate }, { PhysicsShapeType }, { PhysicsCharacterController }] =
      await Promise.all([
        import('@babylonjs/core/Meshes/meshBuilder'),
        import('@babylonjs/core/Materials/standardMaterial'),
        import('@babylonjs/core/Maths/math.color'),
        import('@babylonjs/core/Physics/v2/physicsAggregate'),
        import('@babylonjs/core/Physics/v2/IPhysicsEnginePlugin'),
        import('@babylonjs/core/Physics/v2/characterController'),
      ]);

    const self = this;
    const api = {
      /** Resting height of a capsule above a known-flat surface. */
      async measureCapsuleRest(shape: 'box' | 'mesh' = 'box') {
        const y0 = 400;
        const ground = MeshBuilder.CreateBox('__testGround', { width: 60, height: 2, depth: 60 }, self.scene);
        ground.position.set(0, y0 - 1, 0);
        const material = new StandardMaterial('__testMat', self.scene);
        material.diffuseColor = new Color3(0.3, 0.3, 0.3);
        ground.material = material;

        const plane = shape === 'mesh' ? MeshBuilder.CreateGround('__testPlane', { width: 60, height: 60 }, self.scene) : ground;
        if (shape === 'mesh') plane.position.set(0, y0, 0);
        const aggregate = new PhysicsAggregate(plane, shape === 'mesh' ? PhysicsShapeType.MESH : PhysicsShapeType.BOX, { mass: 0 }, self.scene);

        const controller = new PhysicsCharacterController(
          new Vector3(0, y0 + 3, 0),
          { capsuleHeight: PLAYER.capsuleHeight, capsuleRadius: PLAYER.capsuleRadius },
          self.scene,
        );
        for (let i = 0; i < 240; i++) {
          controller.setVelocity(new Vector3(0, -6, 0));
          controller.moveWithCollisions(new Vector3(0, (-6 * 1) / 60, 0));
          const support = controller.checkSupport(1 / 60, new Vector3(0, -1, 0));
          if (support?.supportedState === CharacterSupportedState.SUPPORTED) break;
        }
        const resting = controller.getPosition().clone();
        const result = {
          shape,
          restingY: +resting.y.toFixed(3),
          surfaceY: y0,
          centerAboveSurface: +(resting.y - y0).toFixed(3),
          capsuleHeight: PLAYER.capsuleHeight,
          capsuleRadius: PLAYER.capsuleRadius,
          assumedHalf: PLAYER.capsuleHeight / 2 + PLAYER.capsuleRadius,
        };
        controller.dispose();
        aggregate.dispose();
        plane.dispose();
        if (plane !== ground) ground.dispose();
        return result;
      },

      /**
       * Every pickable surface along a vertical column, so we can see which one
       * the character is actually standing on versus which one a probe ray hits.
       */
      probeColumn(x?: number, z?: number): unknown {
        const player = self.player;
        const px = x ?? player?.position.x ?? 0;
        const pz = z ?? player?.position.z ?? 0;
        const from = new Vector3(px, 600, pz);
        const hits = self.scene.multiPickWithRay(new Ray(from, new Vector3(0, -1, 0), 1200), (m) => m.isPickable && m.isEnabled());
        const capsuleCentre = player?.position.y ?? 0;
        return {
          x: +px.toFixed(2),
          z: +pz.toFixed(2),
          capsuleCentreY: +capsuleCentre.toFixed(3),
          capsuleBottomY: +(capsuleCentre - PLAYER.capsuleHeight / 2).toFixed(3),
          surfaces: (hits ?? []).map((h) => ({
            name: h.pickedMesh?.name,
            y: h.pickedPoint ? +h.pickedPoint.y.toFixed(3) : null,
            dist: +h.distance.toFixed(2),
          })),
        };
      },

      /**
       * Samples the rifle alignment on every rendered frame and stores the
       * results on `window.__alignmentLog`. Sampling inside the render loop
       * matters: reading matrices from outside can see a hand matrix from a
       * different pose than the pivot's world matrix, which produces phantom
       * pose-dependent errors.
       */
      logAlignment(frames = 60): number {
        const log: unknown[] = [];
        (window as unknown as { __alignmentLog: unknown[] }).__alignmentLog = log;
        const observer = self.scene.onAfterRenderObservable.add(() => {
          const pivot = self.scene.getTransformNodeByName('weaponPivot');
          const mesh = self.player?.weapon.modelMesh;
          const root = self.player?.root;
          const hand = self.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name))?.getTransformNode();
          if (!pivot || !mesh || !root) return;
          const barrel = Vector3.TransformNormal(new Vector3(-1, 0, 0), pivot.getWorldMatrix()).normalize();
          const forward = root.forward.clone();
          forward.y = 0;
          forward.normalize();
          const handScale = new Vector3();
          const handRot = new Quaternion();
          hand?.getWorldMatrix().decompose(handScale, handRot);
          log.push({
            dot: +(barrel.x * forward.x + barrel.z * forward.z).toFixed(3),
            facingYaw: +root.rotation.y.toFixed(3),
            barrel: barrel.asArray().map((v) => +v.toFixed(3)),
            forward: forward.asArray().map((v) => +v.toFixed(3)),
            pivotQuat: pivot.rotationQuaternion?.asArray().map((v) => +v.toFixed(3)) ?? null,
            handQuat: handRot.asArray().map((v) => +v.toFixed(3)),
            handPos: hand?.getAbsolutePosition().asArray().map((v) => +v.toFixed(2)) ?? null,
            parent: pivot.parent?.name ?? null,
          });
          if (log.length >= frames) self.scene.onAfterRenderObservable.remove(observer);
        });
        return frames;
      },

      /** Where each of the rifle mesh's local axes points in world space. */
      probeWeaponAxes(): unknown {
        const player = self.player;
        const mesh = player?.weapon.modelMesh ?? null;
        const hand = self.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name))?.getTransformNode();
        const pivot = self.scene.getTransformNodeByName('weaponPivot');
        if (!mesh || !hand || !pivot) return { error: 'missing pieces' };
        mesh.computeWorldMatrix(true);
        hand.computeWorldMatrix(true);
        pivot.computeWorldMatrix(true);
        const axis = (v: Vector3, m: Matrix) =>
          Vector3.TransformNormal(v, m).normalize().asArray().map((n) => +n.toFixed(3));
        const meshWorld = mesh.getWorldMatrix();
        const pivotWorld = pivot.getWorldMatrix();
        const handWorld = hand.getWorldMatrix();
        const meshLocalScale = new Vector3();
        const meshLocalRot = new Quaternion();
        const meshLocalPos = new Vector3();
        meshWorld.decompose(meshLocalScale, meshLocalRot, meshLocalPos);
        return {
          meshLocalRotationIsIdentity: Math.abs(meshLocalRot.w) > 0.9999,
          meshLocalRotation: meshLocalRot.asArray().map((v) => +v.toFixed(3)),
          meshLocalScaling: meshLocalScale.asArray().map((v) => +v.toFixed(4)),
          geometryLocalRot: mesh.rotationQuaternion ? mesh.rotationQuaternion.asArray().map((v) => +v.toFixed(3)) : mesh.rotation.asArray().map((v) => +v.toFixed(3)),
          pivotLocalRot: pivot.rotationQuaternion ? pivot.rotationQuaternion.asArray().map((v) => +v.toFixed(3)) : null,
          worldMeshX: axis(new Vector3(1, 0, 0), meshWorld),
          worldMeshY: axis(new Vector3(0, 1, 0), meshWorld),
          worldMeshZ: axis(new Vector3(0, 0, 1), meshWorld),
          worldPivotX: axis(new Vector3(1, 0, 0), pivotWorld),
          worldPivotY: axis(new Vector3(0, 1, 0), pivotWorld),
          worldPivotZ: axis(new Vector3(0, 0, 1), pivotWorld),
          charFacing: Vector3.TransformNormal(new Vector3(0, 0, -1), self.library.character.root.getWorldMatrix()).normalize().asArray().map((v) => +v.toFixed(3)),
          crossXY: Vector3.Cross(new Vector3(1, 0, 0), new Vector3(0, 1, 0)).asArray().map((v) => +v.toFixed(3)),
          handWorldX: axis(new Vector3(1, 0, 0), handWorld),
        };
      },

      /** Where the weapon mesh and muzzle actually land, relative to the hand. */
      probeWeapon(): Record<string, unknown> {
        const player = self.player;
        const sniper = self.scene.meshes.find((m) => m.name === 'Cube' || /sniper/i.test(m.name));
        const hand = self.library.character.skeleton.bones.find((b) => /RightHand$/i.test(b.name))?.getTransformNode();
        if (!sniper || !hand) return { error: 'no weapon or hand' };
        sniper.computeWorldMatrix(true);
        const box = sniper.getBoundingInfo().boundingBox;
        const worldMin = box.minimumWorld;
        const worldMax = box.maximumWorld;
        const handPos = hand.getAbsolutePosition();
        const playerPos = player?.position ?? handPos;
        return {
          sniperWorldMin: worldMin.asArray().map((v) => +v.toFixed(2)),
          sniperWorldMax: worldMax.asArray().map((v) => +v.toFixed(2)),
          sniperSize: worldMax.subtract(worldMin).asArray().map((v) => +v.toFixed(2)),
          handWorld: handPos.asArray().map((v) => +v.toFixed(2)),
          // Distance from the hand to the rifle body: should be roughly 0.
          handToRifleCentre: +Vector3.Distance(handPos, worldMin.add(worldMax).scale(0.5)).toFixed(2),
          playerFeetY: +(playerPos.y + (player?.feetOffset ?? 0)).toFixed(2),
          playerPosY: +playerPos.y.toFixed(2),
        };
      },
    };
    (window as unknown as { __dev: typeof api }).__dev = api;
  }

  /** Ground height under a world position (used by tooling + debug overlay). */
  probeGround(x: number, z: number): number | null {
    const pick = this.scene.pickWithRay(new Ray(new Vector3(x, 900, z), Vector3.Down(), 1400), (m) => m.isPickable && m.isEnabled());
    return pick?.hit && pick.pickedPoint ? pick.pickedPoint.y : null;
  }

  /** Numbers the debug overlay and the automated checks both read. */
  debugInfo(): Record<string, number | string | boolean | null> {
    const player = this.player;
    const position = player?.position ?? new Vector3();
    const ground = this.probeGround(position.x, position.z);
    const feet = player ? position.y + player.feetOffset : 0;
    return {
      fps: +this.engine.getFps().toFixed(1),
      tier: this.tier,
      activeMeshes: this.scene.getActiveMeshes().length,
      totalMeshes: this.scene.meshes.length,
      position: position.asArray().map((v) => +v.toFixed(2)).join(', '),
      feetY: +feet.toFixed(3),
      visualRootY: +(player?.root.position.y ?? 0).toFixed(3),
      groundY: ground === null ? null : +ground.toFixed(3),
      feetAboveGround: ground === null ? null : +(feet - ground).toFixed(3),
      grounded: player?.grounded ?? null,
      speed: +(player?.speed ?? 0).toFixed(2),
      clip: player?.animation.currentOverride ?? 'locomotion',
      clipsBound: this.library.clips.size,
      characterHeight: +this.library.character.height.toFixed(3),
      modelFeetOffset: +(this.library.character.feetOffset ?? 0).toFixed(3),
    };
  }

  private isTouch(): boolean {
    return this.profile.mobile || window.matchMedia?.('(pointer: coarse)').matches === true;
  }

  start(): void {
    this.audio.resume();
    this.hud.hideStart();
    this.started = true;
    this.paused = false;
    this.hud.setPaused(false);
    if (this.isTouch()) this.touch.setVisible(true);
    else this.input.requestPointerLock();
  }

  pause(): void {
    if (!this.started) return;
    this.paused = true;
    this.hud.setPaused(true);
    this.hud.setPauseStats(
      `${this.engine.getFps().toFixed(0)} fps · ${this.tier} tier · ${this.scene.getActiveMeshes().length} meshes · ` +
        `${this.library.clips.size} clips · ${this.player ? this.player.position.asArray().map((v) => v.toFixed(1)).join(', ') : '-'}`,
    );
    this.input.exitPointerLock();
  }

  resume(): void {
    if (!this.started) {
      this.start();
      return;
    }
    this.paused = false;
    this.hud.setPaused(false);
    this.audio.resume();
    if (!this.isTouch()) this.input.requestPointerLock();
  }

  applyQuality(tier: QualityTier): void {
    this.tier = tier;
    this.quality = QUALITY[tier];
    this.engine.setHardwareScalingLevel(this.quality.hardwareScaling);
    this.hud.setQuality(tier);

    if (this.environment) {
      this.environment.sun.shadowEnabled = this.quality.shadows;
      const shadowMap = this.environment.shadowGenerator?.getShadowMap();
      if (shadowMap) shadowMap.refreshRate = this.quality.shadows ? 1 : 0;
    }
    this.scene.fogDensity = 2.2 / this.quality.maxDistance;
    for (const texture of this.scene.textures) {
      texture.anisotropicFilteringLevel = this.quality.anisotropy;
    }
    this.hud.toast(`Quality: ${tier.toUpperCase()}`, 1200);
  }

  private setDebug(visible: boolean): void {
    this.debugVisible = visible;
    this.hud.setDebugCheckbox(visible);
    if (!visible) this.hud.setDebug(null);
  }

  private onExplosion(point: Vector3, radius: number): void {
    const player = this.player;
    if (!player || !player.alive) return;
    const distance = Vector3.Distance(point, player.position);
    if (distance < radius) {
      // Falls off linearly; a barrel at your feet is fatal, one across the
      // street just stings.
      player.damage(Math.round(90 * (1 - distance / radius)));
      this.hud.addBloom(20);
    }
  }

  private frame(): void {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    const state = this.input.poll();
    const aiming = state.aim;

    if (!this.paused && this.started && this.player) {
      this.camera.update(
        dt,
        {
          position: this.player.eyePoint,
          sprint: this.player.sprinting,
          grounded: this.player.grounded,
          ignore: [...this.library.character.meshes, ...(this.player.weapon.modelMesh ? [this.player.weapon.modelMesh] : [])],
        },
        this.input.consumeLook(),
        aiming,
      );
      this.player.update(dt, this.input, aiming);
      this.environment?.updateShadowFocus(this.player.position);
      this.hud.setSpeed(this.player.speed);
      this.hud.setStance(`${this.player.stance.toUpperCase()}${this.player.crouching ? ' · CROUCH' : ''}${aiming ? ' · ADS' : ''}`);
    } else {
      // Keep the camera live even while paused so the framing stays correct.
      this.camera.update(dt, { position: this.player?.eyePoint ?? new Vector3() }, { x: 0, y: 0 }, false);
    }

    this.hud.update(dt, (this.player?.speed ?? 0) > 1.2);
    this.sampleFps(dt);
    if (this.debugVisible) this.renderDebug();

    this.scene.render();
    this.input.endFrame();
  }

  private sampleFps(dt: number): void {
    this.frameSamples.push(1 / Math.max(0.0001, dt));
    if (this.frameSamples.length > 30) this.frameSamples.shift();
    if (this.debugVisible) {
      const average = this.frameSamples.reduce((a, b) => a + b, 0) / this.frameSamples.length;
      this.hud.setFps(average);
    } else {
      this.hud.setFps(this.engine.getFps());
    }
  }

  private renderDebug(): void {
    const player = this.player;
    const retarget = this.library.reports;
    const matched = retarget.reduce((a, r) => a + r.channels, 0);
    const dropped = retarget.reduce((a, r) => a + r.dropped.length, 0);
    const lines = [
      `fps        ${(this.frameSamples.reduce((a, b) => a + b, 0) / Math.max(1, this.frameSamples.length)).toFixed(0)}`,
      `tier       ${this.tier} (scaling ${this.quality.hardwareScaling}, shadows ${this.quality.shadows ? 'on' : 'off'})`,
      `meshes     ${this.scene.getActiveMeshes().length} active / ${this.scene.meshes.length} total`,
      `position   ${player ? player.position.asArray().map((v) => v.toFixed(1)).join(', ') : '-'}`,
      `speed      ${player ? player.speed.toFixed(2) : '-'} m/s  grounded ${player?.grounded}`,
      `stance     ${player?.stance}  crouch ${player?.crouching}`,
      `anim       ${player?.animation.currentOverride ?? 'locomotion'}`,
      `health     ${player?.health ?? '-'}`,
      `clips      ${this.library.clips.size} bound, ${matched} channels, ${dropped} unmatched`,
      `character  ${this.library.character.height.toFixed(2)} m, feet ${this.library.character.feetOffset.toFixed(3)}`,
      `camera     yaw ${this.camera.yaw.toFixed(2)} pitch ${this.camera.pitch.toFixed(2)} aim ${this.camera.aimBlend.toFixed(2)}`,
      `ground     feet ${(this.probeGround(player?.position.x ?? 0, player?.position.z ?? 0) ?? 0).toFixed(2)} vs model ${(this.library.character.feetOffset + (player?.root.position.y ?? 0)).toFixed(2)}`,
    ];
    this.hud.setDebug(lines.join('\n'));
  }
}

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
const game = new Game(canvas);

game.boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  game.hud.showError(`${message}\n\nIf assets are missing, run \`npm run assets\` (it pulls the pack from the crass repo and optimizes it).`);
});

export {};
