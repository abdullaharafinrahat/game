/**
 * Sky, lighting, shadows, fog and image-based lighting.
 *
 * Deliberately dependency-free: the sky is a vertex-coloured dome and the
 * environment map is a one-shot reflection probe of that dome, so there are no
 * .env/.hdr files to download and nothing to fetch at runtime. This matters
 * because the character uses PBR metallic-roughness materials, which look dead
 * flat without any environment lighting.
 */
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { ReflectionProbe } from '@babylonjs/core/Probes/reflectionProbe';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

import type { QualitySettings } from '../config';

const SKY_TOP = new Color3(0.24, 0.42, 0.72);
const SKY_HORIZON = new Color3(0.78, 0.82, 0.86);
const GROUND_HAZE = new Color3(0.46, 0.44, 0.4);

export interface Environment {
  sun: DirectionalLight;
  ambient: HemisphericLight;
  shadowGenerator: ShadowGenerator | null;
  sky: Mesh;
  addShadowCaster(mesh: AbstractMesh | AbstractMesh[]): void;
  /**
   * Keeps the shadow frustum centred on the player. With `autoUpdateExtends`
   * Babylon would size the frustum to every caster in the scene — on a 260 m map
   * that spreads a 2048px map over 260 m and the shadows dissolve, so the
   * frustum is fixed-size and moved instead.
   */
  updateShadowFocus(position: Vector3): void;
  refreshEnvironment(): void;
  dispose(): void;
}

/** Half-width of the shadow frustum, in meters. */
const SHADOW_RADIUS = 32;

