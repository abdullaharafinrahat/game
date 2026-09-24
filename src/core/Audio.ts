/**
 * Procedural sound effects.
 *
 * The asset pack has no audio at all, and adding downloads for a gunshot would
 * cost more than the whole optimized character. Everything here is synthesised
 * with WebAudio at runtime: noise bursts for cracks and impacts, filtered
 * oscillators for the low thump. Zero bytes over the wire.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.7;

  /** Must be called from a user gesture (browsers block autoplay). */
  resume(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noise = this.buildNoise(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** Rifle shot: bright crack + body thump + tail. */
  gunshot(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const attenuation = 1 / (1 + distance * 0.02);

    const crack = ctx.createBufferSource();
    crack.buffer = this.noise;
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.value = 1750;
    crackFilter.Q.value = 0.8;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.0001, t);
    crackGain.gain.exponentialRampToValueAtTime(0.85 * attenuation, t + 0.004);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    crack.connect(crackFilter).connect(crackGain).connect(master);
    crack.start(t);
    crack.stop(t + 0.2);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(150, t);
    thump.frequency.exponentialRampToValueAtTime(52, t + 0.13);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.5 * attenuation, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    thump.connect(thumpGain).connect(master);
    thump.start(t);
    thump.stop(t + 0.2);
  }

  /** Magazine out, magazine in, bolt. */
  reload(): void {
    this.click(0, 900, 0.13, 0.05);
    this.click(0.35, 620, 0.16, 0.06);
    this.click(0.95, 1400, 0.1, 0.04);
    this.click(1.75, 1750, 0.12, 0.05);
  }

  /** Bullet hitting geometry: short, bright, slightly different every time. */
  impact(distance = 0, surface = 'default'): void {
    const freq = surface === 'metal' ? 2600 : surface === 'wood' ? 900 : 1500;
    this.click(0, freq * (0.85 + Math.random() * 0.3), 0.07, 0.06 / (1 + distance * 0.01));
  }

  explosion(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const attenuation = 1 / (1 + distance * 0.015);

    const boom = ctx.createBufferSource();
    boom.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9 * attenuation, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    boom.connect(filter).connect(gain).connect(master);
    boom.start(t);
    boom.stop(t + 0.8);
  }

  /** Footstep: a soft filtered tick. */
  footstep(sprinting = false): void {
    this.click(0, sprinting ? 420 : 300, 0.06, sprinting ? 0.09 : 0.05);
  }

  private click(delay: number, frequency: number, decay: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 1.6;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    source.connect(filter).connect(amp).connect(master);
    source.start(t);
    source.stop(t + decay + 0.05);
  }

  private buildNoise(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}
