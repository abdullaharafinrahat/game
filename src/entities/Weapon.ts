/**
 * Hitscan rifle.
 *
 * Aiming is camera-centric (the classic third-person trick): the ray leaves the
 * camera through the crosshair, so what you see is what you hit, while the
 * tracer is drawn muzzle-to-impact purely for looks.
 *
 * On attach the model is *measured* — bounds centre, longest axis, real-world
 * length — and mounted on a pivot inside the hand bone. That way a differently
 * authored GLB still lands in the hand at a plausible size instead of needing
 * hand-tuned numbers.
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Ray } from '@babylonjs/core/Culling/ray';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';

import type { AssetLibrary, CharacterBinding } from '../core/Assets';
import type { GameAudio } from '../core/Audio';
import type { ThirdPersonCamera } from '../core/ThirdPersonCamera';
import type { InputManager } from '../input/InputManager';
import type { AnimationController } from './AnimationController';
import { WEAPON, type QualitySettings } from '../config';

export interface WeaponEvents {
  onAmmo(mag: number, reserve: number): void;
  onHit(damage: number): void;
  onBloom(amount: number): void;
  onReload(duration: number): void;
  /** A prop flagged `explosive` was shot — the level decides what happens. */
  onExplosive?(mesh: AbstractMesh, point: Vector3): void;
}

export interface WeaponMeta {
  health?: number;
  explosive?: boolean;
  surface?: string;
}

interface Tracer {
  mesh: LinesMesh;
  life: number;
}

/**
 * Mount tuning. The orientation is *solved*, never hardcoded: this rig's hand
 * bone inherits a rotated, 0.01-scaled armature, so a fixed Euler offset that
 * suits one rig comes out sideways on the next. The pivot's local rotation is
 * recomputed every frame from the live hand matrix (see `alignToCharacter`), so
 * the rifle stays pointing along the character's visual forward while the arm
 * animation moves underneath it.
 */
const GRIP = {
  /** Rifle length in meters after normalisation (a sniper is ~1.2 m). */
  length: 1.15,
  /** Nudge in hand space, in meters, after the orientation is solved. */
  position: new Vector3(0.03, 0.04, 0.0),
  /** How far behind the muzzle the hand grips (fraction of total length). */
  gripFromMuzzle: 0.3,
  /**
   * Extra rotation in hand space, applied after the alignment solve:
   * yaw brings the stock in toward the shoulder, roll squares the scope up.
   */
  mountTweak: new Vector3(0, 0.0, 0),
};

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const axisIndex = (axis: 'x' | 'y' | 'z'): 0 | 1 | 2 => AXIS_INDEX[axis];
const axisComponent = (v: Vector3, axis: 'x' | 'y' | 'z'): number => v[axis];

/**
 * Measures which end of the barrel axis is the muzzle by comparing how thick the
 * geometry is at each end: thin tube = muzzle, thick wedge = stock/receiver.
 * Falls back to "the end farthest from the pivot" if the mesh has no readable
 * positions.
 */
function detectMuzzleSign(mesh: Mesh, barrelAxis: 'x' | 'y' | 'z', upAxis: 'x' | 'y' | 'z'): 1 | -1 {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions || positions.length < 30) {
    const bounds = mesh.getBoundingInfo().boundingBox;
    const alongLow = axisComponent(bounds.minimum, barrelAxis);
    const alongHigh = axisComponent(bounds.maximum, barrelAxis);
    return Math.abs(alongLow) > Math.abs(alongHigh) ? -1 : 1;
  }

  const along = axisIndex(barrelAxis);
  const across = axisIndex(upAxis);
  const low = axisComponent(mesh.getBoundingInfo().boundingBox.minimum, barrelAxis);
  const high = axisComponent(mesh.getBoundingInfo().boundingBox.maximum, barrelAxis);
  const span = Math.max(high - low, 0.0001);
  const band = span * 0.12;

  let thinLow = 0;
  let thinHigh = 0;
  let countLow = 0;
  let countHigh = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const t = positions[i + along];
    const thickness = Math.abs(positions[i + across]);
    if (t <= low + band) {
      thinLow += thickness;
      countLow++;
    } else if (t >= high - band) {
      thinHigh += thickness;
      countHigh++;
    }
  }
  if (!countLow || !countHigh) return 1;
  const averageLow = thinLow / countLow;
  const averageHigh = thinHigh / countHigh;
  // Smaller average profile thickness = the muzzle.
  return averageLow < averageHigh ? -1 : 1;
}

