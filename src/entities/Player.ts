/**
 * The player: Havok character controller + animation state machine.
 *
 * Movement is data-driven from the pack itself: it ships both an unarmed set
 * (Idle/Walk/Run/Sprint) and a rifle-carrying set (RifleIdle/RifleWalk/
 * RifleRun), so switching stance just swaps the clip set and the blend logic
 * stays identical.
 */
import { CharacterSupportedState, PhysicsCharacterController } from '@babylonjs/core/Physics/v2/characterController';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';

import { AnimationController } from './AnimationController';
import { Weapon, type WeaponEvents } from './Weapon';
import type { AssetLibrary } from '../core/Assets';
import type { GameAudio } from '../core/Audio';
import type { ThirdPersonCamera } from '../core/ThirdPersonCamera';
import type { InputManager } from '../input/InputManager';
import { CLIP_STRIDE, GAME, MOVE, PLAYER, TURN, type QualitySettings } from '../config';

export type Stance = 'unarmed' | 'rifle';

const LOCOMOTION_SETS: Record<Stance, { idle: string; walk: string; run: string; sprint: string; jump: string }> = {
  unarmed: { idle: 'Idle', walk: 'Walk', run: 'Run', sprint: 'Sprint', jump: 'Jump' },
  rifle: { idle: 'RifleIdle', walk: 'RifleWalk', run: 'RifleRun', sprint: 'RifleRun', jump: 'RifleJump' },
};

export interface PlayerEvents {
  onDamage(amount: number, health: number): void;
  onDeath(): void;
  onRespawn(): void;
  onFootstep(sprinting: boolean): void;
  onLanding(speed: number): void;
  /** Weapon feedback (ammo, hitmarkers, muzzle bloom, explosions). */
  weapon: WeaponEvents;
}

export class Player {
  readonly root = new TransformNode('playerRoot');
  readonly controller: PhysicsCharacterController;
  readonly weapon: Weapon;
  readonly animation: AnimationController;

  velocity = new Vector3(0, 0, 0);
  stance: Stance = 'rifle';
  grounded = true;
  crouching = false;
  alive = true;
  health: number = PLAYER.maxHealth;
  speed = 0;
  respawnPoint = new Vector3(0, 0, 0);
  /** Positive values mean the body is falling (for landing effects). */
  lastFallSpeed = 0;

  private facingAngle = 0;
  /** Counts down after a shot, holding his facing on the camera while it fires. */
  private aimFacingHold = 0;
  /** Vertical correction so the model's feet rest on the capsule base. */
  private readonly modelLift: number;
  private stepDistance = 0;
  private coyote = 0;
  private jumpBuffer = 0;
  private respawnTimer = 0;

  constructor(
    scene: Scene,
    private readonly library: AssetLibrary,
    private readonly camera: ThirdPersonCamera,
    private readonly audio: GameAudio,
    private readonly events: PlayerEvents,
    spawn: Vector3,
    quality: () => QualitySettings,
  ) {
    // Park the whole loaded hierarchy under one node so a single transform
    // drives the character. The model is lifted by its measured foot offset so
    // the toes sit exactly on the capsule base (verified against mesh bounds,
    // not a magic number).
    library.character.root.parent = this.root;
    this.modelLift = -library.character.feetOffset;

    // Spawn slightly above the ground; physics settles the capsule on frame 1.
    const start = spawn.clone();
    start.y += PLAYER.capsuleHeight / 2 + PLAYER.capsuleRadius + 0.05;
    this.controller = new PhysicsCharacterController(
      start,
      { capsuleHeight: PLAYER.capsuleHeight, capsuleRadius: PLAYER.capsuleRadius },
      scene,
    );
    this.controller.maxSlopeCosine = MOVE.maxSlopeCosine;
    this.controller.up = Vector3.Up();
    this.controller.characterMass = 82;
    this.controller.characterStrength = 1;
    this.controller.staticFriction = 0.6;
    this.controller.dynamicFriction = 0.4;
    this.controller.maxCastIterations = 8;

    this.animation = new AnimationController(library);
    this.weapon = new Weapon(scene, camera, audio, events.weapon, quality);
    this.weapon.attach(library, library.character);
    // `this.root` is the node whose rotation.y *is* the facing direction, so it
    // is the correct reference frame for the rifle's alignment.
    this.weapon.setFacingNode(this.root);
    this.respawnPoint.copyFrom(spawn);
    this.syncVisual();
  }

