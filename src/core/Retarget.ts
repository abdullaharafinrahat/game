/**
 * Clip retargeting.
 *
 * The pack ships the 27 animation clips as *bare skeletons*: each GLB contains
 * an `Armature` node tree (65 joints named `mixamorig7:*`) plus one Mixamo clip,
 * and no mesh at all. The hero character ships with the same skeleton and no
 * clips. So the job here is: keep only the keyframe data, point it at the real
 * character's joints, and throw the clip's own skeleton away.
 *
 * Two corrections are applied while retargeting:
 *
 *  1. Root motion strip. Mixamo bakes travel into the Hips translation track
 *     (Sprint drifts 3.45 m per cycle). Gameplay code owns the transform, so the
 *     two horizontal axes are pinned to the clip's first key while the vertical
 *     axis is left alone so bobbing / jump arcs / collapsing still read.
 *     The pipeline detected the rig's export quirks for us: these rigs are
 *     Blender Z-up exports, so "vertical" is NOT always Y (see manifest upAxis).
 *
 *  2. Loop phase alignment is the caller's job (see AnimationController): all
 *     locomotion clips get started together so their phases line up.
 */
import { Animation } from '@babylonjs/core/Animations/animation';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

export interface RetargetOptions {
  name: string;
  loop: boolean;
  /** Vertical axis in the rig's armature space, from the asset manifest. */
  upAxis: 'x' | 'y' | 'z';
  /** Pin horizontal Hips travel to the first keyframe. Default: true. */
  stripRootMotion?: boolean;
}

export interface RetargetReport {
  name: string;
  channels: number;
  dropped: string[];
  rootMotionStripped: boolean;
}

/** Vector3 / Vector4 / plain array — the glTF loader gives us the first two. */
function getComponent(value: unknown, axis: number): number {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return (value as ArrayLike<number>)[axis];
  const v = value as Record<string, number>;
  return axis === 0 ? v.x : axis === 1 ? v.y : v.z;
}

function setComponent(value: unknown, axis: number, next: number): void {
  if (Array.isArray(value)) {
    (value as number[])[axis] = next;
    return;
  }
  if (ArrayBuffer.isView(value)) {
    (value as Float32Array)[axis] = next;
    return;
  }
  const v = value as Record<string, number>;
  if (axis === 0) v.x = next;
  else if (axis === 1) v.y = next;
  else v.z = next;
}

/**
 * Pins the two horizontal components of a Hips translation track to the value
 * they hold on the first key, leaving the vertical axis free.
 */
function stripHorizontalTravel(animation: Animation, upAxis: number): boolean {
  const keys = animation.getKeys();
  if (keys.length < 2) return false;
  const first = keys[0].value;
  const pinned = [0, 1, 2].filter((axis) => axis !== upAxis).map((axis) => getComponent(first, axis));
  const horizontal = [0, 1, 2].filter((axis) => axis !== upAxis);

  let changed = false;
  for (const key of keys) {
    horizontal.forEach((axis, i) => {
      if (getComponent(key.value, axis) !== pinned[i]) {
        setComponent(key.value, axis, pinned[i]);
        changed = true;
      }
    });
  }
  return changed;
}

/**
 * Builds a scene-owned AnimationGroup for one clip file, retargeted onto the
 * character's bones. The source container is disposable afterwards.
 */
export function retargetClip(
  scene: Scene,
  container: AssetContainer,
  boneMap: Map<string, TransformNode>,
  options: RetargetOptions,
): { group: AnimationGroup | null; report: RetargetReport } {
  const source = container.animationGroups[0];
  const report: RetargetReport = { name: options.name, channels: 0, dropped: [], rootMotionStripped: false };
  if (!source) return { group: null, report };

  // NOTE: the third constructor argument of AnimationGroup is its WEIGHT
  // (default -1 = unweighted). Passing 0 here created every group with weight
  // 0, and Babylon treats weight-0 animatables as actively paused — they write
  // nothing. Locomotion clips survived because AnimationController re-assigns
  // `group.weight` every frame, but the one-shot overrides (FireRifle, Reload)
  // never had their group weight set, so they played at weight 0 and were
  // invisible. Leave the default in place; AnimationController owns weights.
  const group = new AnimationGroup(options.name, scene);

  group.loopAnimation = options.loop;
  const upAxis = AXIS_INDEX[options.upAxis];

  for (const targeted of source.targetedAnimations) {
    const boneName = targeted.target?.name;
    // Mixamo bone names are `mixamorig7:Hips`; the character has the same set.
    const node = boneName ? boneMap.get(boneName) : undefined;
    if (!node || !boneName) {
      if (boneName) report.dropped.push(boneName);
      continue;
    }

    const animation = targeted.animation.clone();
    const isHipsTranslation = targeted.animation.targetProperty === 'position' && /Hips$/i.test(boneName);
    if (isHipsTranslation && (options.stripRootMotion ?? true)) {
      report.rootMotionStripped = stripHorizontalTravel(animation, upAxis) || report.rootMotionStripped;
    }

    group.addTargetedAnimation(animation, node);
    report.channels++;
  }

  report.dropped = [...new Set(report.dropped)];
  if (!report.channels) {
    group.dispose();
    return { group: null, report };
  }
  return { group, report };
}
