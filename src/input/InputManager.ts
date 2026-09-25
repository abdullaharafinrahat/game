/**
 * One input state for every device.
 *
 * Desktop (pointer lock + WASD), touch (virtual sticks, wired up in
 * TouchControls) and the on-screen buttons all write into the same object, so
 * gameplay code never branches on platform. Stance flags are "held" on
 * keyboard/mouse and mostly "toggled" on touch, which is why they are stored
 * per-source and merged in poll().
 */
import { KEYBINDS } from '../config';

export interface InputState {
  /** Local-space move intent, -1..1. `moveY` is forward. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  crouch: boolean;
  jumpHeld: boolean;
  fireHeld: boolean;
  /** Aiming down sights — hold RMB on desktop, toggle on touch. */
  aim: boolean;
  /** Edge-triggered flags, cleared at the end of every frame. */
  jumpPressed: boolean;
  firePressed: boolean;
  reloadPressed: boolean;
  /** Draw/sheathe request (KeyX or the touch GUN button). */
  stancePressed: boolean;
}

export interface InputCallbacks {
  onTogglePause(): void;
  onCycleQuality(delta: number): void;
  onZoom(delta: number): void;
  onPointerLockChange(locked: boolean): void;
}

const asArray = (codes: readonly string[]): readonly string[] => codes;

export class InputManager {
  readonly state: InputState = {
    moveX: 0,
    moveY: 0,
    sprint: false,
    crouch: false,
    jumpHeld: false,
    fireHeld: false,
    aim: false,
    jumpPressed: false,
    firePressed: false,
    reloadPressed: false,
    stancePressed: false,
  };

  /** Look deltas in pixels, consumed once per frame by the camera. */
  private lookX = 0;
  private lookY = 0;
  private keys = new Set<string>();
  private locked = false;
  private disposers: (() => void)[] = [];