  /**
   * Distance from the capsule centre down to the feet.
   *
   * Babylon builds the shape as two spheres of `radius` centred at
   * (0, +-h/2 -+ r, 0), so `capsuleHeight` is the shape's TOTAL height — the
   * bottom sits exactly h/2 below the centre, not h/2 + r. On top of that the
   * controller keeps `keepDistance` (0.05 by default) of clearance above the
   * surface, which is where the feet should be drawn. Measured in isolation:
   * a 1.1 m capsule rests with its centre 0.60 m above flat ground.
   */
  get feetOffset(): number {
    return -(PLAYER.capsuleHeight / 2 + this.controller.keepDistance);
  }

  get position(): Vector3 {
    return this.controller.getPosition();
  }

  get eyePoint(): Vector3 {
    const p = this.position.clone();
    p.y += PLAYER.eyeHeight + this.feetOffset;
    return p;
  }

  update(dt: number, input: InputManager, aiming: boolean): void {
    const state = input.state;

    if (!this.alive) {
      this.respawnTimer -= dt;
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.velocity.y += GAME.gravity * dt;
      this.integrate(dt);
      this.animation.update(dt);
      this.weapon.update(dt, input, this.animation);
      this.syncVisual();
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }

    // --- Desired horizontal velocity, relative to where the camera looks ---
    const forward = this.camera.facing;
    const right = new Vector3(forward.z, 0, -forward.x);
    const wish = forward.scale(state.moveY).addInPlace(right.scale(state.moveX));
    const wishLength = wish.length();
    if (wishLength > 1e-4) wish.scaleInPlace(1 / wishLength);

    const wantsSprint = state.sprint && !aiming && !state.crouch && state.moveY > 0.4;
    const maxSpeed = state.crouch ? MOVE.crouch : aiming ? MOVE.aim : wantsSprint ? MOVE.sprint : MOVE.run;
    const desiredSpeed = maxSpeed * Math.min(1, wishLength);
    const desired = wish.scale(desiredSpeed);

    const accel = this.grounded ? (desiredSpeed > 1e-3 ? MOVE.accel : MOVE.brake) : MOVE.accel * MOVE.airControl;
    const blend = Math.min(1, accel * dt);
    this.velocity.x += (desired.x - this.velocity.x) * blend;
    this.velocity.z += (desired.z - this.velocity.z) * blend;

    // --- Jump: coyote time + buffered input -------------------------------
    if (state.jumpPressed) this.jumpBuffer = MOVE.jumpBuffer;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? MOVE.coyoteTime : Math.max(0, this.coyote - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0 && this.grounded) {
      this.velocity.y = MOVE.jumpSpeed;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.playAction(LOCOMOTION_SETS[this.stance].jump, 0.7, true);
    }

    // --- Crouch: the pack has no crouch loop, so the transitions are used as
    // a flourish while movement simply slows down.
    if (state.crouch !== this.crouching) {
      this.crouching = state.crouch;
      if (this.crouching) this.animation.play('ProneToKneel', { maxDuration: 0.85, fadeOut: 0.3 });
      else this.animation.play('KneelToStand', { maxDuration: 0.7, fadeOut: 0.3 });
    }

    // --- Gravity + integration --------------------------------------------
    this.velocity.y += GAME.gravity * dt;
    this.velocity.y = Math.max(this.velocity.y, -55);

    const wasGrounded = this.grounded;
    this.lastFallSpeed = this.velocity.y;
    this.integrate(dt);
    if (!wasGrounded && this.grounded && this.lastFallSpeed < -9) {
      this.audio.footstep(false);
      this.events.onLanding(Math.abs(this.lastFallSpeed));
      this.camera.addRecoil(0, 0, Math.min(0.16, Math.abs(this.lastFallSpeed) * 0.01));
    }

    if (this.position.y < -40) this.kill('fall');

    this.weapon.update(dt, input, this.animation);
    this.updateAnimation(aiming, state.moveY, state.firePressed, dt);
    this.animation.update(dt);
    this.updateFootsteps(dt, wantsSprint);
    this.syncVisual();
  }

