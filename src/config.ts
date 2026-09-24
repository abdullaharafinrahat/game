/**
 * Central tuning file. Everything gameplay-facing that you are likely to want
 * to tweak lives here, not scattered through the systems.
 */
import type { QualityTier } from './core/Quality';

export const GAME = {
  /** Fixed-ish step for physics/character integration (seconds). */
  fixedStep: 1 / 60,
  maxSubSteps: 4,
  gravity: -19.6, // ~2x real gravity: snappier arcade feel
} as const;

export const MOVE = {
  walk: 1.7,
  run: 4.0,
  sprint: 6.4,
  aim: 1.8,
  crouch: 1.2,
  /** Ground acceleration / braking (m/s^2). */
  accel: 22,
  brake: 26,
  airControl: 0.28,
  jumpSpeed: 6.4,
  /** Coyote time + jump buffering: quality-of-life for platforming feel. */
  coyoteTime: 0.12,
  jumpBuffer: 0.14,
  maxSlopeCosine: 0.55, // ~57 degrees
  crouchHeightScale: 0.72,
} as const;

export const LEVEL = {
  /**
   * Target footprint of the map's longest side, in meters. The source pack is
   * authored in centimetres (battleground.glb measures 11,545 x 11,545 units
   * and 882 units tall, i.e. an 11.5 km map), so it is rescaled to something a
   * 1.78 m character can actually walk around. 160 m keeps the buildings at a
   * believable 8-9 m.
   */
  sizeMeters: 260,
  /** Where the houses sit, as a fraction of half the map size. */
  houseRingFraction: 0.34,
  /** Crates/barrels scattered within this fraction of the map centre. */
  propSpreadFraction: 0.3,
} as const;

export const PLAYER = {
  capsuleHeight: 1.1,
  capsuleRadius: 0.34,
  /** Eye height above feet, and where the camera pivots from. */
  eyeHeight: 1.62,
  /** Correction applied to the model root so the feet sit on the capsule base. */
  modelYOffset: 0,
  maxHealth: 100,
} as const;

export const CAMERA = {
  distance: 3.4,
  aimDistance: 1.35,
  /** Extra height above the player's eye point for the orbit centre. */
  height: 0.18,
  shoulder: 0.55,
  /**
   * Shoulder offset while aiming. Keep it well under aimDistance * tan(aimFov/2)
   * or the character and rifle slide out of frame — that happened at 0.62.
   */
  aimShoulder: 0.34,
  fov: 78,
  aimFov: 48,
  minPitch: -1.15,
  maxPitch: 1.2,
  sensitivityMouse: 0.0022,
  sensitivityTouch: 0.0042,
  /** How fast the spring arm recovers/grows distance (units/sec). */
  zoomSpeed: 6,
  /** Seconds of camera shake decay after firing. */
  recoilDecay: 0.14,
  positionLerp: 22,
} as const;

export const WEAPON = {
  name: 'Sniper',
  magSize: 5,
  reserveAmmo: 25,
  /** Seconds between shots. */
  fireInterval: 0.62,
  reloadTime: 2.6,
  damage: 60,
  /** Hitscan range (meters). */
  range: 400,
  recoilPitch: 0.055,
  recoilYaw: 0.022,
  /** Crosshair bloom in pixels added per shot / while moving. */
  bloomPerShot: 26,
  bloomWhileMoving: 14,
  bloomDecay: 42,
  /** Tracer lifetime (seconds). Decal and particle budgets live in QUALITY. */
  tracerLife: 0.09,
} as const;

/**
 * Stride length in meters per second of animation playback at speedRatio 1.
 * Used to keep the feet from sliding: speedRatio = moveSpeed / strideSpeed.
 * If the asset pipeline measured real root-motion drift for a clip, the
 * measured value wins (see `resolveStrideSpeed`).
 */
export const CLIP_STRIDE: Record<string, number> = {
  Walk: 1.45,
  WalkForwardLeft: 1.45,
  WalkForwardRight: 1.45,
  Run: 3.5,
  Sprint: 5.4,
  SprintAlt: 5.4,
  RifleWalk: 1.4,
  RifleWalkAlt: 1.4,
  RifleRun: 3.4,
  RifleRunAlt: 3.4,
};

export const KEYBINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  reload: ['KeyR'],
  aim: ['KeyF'],
  interact: ['KeyE'],
  quality: ['KeyQ'],
} as const;

/** Visual presets per device tier. */
export interface QualitySettings {
  hardwareScaling: number;
  shadows: boolean;
  shadowMapSize: number;
  anisotropy: number;
  particles: number;
  decals: number;
  /** Reserved: post-processing is not wired up yet (no DefaultRenderingPipeline). */
  bloom: boolean;
  fxaa: boolean;
  /** Draw distance for the fog / far plane. */
  maxDistance: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    hardwareScaling: 1.7,
    shadows: false,
    shadowMapSize: 512,
    anisotropy: 1,
    particles: 12,
    decals: 8,
    bloom: false,
    fxaa: false,
    maxDistance: 220,
  },
  medium: {
    hardwareScaling: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    anisotropy: 2,
    particles: 24,
    decals: 24,
    bloom: false,
    fxaa: true,
    maxDistance: 340,
  },
  high: {
    hardwareScaling: 1,
    shadows: true,
    shadowMapSize: 2048,
    anisotropy: 4,
    particles: 40,
    decals: 40,
    bloom: true,
    fxaa: true,
    maxDistance: 480,
  },
};
