/**
 * Over-the-shoulder spring-arm camera.
 *
 * Input is detached from the camera: the pointer is locked by InputManager and
 * look deltas are fed in here, so mouse, touch-look and gamepad all behave the
 * same. The arm shortens when something would come between the camera and the
 * player, and blends into a tight ADS pose when aiming.
 */
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';

import { CAMERA } from '../config';

export interface CameraTarget {
  /** Eye point of the player (feet + eye height). */
  position: Vector3;
  /** True while the player is sprinting and on the ground. */
  sprint?: boolean;
  /** False while airborne; a jump must not freeze the camera's height. */
  grounded?: boolean;
  /**
   * Meshes the camera must not treat as obstacles — the player's own body and
   * weapon. Without this the spring arm can be stopped by the person it is
   * following.
   */
  ignore?: AbstractMesh[];
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
  /**
   * 0..1 blend into "straight-line sprint" framing. While it is engaged the
   * camera rides level and straight behind the player: pitch input is ignored
   * and eased to horizontal, the shoulder offset is faded out, the eye height is
   * stabilised against ground bumps, and shake is suppressed.
   */
  private sprintLock = 0;
  private lockedHeight = 0;
  private heightLocked = false;
  /** Meshes the camera ignores when colliding (the player's own body). */
  private ignore: AbstractMesh[] = [];
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
    // Engage the straight-line sprint framing once he is really running and
    // grounded (a jump or fall keeps normal camera tracking so he cannot leave
    // the frame). It fades in and out so the transition is not a snap.
    this.ignore = target.ignore ?? [];
    const wantLock = !!target.sprint && target.grounded !== false && !aiming;
    // Releasing is quicker than engaging, and quickest of all once he is airborne:
    // a jump should hand camera control straight back rather than leave the view
    // pinned to the ground while he rises.
    const lockRate = wantLock
      ? CAMERA.sprintLockRate
      : target.grounded === false
        ? CAMERA.sprintLockAirborneRate
        : CAMERA.sprintLockRate;
    this.sprintLock += ((wantLock ? 1 : 0) - this.sprintLock) * Math.min(1, dt * lockRate);

    const deadzone = 1e-6;
    const sensitivity = CAMERA.sensitivityMouse * this.sensitivityScale * (1 - this.aimBlend * 0.55);
    if (Math.abs(look.x) > deadzone || Math.abs(look.y) > deadzone) {
      // Mouse/touch X is positive to the right and yaw increases clockwise seen
      // from above (the camera's right vector at yaw 0 is +X), so looking right
      // means *adding* to yaw. Subtracting it turned the view the wrong way:
      // moving the mouse right swung the camera left.
      this.yaw += look.x * sensitivity;
      // Vertical look stays live while sprinting, so the camera can climb and
      // descend too. `look.y` also drives touch drag, so this covers both. Pitch
      // is integrated straight from the input, which makes the resulting vertical
      // travel a clean line — all the wobble while sprinting came from the rig
      // (arm, shoulder offset, terrain bob), not from this axis, and those are
      // stabilised separately below.
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
    // Recoil *shake* is still suppressed while sprinting: it is noise rather than
    // intentional movement, and it would break the straight vertical line. Plain
    // pitch input above is unaffected.
    const pitch = Math.min(
      CAMERA.maxPitch,
      Math.max(CAMERA.minPitch, this.pitch + this.recoilPitch * (1 - this.sprintLock)),
    );

    // Pivot sits just above eye height on the player, pushed sideways for the
    // over-the-shoulder framing. `target.position` is already the eye point
    // (feet + eye height), so an extra eye-height offset here would put the
    // orbit centre ~1.6 m above the character's head: measured, that left him
    // 33 degrees off the view axis at hip and completely out of frame when
    // aiming down the sights.
    // The shoulder offset is faded out for the sprint lock: a sideways camera
    // offset swings the view left and right every time the yaw moves, which is
    // exactly the "not a straight line" motion. Centred behind, the camera
    // travels the same line as the player.
    const shoulder = (CAMERA.shoulder + (CAMERA.aimShoulder - CAMERA.shoulder) * this.aimBlend) * (1 - this.sprintLock);
    const right = new Vector3(Math.cos(-yaw), 0, Math.sin(-yaw));
    this.pivot.copyFrom(target.position);
    const eyeHeight = target.position.y + CAMERA.height - this.aimBlend * 0.04;
    if (this.sprintLock > 0.001) {
      // Hold the eye height steady across bumps so the camera cannot rise or
      // fall while sprinting; it drifts along slowly rather than tracking the
      // capsule exactly.
      if (!this.heightLocked) {
        this.lockedHeight = eyeHeight;
        this.heightLocked = true;
      } else if (Math.abs(eyeHeight - this.lockedHeight) > CAMERA.sprintHeightLag) {
        // Safety net: on a steep ramp the slow drift would leave the camera
        // behind the terrain. Past this lag it catches up at once, which normal
        // ground never reaches, so bump-free riding is unaffected.
        this.lockedHeight = eyeHeight;
      } else {
        this.lockedHeight += (eyeHeight - this.lockedHeight) * Math.min(1, dt * CAMERA.sprintHeightDrift);
      }
      this.pivot.y = this.lockedHeight * this.sprintLock + eyeHeight * (1 - this.sprintLock);
    } else {
      this.heightLocked = false;
      this.pivot.y = eyeHeight;
    }
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
    this.lookTarget.copyFrom(this.smoothedPivot).addInPlace(this.offset.scale(this.currentDistance * 0.35));

    if (this.sprintLock > 0.001) {
      // The spring arm shortens when something comes between camera and player
      // (walls, crates, a kerb), and because the arm points slightly upward the
      // camera would ride up and down with it — measured at 36 mm per frame while
      // turning through the level's buildings. Pin the rig to a level plane and
      // shift the look target by the same amount, which holds the view direction
      // exactly while the horizontal distance still shortens as it must.
      // Note `currentDistance`, not `desiredDistance`: the arm shortens when it
      // meets geometry, and pinning to the full-length height would push the
      // camera straight back down through the thing the arm just avoided (it
      // buried the camera under the road when looking down while sprinting).
      const levelY = this.lockedHeight + this.offset.y * this.currentDistance;
      const shift = (levelY - this.camera.position.y) * this.sprintLock;
      this.camera.position.y += shift;
      this.lookTarget.y += shift;
    }

    this.clampAboveGround(this.smoothedPivot.y);

    const shake = this.shake * (1 - this.sprintLock);
    if (shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake;
    }
    this.camera.setTarget(this.lookTarget);
    this.camera.fov = (CAMERA.fov + (CAMERA.aimFov - CAMERA.fov) * this.aimBlend) * (Math.PI / 180);
  }

