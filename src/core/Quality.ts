/**
 * Device tier detection. The pack is dense (56k-tri hero, 4K source textures,
 * ~30 clips), so on a mid-range Android we want fewer pixels, no shadows and
 * no post-processing rather than a slideshow.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';

export type QualityTier = 'low' | 'medium' | 'high';

export interface DeviceProfile {
  tier: QualityTier;
  mobile: boolean;
  cores: number;
  devicePixelRatio: number;
  maxTextureSize: number;
  renderer: string;
}

const ORDER: QualityTier[] = ['low', 'medium', 'high'];

export function parseTierOverride(search = globalThis.location?.search ?? ''): QualityTier | null {
  const q = new URLSearchParams(search).get('q') ?? new URLSearchParams(search).get('quality');
  return q && ORDER.includes(q as QualityTier) ? (q as QualityTier) : null;
}

export function detectProfile(engine: AbstractEngine): DeviceProfile {
  const ua = globalThis.navigator?.userAgent ?? '';
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  const devicePixelRatio = globalThis.devicePixelRatio || 1;
  const caps = engine.getCaps();
  const maxTextureSize = caps?.maxTextureSize ?? 2048;
  const mobile = /android|iphone|ipad|ipod|mobile|silk/i.test(ua) || (cores <= 4 && /mac os x|windows/i.test(ua) === false);

  let gl: WebGLRenderingContext | null = null;
  try {
    gl = (engine as unknown as { _gl?: WebGLRenderingContext })._gl ?? null;
  } catch {
    gl = null;
  }
  let renderer = '';
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  }

  let tier: QualityTier;
  const override = parseTierOverride();

  if (mobile) {
    tier = cores >= 8 && maxTextureSize >= 8192 ? 'medium' : 'low';
  } else if (cores >= 8 && maxTextureSize >= 8192) {
    tier = 'high';
  } else if (cores >= 4) {
    tier = 'medium';
  } else {
    tier = 'low';
  }

  // Weak integrated GPUs: pull the tier down a notch.
  if (/intel|uhd|iris|mali-4|mali-t|adreno \(tm\) 3|powervr/i.test(renderer) && tier === 'high') tier = 'medium';

  return {
    tier: override ?? tier,
    mobile,
    cores,
    devicePixelRatio,
    maxTextureSize,
    renderer,
  };
}

export function tierIndex(tier: QualityTier): number {
  return ORDER.indexOf(tier);
}

export function nextTier(tier: QualityTier, delta: number): QualityTier {
  const i = Math.min(ORDER.length - 1, Math.max(0, tierIndex(tier) + delta));
  return ORDER[i];
}
