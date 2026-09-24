/**
 * Level assembly: battleground colliders, house placement and the shootable
 * dynamic props (crates + explosive barrels) that make a sandbox worth walking
 * around in.
 *
 * Collider strategy is deliberately mixed for mobile:
 *   - battleground: exact triangle meshes (only 2.7k tris) so roads and
 *     buildings are accurate underfoot and under fire;
 *   - houses: convex hulls. Each house is 39-56k tris, so an exact mesh
 *     collider times four houses would be a lot of BVH to build on a phone,
 *     and a hull is a perfectly good approximation for solid buildings.
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Ray } from '@babylonjs/core/Culling/ray';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';

import { LEVEL } from '../config';
import type { AssetLibrary } from '../core/Assets';
import type { GameAudio } from '../core/Audio';
import type { Environment } from '../core/Environment';

export interface LevelEvents {
  onExplosion(point: Vector3, radius: number): void;
}

export interface LevelHandle {
  spawnPoint: Vector3;
  props: AbstractMesh[];
  /** Detonates an explosive prop (called when the player shoots a barrel). */
  explode(mesh: AbstractMesh): void;
  dispose(): void;
}

/** Deterministic PRNG so the layout is identical for every player. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export function buildLevel(
  scene: Scene,
  library: AssetLibrary,
  environment: Environment,
  audio: GameAudio,
  events: LevelEvents,
): LevelHandle {
  const random = makeRandom(20260924);
  const props: AbstractMesh[] = [];
  const aggregates: PhysicsAggregate[] = [];
  const owned: (TransformNode | AbstractMesh)[] = [];

  // --- Battleground -------------------------------------------------------
  // Measured, then rescaled: the pack's map is 11.5 km across as authored.
  const battleground = library.propContainers.get('battleground');
  let mapSize = LEVEL.sizeMeters;
  if (battleground) {
    battleground.addAllToScene();
    const root = new TransformNode('battlegroundRoot', scene);
    owned.push(root);

    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of battleground.meshes) {
      if (!mesh.getTotalVertices()) continue;
      mesh.setParent(root);
      mesh.isPickable = true;
      mesh.receiveShadows = true;
      mesh.metadata = { ...(mesh.metadata ?? {}), surface: 'stone' };
      mesh.computeWorldMatrix(true);
      mesh.refreshBoundingInfo(true, true);
      const box = mesh.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, box.minimumWorld);
      max = Vector3.Maximize(max, box.maximumWorld);
    }
    const size = max.subtract(min);
    const footprint = Math.max(size.x, size.z) || 1;
    const scale = LEVEL.sizeMeters / footprint;
    root.scaling.setAll(scale);
    root.computeWorldMatrix(true);
    // Re-centre the map on the origin so gameplay maths stays simple.
    root.position.set(-(min.x + max.x) * 0.5 * scale, -(min.y + max.y) * 0.5 * scale, -(min.z + max.z) * 0.5 * scale);
    root.computeWorldMatrix(true);
    mapSize = footprint * scale;
    console.info(
      `[level] battleground ${footprint.toFixed(0)} x ${Math.max(size.y, 1).toFixed(0)} units -> scaled x${scale.toFixed(4)} ` +
        `=> ${mapSize.toFixed(0)} m across`,
    );

    for (const mesh of battleground.meshes) {
      if (!mesh.getTotalVertices()) continue;
      // Static triangle-mesh collider: only 2.7k tris, so exact collision is cheap.
      aggregates.push(new PhysicsAggregate(mesh, PhysicsShapeType.MESH, { mass: 0 }, scene));
      environment.addShadowCaster(mesh);
      mesh.freezeWorldMatrix();
    }
  }

  const solid = (mesh: { isPickable: boolean; isEnabled: () => boolean }) => mesh.isPickable && mesh.isEnabled();

  /** Height of the walkable surface directly below (x, z), or null if none. */
  const groundAt = (x: number, z: number, from = 900): number | null => {
    const pick = scene.pickWithRay(new Ray(new Vector3(x, from, z), Vector3.Down(), from + 1200), solid);
    return pick?.hit && pick.pickedPoint ? pick.pickedPoint.y : null;
  };

  const groundY = (x: number, z: number): number => groundAt(x, z) ?? 0;

  const rayBlocked = (origin: Vector3, direction: Vector3, length: number): boolean => {
    const pick = scene.pickWithRay(new Ray(origin, direction, length), solid);
    return Boolean(pick?.hit);
  };

  // --- Houses ------------------------------------------------------------
  const houseNames = ['house', 'house_1', 'house_2', 'house_big'];
  const ringRadius = mapSize * 0.5 * LEVEL.houseRingFraction;
  const ring = [
    { x: ringRadius * 0.9, z: -ringRadius * 0.6, rot: 0.35 },
    { x: -ringRadius, z: ringRadius * 0.5, rot: -0.8 },
    { x: ringRadius * 0.3, z: ringRadius * 1.2, rot: 2.1 },
    { x: -ringRadius * 0.6, z: -ringRadius * 1.1, rot: 1.2 },
  ];

  houseNames.forEach((name, index) => {
    const container = library.propContainers.get(name);
    if (!container) return;
    const slot = ring[index % ring.length];
    container.addAllToScene();

    const meshes = container.meshes.filter((m) => m.getTotalVertices() > 0) as Mesh[];
    if (!meshes.length) return;

    // Normalise: measure the house, then scale it to a believable 6 m height.
    const root = new TransformNode(`house_${index}_root`, scene);
    owned.push(root);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const mesh of meshes) {
      mesh.setParent(root);
      mesh.computeWorldMatrix(true);
      mesh.refreshBoundingInfo();
      const box = mesh.getBoundingInfo().boundingBox;
      minY = Math.min(minY, box.minimumWorld.y);
      maxY = Math.max(maxY, box.maximumWorld.y);
      mesh.metadata = { ...(mesh.metadata ?? {}), surface: 'wood' };
      mesh.isPickable = true;
      mesh.receiveShadows = true;
    }
    const height = Number.isFinite(minY) && Number.isFinite(maxY) ? Math.max(0.001, maxY - minY) : 1;
    const scale = Math.min(3, Math.max(0.05, 6 / height));
    root.scaling.setAll(scale);
    root.position.set(slot.x, groundY(slot.x, slot.z), slot.z);
    root.rotation.y = slot.rot;
    root.computeWorldMatrix(true);

    for (const mesh of meshes) {
      mesh.computeWorldMatrix(true);
      // forceWorldMatrixRecursion so the hull is built in the right place.
      aggregates.push(new PhysicsAggregate(mesh, PhysicsShapeType.CONVEX_HULL, { mass: 0 }, scene));
      environment.addShadowCaster(mesh);
    }
  });

  // --- Shootable dynamic props ------------------------------------------
  const woodMat = new StandardMaterial('crateMat', scene);
  woodMat.diffuseColor = new Color3(0.55, 0.4, 0.24);
  woodMat.specularColor = new Color3(0.08, 0.08, 0.08);
  const metalMat = new StandardMaterial('barrelMat', scene);
  metalMat.diffuseColor = new Color3(0.62, 0.2, 0.16);
  metalMat.specularColor = new Color3(0.4, 0.4, 0.4);
  metalMat.specularPower = 48;

  const spawnProp = (mesh: Mesh, material: StandardMaterial, meta: Record<string, unknown>, mass: number) => {
    mesh.material = material;
    mesh.isPickable = true;
    mesh.receiveShadows = true;
    mesh.metadata = { ...meta };
    aggregates.push(new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass, friction: 0.55, restitution: 0.12 }, scene));
    environment.addShadowCaster(mesh);
    props.push(mesh);
  };

  for (let i = 0; i < 12; i++) {
    const angle = random() * Math.PI * 2;
    const radius = mapSize * 0.04 + random() * mapSize * LEVEL.propSpreadFraction * 0.4;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const crate = MeshBuilder.CreateBox(`crate_${i}`, { size: 0.62 }, scene);
    crate.position.set(x, groundY(x, z) + 0.32, z);
    crate.rotation.y = random() * Math.PI;
    spawnProp(crate, woodMat, { surface: 'wood', health: 40 }, 14);
  }

  for (let i = 0; i < 7; i++) {
    const angle = random() * Math.PI * 2;
    const radius = mapSize * 0.05 + random() * mapSize * LEVEL.propSpreadFraction * 0.5;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const barrel = MeshBuilder.CreateCylinder(`barrel_${i}`, { height: 0.95, diameter: 0.62, tessellation: 16 }, scene);
    barrel.position.set(x, groundY(x, z) + 0.48, z);
    const explosive = i % 3 === 0;
    spawnProp(barrel, metalMat, { surface: 'metal', health: explosive ? 35 : 60, explosive }, 22);
  }

  // --- Explosions --------------------------------------------------------
  const blastTexture = new DynamicTexture('blastTex', { width: 64, height: 64 }, scene, false);
  const blastCtx = blastTexture.getContext();
  const blastGradient = blastCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  blastGradient.addColorStop(0, 'rgba(255,250,220,1)');
  blastGradient.addColorStop(0.45, 'rgba(255,170,60,0.8)');
  blastGradient.addColorStop(1, 'rgba(120,60,20,0)');
  blastCtx.fillStyle = blastGradient;
  blastCtx.fillRect(0, 0, 64, 64);
  blastTexture.update();

  const blast = new ParticleSystem('blast', 400, scene);
  blast.particleTexture = blastTexture;
  blast.emitter = Vector3.Zero();
  blast.minSize = 0.4;
  blast.maxSize = 1.5;
  blast.minLifeTime = 0.25;
  blast.maxLifeTime = 0.7;
  blast.emitRate = 0;
  blast.blendMode = ParticleSystem.BLENDMODE_ADD;
  blast.gravity = new Vector3(0, -4, 0);
  blast.color1 = new Color3(1, 0.85, 0.5).toColor4(1);
  blast.color2 = new Color3(1, 0.4, 0.1).toColor4(1);
  blast.colorDead = new Color3(0.15, 0.1, 0.08).toColor4(0);

  const explosionLights: PointLight[] = [];

  const explode = (mesh: AbstractMesh): void => {
    const point = mesh.absolutePosition.clone();
    const radius = 6.5;

    mesh.isPickable = false;
    mesh.setEnabled(false);
    mesh.physicsBody?.dispose();
    const index = props.indexOf(mesh);
    if (index >= 0) props.splice(index, 1);

    blast.emitter = point;
    blast.manualEmitCount = 180;
    blast.start();
    audio.explosion(Vector3.Distance(point, scene.activeCamera?.globalPosition ?? Vector3.Zero()));

    const light = new PointLight(`blastLight_${explosionLights.length}`, point, scene);
    light.intensity = 90;
    light.range = 24;
    light.diffuse = new Color3(1, 0.7, 0.35);
    explosionLights.push(light);

    // Shove every dynamic body nearby, then drop the light a moment later.
    for (const other of props) {
      const body = other.physicsBody;
      if (!body) continue;
      const delta = other.absolutePosition.subtract(point);
      const distance = delta.length();
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      const impulse = delta.normalizeToNew().scale(falloff * 260).addInPlace(new Vector3(0, falloff * 120, 0));
      body.applyImpulse(impulse, other.absolutePosition);
    }

    events.onExplosion(point, radius);

    window.setTimeout(() => {
      light.dispose();
    }, 140);
  };

  // --- Spawn point -------------------------------------------------------
  // The source map has buildings right through the middle, so the spawn is
  // *searched* outward from the centre for somewhere with ground underfoot,
  // headroom above and elbow room around. Otherwise the player starts inside a
  // wall with the third-person camera in the concrete.
  /** All hit points down a column, top first — used to find street level. */
  const column = (x: number, z: number): number[] => {
    const hits = scene.multiPickWithRay(new Ray(new Vector3(x, 600, z), Vector3.Down(), 1200), solid);
    return (hits ?? [])
      .map((h) => h.pickedPoint?.y)
      .filter((y): y is number => typeof y === 'number')
      .sort((a, b) => b - a);
  };

  const findOpenSpawn = (): Vector3 => {
    const good = (x: number, z: number): number | null => {
      const surfaces = column(x, z);
      if (!surfaces.length) return null;
      const lowest = surfaces[surfaces.length - 1];
      // Street level, not a rooftop: only accept columns whose walkable surface
      // is within 1.5 m of the lowest one. Rooftop spawns put the third-person
      // camera inside the building and make the scale look wrong.
      if (surfaces[0] - lowest > 1.5) return null;
      const feet = lowest + 0.05;
      if (rayBlocked(new Vector3(x, feet, z), Vector3.Up(), 2.4)) return null;
      for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const dir = new Vector3(Math.cos(angle), 0, Math.sin(angle));
        if (rayBlocked(new Vector3(x, feet + 1, z), dir, 2.4)) return null;
      }
      return lowest;
    };

    for (let ring = 0; ring < 16; ring++) {
      const radius = ring * mapSize * 0.022;
      const samples = ring === 0 ? 1 : Math.max(6, ring * 4);
      for (let i = 0; i < samples; i++) {
        const angle = (i / samples) * Math.PI * 2 + ring * 0.83;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const ground = good(x, z);
        if (ground !== null) return new Vector3(x, ground, z);
      }
    }
    return new Vector3(0, groundY(0, 0), 0);
  };

  const spawnPoint = findOpenSpawn();
  console.info(`[level] spawn at ${spawnPoint.asArray().map((v) => v.toFixed(1)).join(', ')}`);

  return {
    spawnPoint,
    props,
    explode,
    dispose() {
      blast.dispose();
      blastTexture.dispose();
      for (const light of explosionLights) light.dispose();
      for (const aggregate of aggregates) aggregate.dispose();
      for (const node of owned) node.dispose();
    },
  };
}
