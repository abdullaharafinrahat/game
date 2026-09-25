/**
 * Weighted animation blending for the Mixamo clip set.
 *
 * The pack gives us full-body clips only (no upper/lower body split), so the
 * approach is:
 *
 *   - Locomotion clips (idle/walk/run/sprint, armed or unarmed) all run at the
 *     same time and are blended by weight, driven by actual movement speed.
 *     Their phases are synchronised so the feet do not pop between them.
 *   - One-shot actions (fire, reload, jump, stance change) fade in as overlays
 *     and suppress the locomotion weights while they play, then release them.
 *
 * Weights are ramped here rather than with `AnimationGroup.start(... blending)`
 * because we need them to react to speed every frame, not just on transitions.
 */
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';

import type { AssetLibrary } from '../core/Assets';

interface Layer {
  group: AnimationGroup;
  weight: number;
  target: number;
  /** Playback rate applied for foot matching. */
  speedRatio: number;
  active: boolean;
}

export interface OneShotOptions {
  /** Cap the clip (seconds). Defaults to the clip's own length. */
  maxDuration?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Playback rate, e.g. 1.3 to make a reload snappier. */
  speedRatio?: number;
  /** Keep the final pose after finishing (jump, death). */
  holdLastFrame?: boolean;
}

const LOCOMOTION_FADE = 0.16;

export class AnimationController {
  private layers = new Map<string, Layer>();
  private override: {
    name: string;
    elapsed: number;
    duration: number;
    fadeIn: number;
    fadeOut: number;
    hold: boolean;
    weight: number;
  } | null = null;
  private warnings: string[] = [];

  constructor(private readonly library: AssetLibrary) {}

  /** True when a clip of this name was loaded and retargeted. */
  has(name: string): boolean {
    return this.library.clips.has(name);
  }

  get currentOverride(): string | null {
    return this.override?.name ?? null;
  }

  get isBusy(): boolean {
    return this.override !== null;
  }

  /**
   * Blend weights (0..1) and playback rates for the locomotion clips.
   *
   * Every layer NOT named in `weights` is ramped back to zero first. Without
   * this, a clip that leaves the blend (walking -> sprinting drops Walk, and
   * RifleIdle when you start moving) keeps its old target of 1 forever: two
   * contradictory full-body clips then average into a mush that reads as "the
   * animation stopped", while each layer still reports weight 1 and isPlaying.
   */
  setLocomotion(weights: Record<string, number>, speedRatios: Record<string, number> = {}): void {
    for (const [name, layer] of this.layers) {
      if (!(name in weights)) layer.target = 0;
    }
    for (const [name, target] of Object.entries(weights)) {
      const layer = this.ensure(name);
      if (!layer) continue;
      layer.target = Math.max(0, Math.min(1, target));
      const ratio = speedRatios[name];
      if (ratio !== undefined && Number.isFinite(ratio)) {
        // Clamp so an accidental 0-speed ratio cannot freeze the feet mid-air.
        layer.speedRatio = Math.max(0.35, Math.min(2.2, ratio));
      }
    }
  }

  /**
   * Fades an action in, holds it, fades it out, then hands control back.
   * Returns the effective duration in seconds (0 if the clip is missing).
   */
  play(name: string, options: OneShotOptions = {}): number {
    const layer = this.ensure(name);
    if (!layer) return 0;

    const clip = this.library.clipMeta.get(name);
    const clipLength = clip?.duration ?? 1;
    const duration = Math.max(0.05, Math.min(options.maxDuration ?? clipLength, clipLength));

    layer.speedRatio = options.speedRatio ?? 1;
    layer.target = 0;
    // Restart from the top: these are non-looping actions.
    layer.group.stop();
    layer.group.loopAnimation = false;
    // `start()` re-stamps every animatable with the group's weight and resets
    // speedRatio to its second argument, so both must be (re)applied around the
    // start call — setting `group.speedRatio` before start() is discarded.
    layer.group.weight = 0; // fades in via update()
    layer.group.start(false, layer.speedRatio);
    layer.active = true;

    this.override = {
      name,
      elapsed: 0,
      duration,
      fadeIn: options.fadeIn ?? 0.07,
      fadeOut: options.fadeOut ?? Math.min(0.22, duration * 0.35),
      hold: options.holdLastFrame ?? false,
      weight: 0,
    };
    return duration;
  }

