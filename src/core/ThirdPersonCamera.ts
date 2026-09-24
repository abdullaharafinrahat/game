/**
 * Over-the-shoulder spring-arm camera.
 *
 * Input is detached from the camera: the pointer is locked by InputManager and
 * look deltas are fed in here, so mouse, touch-look and gamepad all behave the
 * same. The arm shortens when something would come between the camera and the
 * player, and blends into a tight ADS pose when aiming.
 */
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';

import { CAMERA } from '../config';

export interface CameraTarget {
  /** Feet position of the player. */
  position: Vector3;
}

export class ThirdPersonCamera {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = -0.16;
  /** 0 = hip fire, 1 = fully aiming down sights. */
  aimBlend = 0;
  invertY = false;
  /** Pause-menu sensitivity multiplier on top of the base sensitivity. */
  sensitivityScale = 1;

  private desiredDistance: number = CAMERA.distance;
  private currentDistance: number = CAMERA.distance;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private shake = 0;
  private smoothedPivot = new Vector3();
  private initialised = false;
  private readonly offset = new Vector3();
  private readonly pivot = new Vector3();
  private readonly lookTarget = new Vector3();

  constructor(private scene: Scene) {
    this.camera = new FreeCamera('playerCamera', new Vector3(0, 2, -4), scene);
    this.camera.minZ = 0.08;
    this.camera.maxZ = 900;
    this.camera.fov = (CAMERA.fov * Math.PI) / 180;
    this.camera.inputs.clear(); // fully driven by us
  }

  /**
   * Forward direction on the ground plane, taken from the camera itself.
   *
   * This used to be derived from the yaw as `-(sin yaw, cos yaw)`, which is the
   * OPPOSITE of where the camera looks — and since Player drives movement from
   * it, every direction came out mirrored (W walked backwards, A went right).
   * Deriving it from the view vector cannot drift out of sync with the camera.
   */
  get facing(): Vector3 {
    const dir = this.camera.getDirection(Vector3.Forward());
    dir.y = 0;
    if (dir.lengthSquared() < 1e-6) return new Vector3(0, 0, 1);
    return dir.normalize();
  }

  /** Where a bullet goes: straight down the camera's forward axis. */
  get aimDirection(): Vector3 {
    return this.camera.getDirection(Vector3.Forward());
  }

  get aimOrigin(): Vector3 {
    return this.camera.globalPosition.clone().addInPlace(this.aimDirection.scale(0.45));
  }

  get isAiming(): boolean {
    return this.aimBlend > 0.5;
  }

  addRecoil(pitch: number, yaw: number, shake = 0.05): void {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.shake = Math.min(0.35, this.shake + shake);
  }

  setZoom(delta: number): void {
    this.desiredDistance = Math.min(6.5, Math.max(1.6, this.desiredDistance + delta));
  }

  update(dt: number, target: CameraTarget, look: { x: number; y: number }, aiming: boolean): void {
    const deadzone = 1e-6;
    const sensitivity = CAMERA.sensitivityMouse * this.sensitivityScale * (1 - this.aimBlend * 0.55);
    if (Math.abs(look.x) > deadzone || Math.abs(look.y) > deadzone) {
      // Mouse/touch X is positive to the right and yaw increases clockwise seen
      // from above (the camera's right vector at yaw 0 is +X), so looking right
      // means *adding* to yaw. Subtracting it turned the view the wrong way:
      // moving the mouse right swung the camera left.
      this.yaw += look.x * sensitivity;
      this.pitch += (this.invertY ? -look.y : look.y) * sensitivity;
      this.pitch = Math.min(CAMERA.maxPitch, Math.max(CAMERA.minPitch, this.pitch));
    }

    // Recoil decays back to centre.
    const decay = Math.exp(-dt / CAMERA.recoilDecay);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;
    this.shake *= decay;

    this.aimBlend += ((aiming ? 1 : 0) - this.aimBlend) * Math.min(1, dt * 9);

    const yaw = this.yaw + this.recoilYaw;
    const pitch = Math.min(CAMERA.maxPitch, Math.max(CAMERA.minPitch, this.pitch + this.recoilPitch));

    // Pivot sits just above eye height on the player, pushed sideways for the
    // over-the-shoulder framing. `target.position` is already the eye point
    // (feet + eye height), so an extra eye-height offset here would put the
    // orbit centre ~1.6 m above the character's head: measured, that left him
    // 33 degrees off the view axis at hip and completely out of frame when
    // aiming down the sights.
    const shoulder = CAMERA.shoulder + (CAMERA.aimShoulder - CAMERA.shoulder) * this.aimBlend;
    const right = new Vector3(Math.cos(-yaw), 0, Math.sin(-yaw));
    this.pivot.copyFrom(target.position);
    this.pivot.y += CAMERA.height - this.aimBlend * 0.04;
    this.pivot.addInPlace(right.scale(shoulder));

    if (!this.initialised) {
      this.smoothedPivot.copyFrom(this.pivot);
      this.initialised = true;
    } else {
      this.smoothedPivot.addInPlace(this.pivot.subtract(this.smoothedPivot).scale(Math.min(1, dt * CAMERA.positionLerp)));
    }

    // Camera offset direction (behind the player).
    const horizontal = Math.cos(pitch);
    this.offset.set(-Math.sin(yaw) * horizontal, Math.sin(pitch) + 0.12, -Math.cos(yaw) * horizontal).normalize();

    const targetDistance = this.aimBlend > 0.02 ? CAMERA.aimDistance : this.desiredDistance;
    const distance = Math.max(targetDistance, this.collide(this.smoothedPivot, this.offset, targetDistance + 0.3));

    // Snap inward instantly (never clip through a wall) but ease back out.
    if (distance < this.currentDistance) this.currentDistance = distance;
    else this.currentDistance += (distance - this.currentDistance) * Math.min(1, dt * CAMERA.zoomSpeed);

    // Recompute FOV before positioning: (position, target, fov) must be written
    // after every setTarget, or the projection lags a frame behind the rig.
    const fovTarget = CAMERA.fov + (CAMERA.aimFov - CAMERA.fov) * this.aimBlend;
    const fov = (fovTarget * Math.PI) / 180;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 10);

    this.camera.position.copyFrom(this.smoothedPivot).addInPlace(this.offset.scale(this.currentDistance));
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
    }
    this.lookTarget.copyFrom(this.smoothedPivot).addInPlace(this.offset.scale(this.currentDistance * 0.35));
    this.camera.setTarget(this.lookTarget);
    this.camera.fov = (CAMERA.fov + (CAMERA.aimFov - CAMERA.fov) * this.aimBlend) * (Math.PI / 180);
  }

  /** Distance at which the arm hits geometry (never closer than 0.35 m). */
  private collide(from: Vector3, direction: Vector3, maxDistance: number): number {
    const ray = new Ray(from, direction, maxDistance);
    const hit = this.scene.pickWithRay(ray, (mesh) => mesh.isPickable && mesh.isEnabled());
    if (hit?.hit && hit.distance > 0) return Math.max(0.35, hit.distance - 0.25);
    return maxDistance;
  }

  dispose(): void {
    this.camera.dispose();
  }
}