  /** Geometry the camera should collide with (never the player's own body). */
  private isBlocker = (mesh: AbstractMesh): boolean =>
    mesh.isPickable && mesh.isEnabled() && !this.ignore.includes(mesh);

  /** Distance at which the arm hits geometry (never closer than 0.35 m). */
  private collide(from: Vector3, direction: Vector3, maxDistance: number): number {
    const ray = new Ray(from, direction, maxDistance);
    const hit = this.scene.pickWithRay(ray, this.isBlocker);
    if (hit?.hit && hit.distance > 0) return Math.max(0.35, hit.distance - 0.25);
    return maxDistance;
  }

  /**
   * Lifts the camera out of the terrain if it has ended up below it. Looking
   * steeply down walks the arm under the ground, and a camera inside the road
   * renders as a full-screen smear of dirt. Lifting is a last resort that never
   * triggers in the open, where the sprint ride is a clean straight line.
   */
  private clampAboveGround(referenceY: number): void {
    // Probe from high above the player and take the LOWEST surface rather than the
    // nearest one. Two failure modes force this:
    //   - Probing from the camera itself cannot recover once it is inside the
    //     terrain: the ray starts behind a back face and never reports a hit.
    //   - Taking the first hit from above is wrong too, because this level has
    //     overhead concrete slabs — the clamp decided the "ground" was 4 m above
    //     the camera and threw it into the air (a 3.2 m single-frame jump).
    // The lowest surface is the one the camera has to stay above.
    const from = new Vector3(this.camera.position.x, referenceY + 40, this.camera.position.z);
    const hits = this.scene.multiPickWithRay(new Ray(from, Vector3.Down(), 160), this.isBlocker);
    if (!hits?.length) return;
    let floorY = Infinity;
    for (const hit of hits) {
      if (hit.pickedPoint) floorY = Math.min(floorY, hit.pickedPoint.y);
    }
    if (!Number.isFinite(floorY)) return;
    const minY = floorY + CAMERA.minGroundClearance;
    if (this.camera.position.y < minY) {
      const lift = minY - this.camera.position.y;
      this.camera.position.y += lift;
      this.lookTarget.y += lift;
    }
  }

  dispose(): void {
    this.camera.dispose();
  }
}