export class Weapon {
  private model: Mesh | null = null;
  private pivot: TransformNode | null = null;
  private muzzle: TransformNode | null = null;
  /** Hand bone the rifle rides on. */
  private handNode: TransformNode | null = null;
  /**
   * The node that represents which way the character is *facing* — i.e. the one
   * gameplay sets `rotation.y` on. It must NOT be the GLB's root node: that one
   * carries its own export rotation (the Blender fix-up), so `glbRoot.forward`
   * points somewhere other than where the model actually looks. Earlier this
   * used the GLB root and the rifle ended up 180 degrees out at idle.
   */
  private facingNode: TransformNode | null = null;
  /** Rifle geometry axes, captured at attach time for the per-frame solve. */
  private mount: { barrelAxis: 'x' | 'y' | 'z'; upAxis: 'x' | 'y' | 'z'; muzzleSign: 1 | -1 } | null = null;
  private flash: Mesh | null = null;
  private flashLight: PointLight | null = null;
  private sparks: ParticleSystem | null = null;
  private sparkTexture: DynamicTexture | null = null;
  private decalTexture: DynamicTexture | null = null;
  private tracers: Tracer[] = [];
  private decals: Mesh[] = [];
  private cooldown = 0;
  private kick = 0;
  private flashTimer = 0;
  mag: number = WEAPON.magSize;
  reserve: number = WEAPON.reserveAmmo;
  reloading = false;
  private reloadTimer = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: ThirdPersonCamera,
    private readonly audio: GameAudio,
    private readonly events: WeaponEvents,
    /** Live tier lookup: the Game swaps the settings object when the tier changes. */
    private readonly quality: () => QualitySettings,
  ) {}

  /** Decal + spark budgets scale with the tier. */
  private get limits(): { decals: number; particles: number } {
    const settings = this.quality();
    return { decals: settings.decals, particles: settings.particles };
  }

  /**
   * Points the rifle along the character's visual forward axis and keeps it
   * level, for the CURRENT hand pose.
   *
   * This runs every frame rather than once at attach time. Solving it once
   * (from the rest pose) leaves a fixed offset that the arm animation then
   * carries away — measured at 10-40 degrees of drift, which is what "the gun
   * has been reversed" looked like. Re-solving per frame makes the rifle behave
   * like an attachment constraint: it stays forward and level in every clip.
   */
  /** Keeps the mount aligned after each frame's skeleton update. */
  private readonly alignObserver = (): void => {
    this.alignToCharacter();
  };

  /** Tells the weapon which node defines the character's facing direction. */
  setFacingNode(node: TransformNode): void {
    this.facingNode = node;
    this.alignToCharacter();
  }

  private alignToCharacter(): void {
    const { pivot, handNode, facingNode, mount } = this;
    if (!pivot || !handNode || !facingNode || !mount) return;

    handNode.computeWorldMatrix(true);
    facingNode.computeWorldMatrix(true);

    const handScale = new Vector3();
    const handRotation = new Quaternion();
    handNode.getWorldMatrix().decompose(handScale, handRotation);

    const axisVector = (axis: 'x' | 'y' | 'z', sign: number) =>
      new Vector3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0);
    const localBarrel = axisVector(mount.barrelAxis, mount.muzzleSign);
    const localUp = axisVector(mount.upAxis, 1);
    const localThird = Vector3.Cross(localBarrel, localUp).normalize();

    // Desired world orientation: barrel along the character's visual forward
    // (its own +Z, flattened so the rifle stays level on slopes), up to the sky.
    const forwardWorld = facingNode.forward.clone();
    forwardWorld.y = 0;
    forwardWorld.normalize();
    if (forwardWorld.lengthSquared() < 0.5) forwardWorld.set(0, 0, 1);

    // Composition order is NOT derivable from the docs (Babylon uses row-vector
    // matrices, `Matrix.multiply` mutates in place, and `Quaternion.multiply`
    // composes as "this, then argument"), so all twelve plausible orderings were
    // measured in-engine and this one alone came out with the barrel exactly
    // along forward and pitch 0.0:
    //     pivot = localBasis⁻¹ · handRotation⁻¹ · desiredWorld
    // `Matrix.Invert` (not `.invert()`) — the latter mutates its operand.
    const localBasis = Matrix.Identity();
    Matrix.FromXYZAxesToRef(localBarrel, localUp, localThird, localBasis);
    const desiredBasis = Matrix.Identity();
    Matrix.FromXYZAxesToRef(forwardWorld, Vector3.Up(), Vector3.Cross(forwardWorld, Vector3.Up()).normalize(), desiredBasis);

    // Composed with quaternions exactly as measured: Babylon's Quaternion and
    // Matrix products do NOT agree on operand order, and the matrix form of this
    // same expression pointed the rifle straight up.
    const localQuat = Quaternion.FromRotationMatrix(Matrix.Invert(localBasis))
      .multiply(Quaternion.Inverse(handRotation))
      .multiply(Quaternion.FromRotationMatrix(desiredBasis));
    if (GRIP.mountTweak.lengthSquared() > 0) {
      const tweak = Quaternion.RotationYawPitchRoll(GRIP.mountTweak.y, GRIP.mountTweak.x, GRIP.mountTweak.z);
      localQuat.multiplyInPlace(Quaternion.Inverse(tweak));
    }

    // Assign through the SETTER every frame. Writing into the existing
    // quaternion with copyFrom() mutates it without notifying the TransformNode,
    // so the cached world matrix is never recomposed and the rifle silently
    // keeps its rest-pose orientation while the arm animates under it — which is
    // exactly what "the gun has been reversed" looked like.
    pivot.rotationQuaternion = localQuat;
  }

  /** The rifle mesh, once mounted (also used by the dev measurement tools). */
  get modelMesh(): Mesh | null {
    return this.model;
  }

  /** Muzzle node in world space — tracers and the flash originate here. */
  get muzzleNode(): TransformNode | null {
    return this.muzzle;
  }

  /** Mounts the sniper on the right hand bone, normalised to a real length. */
  attach(library: AssetLibrary, character: CharacterBinding): void {
    const container = library.propContainers.get('sniper');
    if (!container) return;
    const source = container.meshes.find((m) => m.getTotalVertices() > 0) as Mesh | undefined;
    if (!source) return;

    container.addAllToScene();
    source.setParent(null);
    source.isPickable = false;
    source.receiveShadows = false;
    source.computeWorldMatrix(true);
    source.refreshBoundingInfo();

    const bounds = source.getBoundingInfo().boundingBox;
    const size = bounds.maximum.subtract(bounds.minimum);
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);

    // 1. Longest axis = the barrel. Normalise that to a real rifle length.
    const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
    const barrelAxis = axes.reduce((a, b) => (size[b] > size[a] ? b : a), 'x' as 'x' | 'y' | 'z');
    const barrelLength = size[barrelAxis] || 1;
    const scale = GRIP.length / barrelLength;

    // Which local axis is "up"? For a rifle the extents are barrel (long),
    // height with stock and scope (medium) and side-to-side width (small), so up
    // is the *larger* of the two non-barrel axes. Picking the thinnest — the
    // intuitive choice — rolls the rifle onto its side.
    const upAxis = (['x', 'y', 'z'] as const).filter((a) => a !== barrelAxis).sort((a, b) => size[b] - size[a])[0] ?? 'y';

    // 2. Which end of the barrel axis is the muzzle? Not "the far end from the
    //    pivot" — that guess puts this rifle on backwards. The reliable signal is
    //    the *profile*: a muzzle is a thin tube, a stock is a thick wedge. So the
    //    vertices are bucketed along the barrel and the two end slices are
    //    compared, with the thinner one winning.
    const muzzleSign = detectMuzzleSign(source, barrelAxis, upAxis);


    this.pivot = new TransformNode('weaponPivot', this.scene);
    const hand = character.skeleton?.bones.find((b) => /RightHand/i.test(b.name));
    const handNode = hand?.getTransformNode() ?? character.root;
    this.pivot.parent = handNode;

    // Hand space is scaled by the rig (this pack puts 0.01 on the Armature), so
    // undo it on the pivot and every offset below can be written in meters.
    handNode.computeWorldMatrix(true);
    const handScale = new Vector3();
    const handRotation = new Quaternion();
    handNode.getWorldMatrix().decompose(handScale, handRotation);
    const handUnit = Math.abs(handScale.x) > 1e-6 ? handScale.x : 1;
    this.pivot.scaling.setAll(1 / handUnit);

    this.handNode = handNode;
    this.facingNode = this.facingNode ?? character.root;
    this.mount = { barrelAxis, upAxis, muzzleSign };
    // Orient the rifle for the current pose, then keep re-solving it *after the
    // skeleton animates* each frame. Solving during the gameplay update reads a
    // hand matrix from the previous frame's pose, which leaves the rifle lagging
    // the arm by up to ~20 degrees while walking (idle looked perfect because a
    // static pose hides the lag entirely).
    this.alignToCharacter();
    this.scene.onAfterAnimationsObservable.add(this.alignObserver);

    this.pivot.position.copyFrom(GRIP.position);

    source.parent = this.pivot;
    // The exported node transform is not identity (this GLB packs a 180-degree Z
    // rotation and a mirrored Y scale), and left in place it fights the solved
    // mount. The weapon is a static mesh, so the node transform is simply reset
    // and the geometry axes become the pivot axes the solve assumed.
    source.rotationQuaternion = Quaternion.Identity();
    source.rotation.setAll(0);
    source.scaling.set(scale, scale, scale);
    // Grip the rifle GRIP.gripFromMuzzle of the way back from the muzzle, so the
    // fist lands on the trigger area instead of the middle of the barrel.
    const gripOffsetAlongBarrel = (0.5 - GRIP.gripFromMuzzle) * barrelLength;
    const shift = new Vector3(-center.x, -center.y, -center.z).scale(scale);
    shift[barrelAxis] += muzzleSign > 0 ? -gripOffsetAlongBarrel * scale : gripOffsetAlongBarrel * scale;
    source.position.copyFrom(shift);
    this.model = source;

    // 3. Muzzle sits on the barrel axis at the far end of the geometry.
    const muzzleLocal = center.clone();
    muzzleLocal[barrelAxis] = muzzleSign > 0 ? bounds.maximum[barrelAxis] : bounds.minimum[barrelAxis];
    this.muzzle = new TransformNode('muzzle', this.scene);
    this.muzzle.parent = this.pivot;
    this.muzzle.position.copyFrom(shift).addInPlace(muzzleLocal.scale(scale));

    console.info(
      `[weapon] barrel axis ${barrelAxis} (muzzle ${muzzleSign > 0 ? '+' : '-'}), up axis ${upAxis}, ` +
        `geometry ${barrelLength.toFixed(2)}u -> ${GRIP.length.toFixed(2)} m (x${scale.toFixed(3)}), hand unit ${handUnit}`,
    );

    const flashMat = new StandardMaterial('flashMat', this.scene);
    flashMat.disableLighting = true;
    flashMat.emissiveColor = new Color3(1, 0.85, 0.45);
    flashMat.alpha = 0.9;
    flashMat.backFaceCulling = false;
    this.flash = MeshBuilder.CreatePlane('muzzleFlash', { size: 0.3 }, this.scene);
    this.flash.material = flashMat;
    this.flash.parent = this.muzzle;
    this.flash.isPickable = false;
    this.flash.setEnabled(false);

    this.flashLight = new PointLight('muzzleLight', Vector3.Zero(), this.scene);
    this.flashLight.parent = this.muzzle;
    this.flashLight.intensity = 0;
    this.flashLight.range = 16;
    this.flashLight.diffuse = new Color3(1, 0.82, 0.5);

    this.buildEffects();
    this.events.onAmmo(this.mag, this.reserve);
  }

  update(dt: number, input: InputManager, animations: AnimationController): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.kick *= Math.exp(-dt * 12);
    this.flashTimer = Math.max(0, this.flashTimer - dt);

    if (this.flash) this.flash.setEnabled(this.flashTimer > 0);
    if (this.flashLight) this.flashLight.intensity = this.flashTimer > 0 ? 3 * (this.flashTimer / 0.05) : 0;
    if (this.pivot) {
      // Recoil shoves the gun back toward the shoulder, then springs home.
      this.pivot.position.set(
        GRIP.position.x + this.kick * 0.03,
        GRIP.position.y - this.kick * 0.015,
        GRIP.position.z - this.kick * 0.14,
      );
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i];
      tracer.life -= dt;
      tracer.mesh.alpha = Math.max(0, tracer.life / WEAPON.tracerLife);
      if (tracer.life <= 0) {
        tracer.mesh.dispose();
        this.tracers.splice(i, 1);
      }
    }

    const state = input.state;
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
      return;
    }

    if (state.reloadPressed) {
      this.beginReload(animations);
      return;
    }
    // Bolt-action: one shot per click. Auto-reload when the mag runs dry.
    if (state.firePressed) {
      if (this.mag > 0) this.tryFire(animations);
      else this.beginReload(animations);
    }
  }

  refill(): void {
    this.mag = WEAPON.magSize;
    this.reserve = WEAPON.reserveAmmo;
    this.reloading = false;
    this.reloadTimer = 0;
    this.events.onAmmo(this.mag, this.reserve);
  }

  private beginReload(animations: AnimationController): void {
    if (this.reloading || this.mag >= WEAPON.magSize || this.reserve <= 0) return;
    const clipLength = 3.32; // the pack's Reload clip
    const speedRatio = animations.has('Reload') ? clipLength / WEAPON.reloadTime : 1;
    this.reloading = true;
    this.reloadTimer = WEAPON.reloadTime;
    if (animations.has('Reload')) {
      animations.play('Reload', { maxDuration: WEAPON.reloadTime, speedRatio, fadeIn: 0.1, fadeOut: 0.2 });
    }
    this.audio.reload();
    this.events.onReload(WEAPON.reloadTime);
  }

  private finishReload(): void {
    const loaded = Math.min(WEAPON.magSize - this.mag, this.reserve);
    this.mag += loaded;
    this.reserve -= loaded;
    this.reloading = false;
    this.events.onAmmo(this.mag, this.reserve);
  }

  private tryFire(animations: AnimationController): void {
    if (this.cooldown > 0) return;

    this.mag--;
    this.cooldown = WEAPON.fireInterval;
    this.flashTimer = 0.05;
    this.kick = 1;
    this.audio.gunshot();
    this.camera.addRecoil(WEAPON.recoilPitch, (Math.random() - 0.5) * WEAPON.recoilYaw, 0.07);
    this.events.onAmmo(this.mag, this.reserve);
    this.events.onBloom(WEAPON.bloomPerShot);

    if (animations.has('FireRifle')) {
      // A 1 s burst clip capped to a single shot, then released.
      animations.play('FireRifle', { maxDuration: 0.34, fadeIn: 0.02, fadeOut: 0.16, speedRatio: 1.6 });
    }
    this.fireRay();
  }

  private fireRay(): void {
    const origin = this.camera.aimOrigin;
    const direction = this.camera.aimDirection;
    const pick = this.scene.pickWithRay(new Ray(origin, direction, WEAPON.range), (mesh) => mesh.isPickable && mesh.isEnabled());

    let end = origin.add(direction.scale(WEAPON.range));
    if (pick?.hit && pick.pickedPoint) {
      end = pick.pickedPoint.clone();
      this.applyHit(pick.pickedMesh as AbstractMesh | null, pick.pickedPoint, direction, pick.getNormal(true) ?? direction.scale(-1));
    }
    this.spawnTracer(this.muzzlePosition(), end);
  }

  private applyHit(mesh: AbstractMesh | null, point: Vector3, direction: Vector3, normal: Vector3): void {
    const distance = Vector3.Distance(point, this.camera.camera.globalPosition);
    const meta = (mesh?.metadata ?? {}) as WeaponMeta;
    this.audio.impact(distance, meta.surface);
    this.spawnSparks(point, normal, meta.surface === 'metal' ? 1.5 : 1);

    if (!mesh) return;
    if (this.decals.length < this.limits.decals) this.spawnDecal(point, normal);

    // Dynamic props get knocked around — that is what makes the sandbox fun.
    const body = mesh.physicsBody;
    if (body) body.applyImpulse(direction.scale(WEAPON.damage * 0.24), point);

    if (meta.explosive) {
      this.events.onExplosive?.(mesh, point);
      return;
    }
    if (typeof meta.health === 'number') {
      meta.health -= WEAPON.damage;
      this.events.onHit(WEAPON.damage);
      return;
    }
    this.events.onHit(0);
  }

  private muzzlePosition(): Vector3 {
    if (this.muzzle) return this.muzzle.getAbsolutePosition().clone();
    return this.camera.aimOrigin.add(this.camera.aimDirection.scale(0.6));
  }

  private spawnTracer(from: Vector3, to: Vector3): void {
    const delta = to.subtract(from);
    const length = delta.length();
    if (length < 0.05) return;
    const tracer = MeshBuilder.CreateLines('tracer', { points: [from, from.add(delta.scale((length - 0.05) / length))] }, this.scene);
    tracer.color = new Color3(1, 0.93, 0.7);
    tracer.alpha = 0.85;
    tracer.isPickable = false;
    this.tracers.push({ mesh: tracer, life: WEAPON.tracerLife });
  }

  private spawnDecal(point: Vector3, normal: Vector3): void {
    if (!this.decalTexture) return;
    const decal = MeshBuilder.CreatePlane('decal', { size: 0.17 }, this.scene);
    const material = new StandardMaterial('decalMat', this.scene);
    material.diffuseTexture = this.decalTexture;
    material.useAlphaFromDiffuseTexture = true;
    material.emissiveColor = new Color3(0.06, 0.06, 0.06);
    material.specularColor = Color3.Black();
    material.zOffset = -2;
    decal.material = material;
    decal.isPickable = false;
    decal.position.copyFrom(point.add(normal.scale(0.014)));
    decal.lookAt(point.add(normal));
    decal.rotation.z = Math.random() * Math.PI * 2;
    this.decals.push(decal);
    while (this.decals.length > this.limits.decals) {
      const oldest = this.decals.shift();
      oldest?.material?.dispose();
      oldest?.dispose();
    }
  }

  private spawnSparks(point: Vector3, normal: Vector3, strength: number): void {
    if (!this.sparks) return;
    this.sparks.emitter = point.add(normal.scale(0.06));
    this.sparks.direction1 = normal.scale(2.4).add(new Vector3(-1.3, -1.3, -1.3));
    this.sparks.direction2 = normal.scale(3.6).add(new Vector3(1.3, 1.3, 1.3));
    // 12 / 24 / 40 particles per tier -> a visible spark burst that still fits
    // on a low-end phone.
    this.sparks.manualEmitCount = Math.max(4, Math.round(this.limits.particles * 0.6 * strength));
    this.sparks.start();
  }

  private buildEffects(): void {
    this.sparkTexture = new DynamicTexture('sparkTex', { width: 32, height: 32 }, this.scene, false);
    const ctx = this.sparkTexture.getContext();
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,235,1)');
    gradient.addColorStop(0.4, 'rgba(255,190,90,0.85)');
    gradient.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);
    this.sparkTexture.update();

    this.sparks = new ParticleSystem('sparks', 320, this.scene);
    this.sparks.particleTexture = this.sparkTexture;
    this.sparks.emitter = Vector3.Zero();
    this.sparks.minSize = 0.02;
    this.sparks.maxSize = 0.06;
    this.sparks.minLifeTime = 0.12;
    this.sparks.maxLifeTime = 0.34;
    this.sparks.emitRate = 0;
    this.sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
    this.sparks.gravity = new Vector3(0, -12, 0);
    this.sparks.color1 = new Color4(1, 0.85, 0.5, 1);
    this.sparks.color2 = new Color4(1, 0.55, 0.15, 1);
    this.sparks.colorDead = new Color4(0.2, 0.1, 0.05, 0);
    this.sparks.updateSpeed = 0.012;

    this.decalTexture = new DynamicTexture('decalTex', { width: 64, height: 64 }, this.scene, false);
    const dctx = this.decalTexture.getContext();
    const hole = dctx.createRadialGradient(32, 32, 1, 32, 32, 26);
    hole.addColorStop(0, 'rgba(12,10,9,0.95)');
    hole.addColorStop(0.5, 'rgba(30,26,22,0.6)');
    hole.addColorStop(1, 'rgba(40,36,30,0)');
    dctx.fillStyle = hole;
    dctx.fillRect(0, 0, 64, 64);
    this.decalTexture.update();
    this.decalTexture.hasAlpha = true;
  }

  dispose(): void {
    for (const tracer of this.tracers) tracer.mesh.dispose();
    for (const decal of this.decals) {
      decal.material?.dispose();
      decal.dispose();
    }
    this.tracers = [];
    this.decals = [];
    this.sparks?.dispose();
    this.sparkTexture?.dispose();
    this.decalTexture?.dispose();
    this.flash?.dispose();
    this.flashLight?.dispose();
    this.muzzle?.dispose();
    this.model?.dispose();
    this.pivot?.dispose();
  }
}
