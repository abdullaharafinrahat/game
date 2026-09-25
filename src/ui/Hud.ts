/**
 * All menu/HUD plumbing in one place.
 *
 * The overlay is plain DOM rather than Babylon GUI: it costs no draw calls,
 * stays crisp on any DPR, is trivially responsive for the touch layout, and
 * keeps the game code free of UI nodes.
 */
import type { QualityTier } from '../core/Quality';

export interface HudCallbacks {
  onPlay(): void;
  onResume(): void;
  onQuality(tier: QualityTier): void;
  onSensitivity(value: number): void;
  onVolume(value: number): void;
  onInvertY(value: boolean): void;
  onDebugToggle(value: boolean): void;
}

export interface StartInfo {
  tier: QualityTier;
  mobile: boolean;
  cores: number;
  renderer: string;
  triangles: number;
  clips: number;
  megabytes: number;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD element #${id} is missing from index.html`);
  return node as T;
}

export class Hud {
  private loading = el('loading');
  private loadingBar = el('loadingBar');
  private loadingLabel = el('loadingLabel');
  private loadingDetail = el('loadingDetail');
  private start = el('start');
  private startStats = el('startStats');
  private touchHint = el('touchHint');
  private pause = el('pause');
  private error = el('error');
  private errorText = el('errorText');
  private hud = el('hud');
  private fps = el('fps');
  private stance = el('stance');
  private speed = el('speed');
  private ammoMag = el('ammoMag');
  private ammoReserve = el('ammoReserve');
  private reloadHint = el('reloadHint');
  private healthFill = el('healthFill');
  private vignette = el('damageVignette');
  private crosshair = el('crosshair');
  private hitmarker = el('hitmarker');
  private toastEl = el('toast');
  private debug = el('debug');
  private pauseStats = el('pauseStats');
  private sensInput = el<HTMLInputElement>('sensInput');
  private sensOut = el('sensOut');
  private volInput = el<HTMLInputElement>('volInput');
  private volOut = el('volOut');
  private invertInput = el<HTMLInputElement>('invertInput');
  private debugInput = el<HTMLInputElement>('debugInput');

  private toastTimer = 0;
  private bloom = 0;
  private spread = 9;
  private damageTimer = 0;

  constructor(callbacks: HudCallbacks) {
    el('playBtn').addEventListener('click', () => callbacks.onPlay());
    el('resumeBtn').addEventListener('click', () => callbacks.onResume());
    el('pauseBtn').addEventListener('click', () => callbacks.onDebugToggle(this.debugInput.checked));

    for (const button of document.querySelectorAll<HTMLButtonElement>('#qualityBtns button')) {
      button.addEventListener('click', () => callbacks.onQuality(button.dataset.tier as QualityTier));
    }

    this.sensInput.addEventListener('input', () => {
      const value = Number(this.sensInput.value);
      this.sensOut.textContent = value.toFixed(2);
      callbacks.onSensitivity(value);
    });
    this.volInput.addEventListener('input', () => {
      const value = Number(this.volInput.value);
      this.volOut.textContent = `${Math.round(value * 100)}%`;
      callbacks.onVolume(value);
    });
    this.invertInput.addEventListener('change', () => callbacks.onInvertY(this.invertInput.checked));
    this.debugInput.addEventListener('change', () => callbacks.onDebugToggle(this.debugInput.checked));
  }

  // --- Loading ------------------------------------------------------------
  setLoading(ratio: number, label: string, detail = ''): void {
    this.loadingBar.style.width = `${Math.round(ratio * 100)}%`;
    this.loadingLabel.textContent = label;
    this.loadingDetail.textContent = detail;
  }

  hideLoading(): void {
    this.loading.classList.add('hidden');
  }

  showStart(info: StartInfo): void {
    this.startStats.textContent =
      `${info.triangles.toLocaleString()} triangles · ${info.clips} clips · ${info.megabytes.toFixed(1)} MB payload · ` +
      `${info.cores} cores · ${info.tier} quality${info.renderer ? ` · ${info.renderer.slice(0, 42)}` : ''}`;
    this.touchHint.classList.toggle('hidden', !info.mobile);
    this.start.classList.remove('hidden');
  }