  damage(amount: number): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.events.onDamage(amount, this.health);
    this.camera.addRecoil(0, 0, 0.06 + amount * 0.001);
    if (this.health <= 0) this.kill('damage');
  }

  kill(cause: 'damage' | 'fall'): void {
    if (!this.alive) return;
    this.alive = false;
    this.velocity.setAll(0);
    this.respawnTimer = 3.2;
    // Drop every locomotion layer before the death pose takes over.
    this.animation.resetTo({});
    const preferred = cause === 'fall' ? 'KnockedOut' : 'Dying';
    const clip = this.animation.has(preferred) ? preferred : 'Dying';
    if (this.animation.has(clip)) {
      this.animation.play(clip, { maxDuration: 2.6, fadeIn: 0.05, fadeOut: 0.5, holdLastFrame: true });
    }
    this.events.onDeath();
  }

  respawn(): void {
    const spawn = this.respawnPoint.clone();
    spawn.y += PLAYER.capsuleHeight / 2 + PLAYER.capsuleRadius + 0.05;
    this.controller.setPosition(spawn);
    this.velocity.setAll(0);
    this.health = PLAYER.maxHealth;
    this.alive = true;
    this.weapon.refill();
    this.animation.resetTo({});
    this.animation.update(0);
    this.events.onRespawn();
  }

  playAction(name: string, maxDuration: number, hold = false): void {
    if (!this.animation.has(name)) return;
    this.animation.play(name, { maxDuration, holdLastFrame: hold });
  }

  /** Stride speed for a clip: measured root motion wins over the tuned table. */
  strideFor(name: string): number {
    const meta = this.library.clipMeta.get(name);
    if (meta?.rootMotion && meta.duration > 0) {
      const measured = meta.rootMotionDrift / meta.duration;
      if (measured > 0.5) return measured;
    }
    return CLIP_STRIDE[name] ?? 0;
  }

  dispose(): void {
    this.weapon.dispose();
    this.animation.dispose();
    this.controller.dispose();
    this.root.dispose();
  }

  /**
   * Pins the character's heading, used when setting up a scene so the opening
   * camera framing is over-the-shoulder rather than face-on. (Standing still he
   * keeps his heading, since the camera free-orbits instead of dragging him.)
   */
  setFacing(radians: number): void {
    this.facingAngle = Player.wrapAngle(radians);
    this.syncVisual();
  }

  /** Shortest signed angle from `from` to `to`. */
  private static shortestAngle(from: number, to: number): number {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  /** Wraps an angle into (-PI, PI] so it cannot drift over many camera spins. */
  private static wrapAngle(a: number): number {
    const wrapped = a % (Math.PI * 2);
    return wrapped > Math.PI ? wrapped - Math.PI * 2 : wrapped <= -Math.PI ? wrapped + Math.PI * 2 : wrapped;
  }

  /** Turns toward `target` at a bounded rate, taking the short way round. */
  private turnTowards(target: number, rate: number, dt: number): void {
    const delta = Player.shortestAngle(this.facingAngle, target);
    const step = rate * dt;
    this.facingAngle = Player.wrapAngle(this.facingAngle + (Math.abs(delta) <= step ? delta : Math.sign(delta) * step));
  }

  private syncVisual(): void {
    const p = this.controller.getPosition();
    this.root.position.set(p.x, p.y + this.feetOffset + this.modelLift, p.z);
    this.root.rotation.y = this.facingAngle;
  }

  private integrate(dt: number): void {
    this.controller.setVelocity(this.velocity);
    this.controller.moveWithCollisions(this.velocity.scale(dt));
    const surface = this.controller.checkSupport(GAME.fixedStep, Vector3.Down());
    const supported = surface?.supportedState === CharacterSupportedState.SUPPORTED;
    this.grounded = supported;
    if (supported && this.velocity.y < 0) this.velocity.y = 0;
  }

  private updateFootsteps(dt: number, sprinting: boolean): void {
    const travelled = Math.hypot(this.velocity.x, this.velocity.z) * dt;
    if (!this.grounded) {
      this.stepDistance = 0.6;
      return;
    }
    this.stepDistance += travelled;
    const stride = sprinting ? 1.15 : 0.8;
    if (this.stepDistance >= stride) {
      this.stepDistance = 0;
      this.audio.footstep(sprinting);
      this.events.onFootstep(sprinting);
    }
  }

  /**
   * Speed-driven locomotion blend. Weights across the set always sum to ~1 so
   * the result is a real blend, not "last writer wins".
   */
  private updateAnimation(aiming: boolean, forwardInput: number, firing: boolean, dt: number): void {
    const set = LOCOMOTION_SETS[this.stance];
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // --- Facing ------------------------------------------------------------
    // The character's visual forward is his own local +Z (confirmed by rendering
    // him at rotation.y = 0: a camera on the -Z side sees his back), so the yaw
    // that points him along a direction d is atan2(d.x, d.z).
    //
    // Standing still he deliberately keeps his heading, which is what lets the
    // camera free-orbit: rotating him to match the camera every frame is
    // invisible anyway (the camera is always behind him) and it makes the whole
    // world appear to spin instead of the character turning. He turns to the
    // camera the moment you aim or fire, and follows his direction of travel
    // while moving — both rate limited so the turn is something you can see.
    this.aimFacingHold = firing ? TURN.fireHold : Math.max(0, this.aimFacingHold - dt);
    if (aiming || this.aimFacingHold > 0) {
      this.turnTowards(this.camera.yaw, TURN.aiming, dt);
    } else if (forwardInput !== 0 && this.speed > 0.2) {
      this.turnTowards(Math.atan2(this.velocity.x, this.velocity.z), TURN.moving, dt);
    }

    const walkSpeed = this.strideFor(set.walk) || MOVE.walk;
    const runSpeed = this.strideFor(set.run) || MOVE.run;
    const sprintSpeed = Math.max(this.strideFor(set.sprint) || MOVE.sprint, runSpeed + 0.6);
    const s = this.speed;

    const weights: Record<string, number> = {};
    const ratios: Record<string, number> = {};
    const add = (name: string, weight: number, ratioSpeed: number) => {
      if (weight <= 0.001 || !this.animation.has(name)) return;
      weights[name] = (weights[name] ?? 0) + weight;
      ratios[name] = ratioSpeed > 0.05 ? s / ratioSpeed : 1;
    };

    if (s <= walkSpeed) {
      const t = Math.min(1, s / Math.max(0.001, walkSpeed));
      add(set.idle, 1 - t, 1);
      add(set.walk, t, walkSpeed);
    } else if (s <= runSpeed) {
      const t = (s - walkSpeed) / Math.max(0.001, runSpeed - walkSpeed);
      add(set.walk, 1 - t, walkSpeed);
      add(set.run, t, runSpeed);
    } else {
      const t = Math.min(1, (s - runSpeed) / Math.max(0.001, sprintSpeed - runSpeed));
      add(set.run, 1 - t, runSpeed);
      add(set.sprint, t, sprintSpeed);
    }

    this.animation.setLocomotion(weights, ratios);
  }
}
