/**
 * Asset loading + clip binding.
 *
 * Everything is loaded from the generated manifest (`public/assets/manifest.json`,
 * written by `npm run assets`), never by hardcoded filename — so re-running the
 * pipeline against a different source pack keeps the game working.
 */
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF/2.0';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';

import { retargetClip, type RetargetReport } from './Retarget';

export interface ManifestModel {
  name: string;
  url: string;
  bytes: number;
  tris: number;
  collider?: 'mesh' | 'none';
  skins?: { name: string; joints: number }[];
  animationCount?: number;
}

export interface ManifestClip {
  name: string;
  url: string;
  group: 'locomotion' | 'rifle' | 'combat' | 'stance' | 'hit';
  loop: boolean;
  duration: number;
  rootMotion: boolean;
  rootMotionDrift: number;
  hipsHeightUnits: number;
  unitToMeters: number;
  upAxis: 'x' | 'y' | 'z';
  bytes: number;
}

export interface GameManifest {
  generatedAt: string;
  source: { repo: string; branch: string; dir: string };
  character: ManifestModel;
  props: ManifestModel[];
  clips: ManifestClip[];
}

export interface LoadProgress {
  loaded: number;
  total: number;
  label: string;
  /** 0..1 */
  ratio: number;
}

export interface CharacterBinding {
  root: TransformNode;
  meshes: AbstractMesh[];
  skeleton: Skeleton;
  boneMap: Map<string, TransformNode>;
  /** Height in meters, measured from mesh bounds. */
  height: number;
  /** Y offset so the feet rest on y = 0. */
  feetOffset: number;
}

export class AssetLibrary {
  manifest!: GameManifest;
  character!: CharacterBinding;
  clips = new Map<string, AnimationGroup>();
  clipMeta = new Map<string, ManifestClip>();
  /** Parsed animation + sampler on the *source* rig, before retargeting. */
  propContainers = new Map<string, AssetContainer>();
  reports: RetargetReport[] = [];
  /** Clips whose bones could not be matched — surfaced as a load warning. */
  warnings: string[] = [];

  private scene!: Scene;
  private cache = new Map<string, AssetContainer>();