  /** Touch-sourced hold flags, merged with the keyboard in poll(). */
  private touch = { moveX: 0, moveY: 0, active: false, sprint: false, crouch: false, jump: false };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: InputCallbacks,
  ) {}

  attach(): void {
    const on = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(type, handler, options);
      this.disposers.push(() => target.removeEventListener(type, handler, options));
    };

    on(window, 'keydown', (ev) => this.onKeyDown(ev as KeyboardEvent));
    on(window, 'keyup', (ev) => this.keys.delete((ev as KeyboardEvent).code));
    on(window, 'blur', () => this.releaseAll());

    on(this.canvas, 'pointerdown', (ev) => this.onPointerDown(ev as PointerEvent));
    on(window, 'pointerup', (ev) => this.onPointerUp(ev as PointerEvent));
    on(window, 'pointermove', (ev) => this.onPointerMove(ev as PointerEvent));
    on(this.canvas, 'contextmenu', (ev) => ev.preventDefault());
    on(
      this.canvas,
      'wheel',
      (ev) => {
        const wheel = ev as WheelEvent;
        wheel.preventDefault();
        this.callbacks.onZoom(Math.sign(wheel.deltaY) * 0.45);
      },
      { passive: false },
    );

    on(document, 'pointerlockchange', () => this.syncLock());
    on(document, 'pointerlockerror', () => this.syncLock());
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  requestPointerLock(): void {
    if (!this.locked) void this.canvas.requestPointerLock?.();
  }

  exitPointerLock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  // --- TouchControls API --------------------------------------------------

  setTouchMove(x: number, y: number): void {
    this.touch.moveX = x;
    this.touch.moveY = y;
    this.touch.active = true;
  }

  clearTouchMove(): void {
    this.touch.moveX = 0;
    this.touch.moveY = 0;
    this.touch.active = false;
  }

  setTouchFire(down: boolean): void {
    if (down && !this.state.fireHeld) this.state.firePressed = true;
    this.state.fireHeld = down;
  }

  setTouchSprint(down: boolean): void {
    this.touch.sprint = down;
  }

  setTouchCrouch(toggle: boolean | undefined): void {
    this.touch.crouch = toggle ?? !this.touch.crouch;
  }

  setTouchJump(down: boolean): void {
    if (down) this.pressJump();
    this.touch.jump = down;
  }

  addLook(dx: number, dy: number): void {
    this.lookX += dx;
    this.lookY += dy;
  }

  pressJump(): void {
    this.state.jumpPressed = true;
    this.state.jumpHeld = true;
  }

  pressReload(): void {
    this.state.reloadPressed = true;
  }

  /** Draw/sheathe request from the touch GUN button. */
  pressStance(): void {
    this.state.stancePressed = true;
  }

  toggleAim(on?: boolean): void {
    this.state.aim = on ?? !this.state.aim;
  }

  consumeLook(): { x: number; y: number } {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  endFrame(): void {
    this.state.jumpPressed = false;
    this.state.firePressed = false;
    this.state.reloadPressed = false;
    this.state.stancePressed = false;
  }

  /** Merges keyboard + touch into the single state object. */
  poll(): InputState {
    const held = (codes: readonly string[]) => codes.some((code) => this.keys.has(code));

    let mx = 0;
    let my = 0;
    if (held(asArray(KEYBINDS.forward))) my += 1;
    if (held(asArray(KEYBINDS.back))) my -= 1;
    if (held(asArray(KEYBINDS.right))) mx += 1;
    if (held(asArray(KEYBINDS.left))) mx -= 1;

    if (mx === 0 && my === 0 && this.touch.active) {
      mx = this.touch.moveX;
      my = this.touch.moveY;
    }

    const length = Math.hypot(mx, my);
    if (length > 1) {
      mx /= length;
      my /= length;
    }

    this.state.moveX = mx;
    this.state.moveY = my;
    this.state.sprint = held(asArray(KEYBINDS.sprint)) || this.touch.sprint;
    this.state.crouch = held(asArray(KEYBINDS.crouch)) || this.touch.crouch;
    this.state.jumpHeld = held(asArray(KEYBINDS.jump)) || this.touch.jump;
    return this.state;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.state.fireHeld = false;
    this.state.jumpHeld = false;
    this.touch.sprint = false;
    this.touch.jump = false;
    this.clearTouchMove();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.repeat) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    this.keys.add(ev.code);

    if (KEYBINDS.jump.includes(ev.code as never)) {
      this.pressJump();
      ev.preventDefault();
    } else if (KEYBINDS.reload.includes(ev.code as never)) {
      this.pressReload();
    } else if (KEYBINDS.stance.includes(ev.code as never)) {
      this.pressStance();
    } else if (KEYBINDS.quality.includes(ev.code as never)) {
      this.callbacks.onCycleQuality(ev.shiftKey ? -1 : 1);
    } else if (ev.code === 'Escape' || ev.code === 'KeyP') {
      this.callbacks.onTogglePause();
    }
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.pointerType === 'touch') return; // handled by TouchControls
    if (ev.button === 0) {
      this.state.firePressed = true;
      this.state.fireHeld = true;
    } else if (ev.button === 2) {
      this.toggleAim(true);
    }
    if (!this.locked) this.requestPointerLock();
  }

  private onPointerUp(ev: PointerEvent): void {
    if (ev.pointerType === 'touch') return;
    if (ev.button === 0) this.state.fireHeld = false;
    if (ev.button === 2) this.toggleAim(false);
  }

  private onPointerMove(ev: PointerEvent): void {
    if (ev.pointerType === 'touch' || !this.locked) return;
    this.addLook(ev.movementX ?? 0, ev.movementY ?? 0);
  }

  private syncLock(): void {
    const locked = document.pointerLockElement === this.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    // Losing the lock (Esc, alt-tab) must not leave keys stuck down.
    if (!locked) this.releaseAll();
    this.callbacks.onPointerLockChange(locked);
  }
}