  /** Frees the overlay so locomotion can take over again (e.g. on interrupt). */
  cancelOverride(immediate = false): void {
    if (!this.override) return;
    const layer = this.layers.get(this.override.name);
    if (layer) {
      if (immediate) {
        layer.group.stop();
        layer.active = false;
        layer.weight = 0;
      } else {
        this.override.elapsed = Math.max(this.override.elapsed, this.override.duration - this.override.fadeOut);
      }
    } else {
      this.override = null;
    }
  }

  update(dt: number): void {
    // --- One-shot overlay -------------------------------------------------
    let overrideWeight = 0;
    if (this.override) {
      const o = this.override;
      o.elapsed += dt;
      const remaining = o.duration - o.elapsed;
      if (o.elapsed < o.fadeIn) overrideWeight = o.elapsed / o.fadeIn;
      else if (remaining <= o.fadeOut) overrideWeight = Math.max(0, remaining / o.fadeOut);
      else overrideWeight = 1;

      const layer = this.layers.get(o.name);
      if (layer) {
        layer.weight = overrideWeight;
        // The override's weight must reach the AnimationGroup itself. Groups are
        // retargeted with weight -1 by default and `start()` stamps that onto
        // every animatable; a weight-0 animatable is "actively paused" in
        // Babylon and writes nothing at all — which is exactly why FireRifle and
        // Reload used to be invisible. Feeding `group.weight` every frame also
        // makes fadeIn/fadeOut real cross-fades against the locomotion layers.
        layer.group.weight = overrideWeight;
        if (Math.abs(layer.group.speedRatio - layer.speedRatio) > 1e-3) layer.group.speedRatio = layer.speedRatio;
      }

      if (o.elapsed >= o.duration) {
        if (layer) {
          if (o.hold) {
            layer.group.pause();
            layer.weight = 0;
            layer.target = 0;
          } else {
            layer.group.stop();
            layer.active = false;
            layer.weight = 0;
          }
        }
        this.override = null;
        overrideWeight = 0;
      }
    }

    // --- Locomotion blend -------------------------------------------------
    const scale = 1 - overrideWeight;
    for (const [name, layer] of this.layers) {
      if (this.override && this.override.name === name) continue;

      const wants = layer.target * scale;
      const step = dt / LOCOMOTION_FADE;
      layer.weight += Math.max(-step, Math.min(step, wants - layer.weight));
      if (layer.weight < 0.001 && layer.target === 0 && layer.active) {
        layer.group.stop();
        layer.active = false;
        layer.weight = 0;
        continue;
      }
      if (layer.weight > 0.001 && !layer.active) {
        layer.group.loopAnimation = true;
        // Play every locomotion clip from the same phase so cycles line up as
        // they cross-fade, without tying their animatables together (see the
        // note on phase syncing above).
        layer.group.start(true);
        layer.active = true;
      }
      if (layer.active) {
        if (Math.abs(layer.group.speedRatio - layer.speedRatio) > 1e-3) layer.group.speedRatio = layer.speedRatio;
        layer.group.weight = layer.weight;
      }
    }
  }

  // NOTE: locomotion clips are deliberately NOT phase-synchronised.
  //
  // An earlier version called `syncAllAnimationsWith(master)` on every running
  // layer. That method takes a *source animatable* and ties the group's
  // animatables to it; because the caller re-ran it whenever a layer started,
  // the followers ended up linked to a stopped master and the whole blend
  // collapsed — the layers still reported weight 1 and `isPlaying: true`, but
  // the bones stopped moving. The clips have different cycle lengths (Walk
  // 1.03 s vs Sprint 0.52 s) and blending between them reads fine without
  // locking their phases.

  /** Drops every running clip back to the idle pose (respawn, death, reset). */
  resetTo(weights: Record<string, number>): void {
    this.override = null;
    for (const layer of this.layers.values()) {
      layer.group.stop();
      layer.weight = 0;
      layer.target = 0;
      layer.active = false;
    }
    this.setLocomotion(weights);
    this.update(0);
  }

  dispose(): void {
    for (const layer of this.layers.values()) layer.group.dispose();
    this.layers.clear();
  }

  get warningsRaised(): string[] {
    return this.warnings;
  }

  private ensure(name: string): Layer | null {
    const existing = this.layers.get(name);
    if (existing) return existing;

    const group = this.library.clips.get(name);
    if (!group) {
      if (!this.warnings.includes(name)) this.warnings.push(name);
      return null;
    }
    group.loopAnimation = true;
    const layer: Layer = { group, weight: 0, target: 0, speedRatio: 1, active: false };
    this.layers.set(name, layer);
    return layer;
  }
}