  async loadAll(scene: Scene, onProgress: (p: LoadProgress) => void, concurrency = 6): Promise<void> {
    this.scene = scene;
    this.manifest = await this.fetchManifest();
    const manifest = this.manifest;

    const totals = {
      character: manifest.character.bytes,
      props: manifest.props.reduce((a, p) => a + p.bytes, 0),
      clips: manifest.clips.reduce((a, c) => a + c.bytes, 0),
    };
    const total = totals.character + totals.props + totals.clips;
    let done = 0;

    const step = (label: string, bytes: number, fraction: number) =>
      onProgress({ loaded: done + bytes * fraction, total, label, ratio: Math.min(1, (done + bytes * fraction) / total) });

    // 1. Hero character. Everything else hangs off its skeleton.
    step('Loading soldier', 0, 0);
    const character = await this.load(manifest.character.url, (f: number) =>
      step(`Loading soldier (${manifest.character.tris.toLocaleString()} tris)`, totals.character, f),
    );
    done += totals.character;
    character.addAllToScene();
    this.character = this.bindCharacter(character);

    // 2. Static level + weapon props.
    for (const prop of manifest.props) {
      step(`Loading ${prop.name}`, 0, 0);
      const container = await this.load(prop.url, (f: number) => step(`Loading ${prop.name}`, prop.bytes, f));
      done += prop.bytes;
      this.propContainers.set(prop.name, container);
    }

    // 3. Animation clips, retargeted onto the hero skeleton, then discarded.
    let clipIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, manifest.clips.length) }, async () => {
      while (clipIndex < manifest.clips.length) {
        const clip = manifest.clips[clipIndex++];
        const container = await this.load(clip.url, (f: number) => step(`Warming up animations: ${clip.name}`, clip.bytes, f));
        done += clip.bytes;
        const { group, report } = retargetClip(this.scene, container, this.character.boneMap, {
          name: clip.name,
          loop: clip.loop,
          upAxis: clip.upAxis,
        });
        this.reports.push(report);
        if (report.dropped.length) this.warnings.push(`${clip.name}: ${report.dropped.length} unmatched bones`);
        if (group) {
          this.clips.set(clip.name, group);
          this.clipMeta.set(clip.name, clip);
        }
        // The clip's own armature has done its job — drop nodes + keyframes.
        container.dispose();
        step(`Warming up animations: ${clip.name}`, 0, 0);
      }
    });
    await Promise.all(workers);

    onProgress({ loaded: total, total, label: 'Ready', ratio: 1 });
  }

  /** Every loaded clip that retargeted successfully. */
  get clipNames(): string[] {
    return [...this.clips.keys()];
  }

  /**
   * Stride speed in m/s for playback at speedRatio 1, used to stop the feet
   * sliding. Prefers the value measured from real root motion in the pipeline
   * (Sprint: 3.45 m over a 0.52 s cycle = 6.6 m/s) and falls back to the
   * hand-tuned table for in-place cycles, which carry no travel to measure.
   */
  strideSpeed(name: string, fallbackTable: Record<string, number>): number {
    const meta = this.clipMeta.get(name);
    if (meta && meta.rootMotion && meta.duration > 0) {
      const measured = meta.rootMotionDrift / meta.duration;
      if (measured > 0.5) return measured;
    }
    return fallbackTable[name] ?? 0;
  }

  private async fetchManifest(): Promise<GameManifest> {
    const url = new URL('assets/manifest.json', document.baseURI).toString();
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`manifest.json missing (${res.status}) — run \`npm run assets\` first`);
    return (await res.json()) as GameManifest;
  }

  /** Loads one GLB into a container with byte-accurate progress. */
  private async load(url: string, onFraction: (f: number) => void): Promise<AssetContainer> {
    const key = url;
    const cached = this.cache.get(key);
    if (cached) {
      onFraction(1);
      return cached;
    }
    onFraction(0);
    const container = await LoadAssetContainerAsync(new URL(url, document.baseURI).toString(), this.scene, {
      onProgress: (event) => {
        const scale = event.total ? event.loaded / event.total : 0.35;
        onFraction(Math.min(1, scale));
      },
    });
    this.cache.set(key, container);
    onFraction(1);
    return container;
  }

  /**
   * Works out the character's real-world size and foot offset instead of
   * trusting magic numbers: the mesh bounds say it plainly (this pack measures
   * 1.78 m tall with its feet on y = 0, but a re-export could change that).
   */
  private bindCharacter(container: AssetContainer): CharacterBinding {
    const meshes = container.meshes.filter((m) => m.getTotalVertices() > 0) as AbstractMesh[];
    const skeleton = container.skeletons[0];
    const root = (container.rootNodes[0] ?? meshes[0]) as TransformNode;

    const boneMap = new Map<string, TransformNode>();
    for (const bone of skeleton?.bones ?? []) {
      const node = bone.getTransformNode();
      if (node) boneMap.set(bone.name, node);
    }
    // Non-bone nodes are reachable too (attachment points etc.).
    for (const node of [...container.transformNodes, ...container.meshes]) {
      if (node.name && !boneMap.has(node.name)) boneMap.set(node.name, node as TransformNode);
    }

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const mesh of meshes) {
      mesh.computeWorldMatrix(true);
      mesh.refreshBoundingInfo(true, true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      minY = Math.min(minY, bounds.minimumWorld.y);
      maxY = Math.max(maxY, bounds.maximumWorld.y);
    }
    const height = Number.isFinite(minY) && Number.isFinite(maxY) ? maxY - minY : 1.78;

    for (const mesh of meshes) {
      mesh.isPickable = false; // the player must not shoot themselves
      mesh.receiveShadows = true;
      if (mesh.material) {
        mesh.material.freeze();
      }
    }

    return { root, meshes, skeleton, boneMap, height, feetOffset: Number.isFinite(minY) ? -minY : 0 };
  }

  /** All loaded clips, for tooling/debug. */
  listClips(): { meta: ManifestClip; group: AnimationGroup }[] {
    return [...this.clips.entries()].map(([name, group]) => ({ meta: this.clipMeta.get(name)!, group }));
  }
}

/** Debug helper: dump every clip's channel count + whether audio tracks exist. */
export function describeClips(library: AssetLibrary): void {
  const rows = [...library.clips.entries()].map(([name, group]) => ({
    name,
    channels: group.targetedAnimations.length,
    fps: group.targetedAnimations[0]?.animation.framePerSecond ?? 0,
    type: group.targetedAnimations[0]?.animation.dataType,
  }));
  console.table(rows);
}