  hideStart(): void {
    this.start.classList.add('hidden');
    this.hud.classList.remove('hidden');
  }

  showError(message: string): void {
    this.loading.classList.add('hidden');
    this.start.classList.add('hidden');
    this.errorText.textContent = message;
    this.error.classList.remove('hidden');
  }

  // --- Gameplay -----------------------------------------------------------
  setAmmo(mag: number, reserve: number): void {
    // Non-finite values (unlimited ammo) render as ∞.
    this.ammoMag.textContent = Number.isFinite(mag) ? String(mag) : '∞';
    this.ammoReserve.textContent = Number.isFinite(reserve) ? `/ ${reserve}` : '/ ∞';
    this.ammoMag.style.color = mag === 0 ? 'var(--danger)' : 'var(--text)';
  }

  setReloading(reloading: boolean): void {
    this.reloadHint.classList.toggle('hidden', !reloading);
  }

  setHealth(health: number, max: number): void {
    const ratio = Math.max(0, Math.min(1, health / max));
    this.healthFill.style.width = `${ratio * 100}%`;
    this.healthFill.style.background =
      ratio > 0.55 ? 'linear-gradient(90deg, var(--ok), #b8e986)' : ratio > 0.25 ? 'linear-gradient(90deg,#ffcc4d,#ffb347)' : 'linear-gradient(90deg,#ff5c47,#ff8a6b)';
  }

  setStance(text: string): void {
    this.stance.textContent = text;
  }

  setFps(value: number): void {
    this.fps.textContent = `${value.toFixed(0)} fps`;
  }

  setSpeed(speed: number): void {
    this.speed.textContent = `${speed.toFixed(1)} m/s`;
  }

  hitMarker(killing: boolean): void {
    this.hitmarker.classList.add('show');
    this.hitmarker.classList.toggle('kill', killing);
    window.setTimeout(() => this.hitmarker.classList.remove('show'), 110);
  }

  addBloom(amount: number): void {
    this.bloom = Math.min(34, this.bloom + amount);
  }

  damageFlash(): void {
    this.damageTimer = 0.6;
    this.vignette.style.opacity = '1';
  }

  toast(message: string, ms = 1800): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.remove('hidden');
    this.toastTimer = ms / 1000;
  }

  setPaused(paused: boolean): void {
    this.pause.classList.toggle('hidden', !paused);
  }

  setQuality(tier: QualityTier): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#qualityBtns button')) {
      button.classList.toggle('active', button.dataset.tier === tier);
    }
  }

  setPauseStats(text: string): void {
    this.pauseStats.textContent = text;
  }

  setDebug(text: string | null): void {
    if (!text) {
      this.debug.classList.add('hidden');
      return;
    }
    this.debug.classList.remove('hidden');
    this.debug.textContent = text;
  }

  get debugEnabled(): boolean {
    return !this.debug.classList.contains('hidden');
  }

  setDebugCheckbox(value: boolean): void {
    this.debugInput.checked = value;
  }

  setInvert(value: boolean): void {
    this.invertInput.checked = value;
  }

  setSensitivity(value: number): void {
    this.sensInput.value = String(value);
    this.sensOut.textContent = value.toFixed(2);
  }

  /** Smoothly relaxes crosshair bloom, and fades the damage vignette. */
  update(dt: number, moving: boolean): void {
    this.bloom = Math.max(0, this.bloom - dt * 42);
    const target = 9 + this.bloom + (moving ? 6 : 0);
    this.spread += (target - this.spread) * Math.min(1, dt * 12);
    this.crosshair.style.setProperty('--spread', `${this.spread.toFixed(2)}px`);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.add('hidden');
    }
    if (this.damageTimer > 0) {
      this.damageTimer -= dt;
      if (this.damageTimer <= 0) this.vignette.style.opacity = '0';
    }
  }
}