export function createEnvironment(scene: Scene, quality: QualitySettings): Environment {
  // --- Sky dome -----------------------------------------------------------
  const sky = MeshBuilder.CreateSphere('sky', { diameter: 1200, segments: 24, sideOrientation: 1 }, scene);
  const gradient = new StandardMaterial('skyMat', scene);
  gradient.disableLighting = true;
  gradient.emissiveColor = Color3.White();
  gradient.diffuseColor = Color3.Black();
  gradient.specularColor = Color3.Black();
  gradient.backFaceCulling = false;
  sky.material = gradient;
  sky.isPickable = false;
  sky.infiniteDistance = true;
  applySkyGradient(sky);

  scene.clearColor = new Color4(SKY_HORIZON.r, SKY_HORIZON.g, SKY_HORIZON.b, 1);
  scene.fogMode = 2; // EXP2
  scene.fogColor = new Color3(0.66, 0.68, 0.7);
  // Expo-squared fog: 2.2/d gives ~30% haze at 60 m and near-total occlusion at
  // the far plane, which reads as depth instead of a wall of grey.
  scene.fogDensity = 2.2 / quality.maxDistance;

  // --- Lights -------------------------------------------------------------
  const ambient = new HemisphericLight('ambient', new Vector3(0.2, 1, 0.15), scene);
  ambient.intensity = 0.62;
  ambient.diffuse = new Color3(0.86, 0.9, 1);
  ambient.groundColor = new Color3(0.34, 0.31, 0.27);

  const sun = new DirectionalLight('sun', new Vector3(-0.42, -1, 0.34), scene);
  sun.position = new Vector3(42, 78, -34);
  sun.intensity = 2.5;
  sun.diffuse = new Color3(1, 0.96, 0.88);
  if (quality.shadows) {
    // Fixed frustum, moved with the player (see updateShadowFocus).
    sun.autoUpdateExtends = false;
    sun.autoCalcShadowZBounds = false;
    sun.shadowOrthoScale = 1;
    sun.orthoLeft = -SHADOW_RADIUS;
    sun.orthoRight = SHADOW_RADIUS;
    sun.orthoTop = SHADOW_RADIUS;
    sun.orthoBottom = -SHADOW_RADIUS;
    sun.shadowMinZ = 1;
    sun.shadowMaxZ = 200;
  }

  let shadowGenerator: ShadowGenerator | null = null;
  if (quality.shadows) {
    // Shadows are a nicety, never a hard requirement: if the shadow generator
    // cannot be built (a missing side-effect import, a driver quirk) the scene
    // continues unlit rather than showing the player an error screen.
    try {
      shadowGenerator = new ShadowGenerator(quality.shadowMapSize, sun);
      // These numbers are measured, not guessed. Exponential shadow maps are
      // extremely sensitive to `depthScale`: at 40 the exponential falloff goes
      // so light that the shadows vanish outright, and a large `normalBias`
      // (0.02) pushes the surface away and erases the contact shadow under a
      // character. verify/shadow-experiment.mjs sweeps the combinations and
      // reports frame-luminance deltas — the current values darken the shadowed
      // ground by ~18% while 40/0.02 darkened it by 0.00%.
      shadowGenerator.useBlurExponentialShadowMap = true;
      shadowGenerator.blurKernel = 8;
      shadowGenerator.depthScale = 30;
      shadowGenerator.setDarkness(0.25);
      shadowGenerator.bias = 0.0008;
      shadowGenerator.normalBias = 0.004;
    } catch (error) {
      console.warn('[environment] shadows unavailable, continuing without them:', error);
      shadowGenerator = null;
    }
  }

  // --- Environment lighting (IBL) ----------------------------------------
  // One-shot probe of the sky dome + sun disc: gives the PBR materials
  // something to reflect without shipping an .hdr.
  const sunDisc = MeshBuilder.CreateDisc('sunDisc', { radius: 26, tessellation: 24 }, scene);
  const sunMat = new StandardMaterial('sunMat', scene);
  sunMat.disableLighting = true;
  sunMat.emissiveColor = new Color3(1, 0.9, 0.72);
  sunMat.backFaceCulling = false;
  sunDisc.material = sunMat;
  sunDisc.position = new Vector3(180, 220, -150);
  sunDisc.isPickable = false;
  sunDisc.lookAt(Vector3.Zero());

  let probe: ReflectionProbe | null = null;
  // Same reasoning as the shadows above: image-based lighting is optional.
  try {
    probe = new ReflectionProbe('envProbe', 128, scene, true);
    probe.renderList?.push(sky, sunDisc);
    probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    scene.environmentTexture = probe.cubeTexture;
    scene.environmentIntensity = 0.85;
  } catch {
    probe = null; // no IBL: direct lights still carry the scene
  }

  const casters = new Set<AbstractMesh>();

  return {
    sun,
    ambient,
    shadowGenerator,
    sky,
    addShadowCaster(mesh) {
      const list = Array.isArray(mesh) ? mesh : [mesh];
      for (const m of list) {
        if (m.getTotalVertices() > 0) casters.add(m);
      }
      shadowGenerator?.getShadowMap()?.renderList?.push(...list);
      for (const m of list) m.receiveShadows = true;
    },
    updateShadowFocus(position: Vector3) {
      if (!shadowGenerator) return;
      // Same offset as the light's initial placement, so the light direction is
      // unchanged and only the frustum moves.
      sun.position.set(position.x + 42, position.y + 78, position.z - 34);
    },
    refreshEnvironment() {
      if (probe) probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    },
    dispose() {
      shadowGenerator?.dispose();
      probe?.dispose();
      sky.dispose();
      sunDisc.dispose();
      sun.dispose();
      ambient.dispose();
    },
  };
}

/** Vertex-colour gradient: blue overhead fading into a hazy horizon. */
function applySkyGradient(sky: Mesh): void {
  const positions = sky.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    const t = Math.max(0, Math.min(1, (y + 600) / 1200)); // 0 at bottom, 1 at top
    const from = y < 0 ? GROUND_HAZE : SKY_HORIZON;
    const to = y < 0 ? SKY_HORIZON : SKY_TOP;
    const blend = y < 0 ? Math.min(1, -y / 300) : Math.min(1, t * 1.35);
    colors.push(
      from.r + (to.r - from.r) * blend,
      from.g + (to.g - from.g) * blend,
      from.b + (to.b - from.b) * blend,
      1,
    );
  }
  sky.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
}
