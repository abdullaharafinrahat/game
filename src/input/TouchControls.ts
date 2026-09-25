/**
 * Mobile controls: a dynamic-thumb stick on the left, drag-to-look on the
 * right, and thumb buttons for fire / aim / jump / reload / sprint / crouch.
 *
 * Everything is plain DOM on top of the canvas so it costs no draw calls and
 * stays crisp at any DPR. Pointer events are tracked per pointerId so you can
 * move and aim at the same time.
 */
import type { InputManager } from './InputManager';

const STICK_RADIUS = 58;

export class TouchControls {
  private root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private lookZone: HTMLDivElement;
  private disposers: (() => void)[] = [];
  private movePointerId: number | null = null;
  private lookPointerId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookLast = { x: 0, y: 0 };
  private sprintLock = false;
  private crouchLock = false;

  constructor(container: HTMLElement, private readonly input: InputManager) {
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';
    this.root.innerHTML = `
      <div class="touch-stick" data-stick>
        <div class="touch-stick-base"></div>
        <div class="touch-stick-knob"></div>
      </div>
      <div class="touch-look" data-look></div>
      <div class="touch-buttons">
        <button class="touch-btn touch-btn-sm" data-act="stance" type="button">GUN</button>
        <button class="touch-btn touch-btn-sm" data-act="crouch" type="button">CROUCH</button>
        <button class="touch-btn touch-btn-sm" data-act="reload" type="button">RELOAD</button>
        <button class="touch-btn touch-btn-sm" data-act="sprint" type="button">SPRINT</button>
        <button class="touch-btn touch-btn-sm" data-act="aim" type="button">AIM</button>
        <button class="touch-btn touch-btn-sm" data-act="jump" type="button">JUMP</button>
        <button class="touch-btn touch-btn-fire" data-act="fire" type="button">FIRE</button>
      </div>
    `;
    container.appendChild(this.root);

    this.stickBase = this.root.querySelector<HTMLDivElement>('.touch-stick-base')!;
    this.stickKnob = this.root.querySelector<HTMLDivElement>('.touch-stick-knob')!;
    this.lookZone = this.root.querySelector<HTMLDivElement>('[data-look]')!;

    this.bind();
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
    if (!visible) {
      this.input.clearTouchMove();
      this.input.setTouchFire(false);
      this.input.setTouchSprint(false);
    }
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.root.remove();
  }

  private bind(): void {
    const stick = this.root.querySelector<HTMLDivElement>('[data-stick]')!;

    this.on(stick, 'pointerdown', (ev) => {
      ev.preventDefault();
      this.movePointerId = ev.pointerId;
      this.stickOrigin = { x: ev.clientX, y: ev.clientY };
      this.placeKnob(0, 0);
      stick.setPointerCapture(ev.pointerId);
      this.updateStick(ev.clientX, ev.clientY);
    });

    this.on(stick, 'pointermove', (ev) => {
      if (ev.pointerId !== this.movePointerId) return;
      this.updateStick(ev.clientX, ev.clientY);
    });

    const endMove = (ev: PointerEvent) => {
      if (ev.pointerId !== this.movePointerId) return;
      this.movePointerId = null;
      this.input.clearTouchMove();
      this.placeKnob(0, 0);
    };
    this.on(stick, 'pointerup', endMove);
    this.on(stick, 'pointercancel', endMove);

    // Look: drag anywhere on the right half.
    this.on(this.lookZone, 'pointerdown', (ev) => {
      if (ev.pointerType !== 'touch' && ev.pointerType !== 'pen') return;
      this.lookPointerId = ev.pointerId;
      this.lookLast = { x: ev.clientX, y: ev.clientY };
      this.lookZone.setPointerCapture(ev.pointerId);
    });
    this.on(this.lookZone, 'pointermove', (ev) => {
      if (ev.pointerId !== this.lookPointerId) return;
      this.input.addLook((ev.clientX - this.lookLast.x) * 1.5, (ev.clientY - this.lookLast.y) * 1.5);
      this.lookLast = { x: ev.clientX, y: ev.clientY };
    });
    const endLook = (ev: PointerEvent) => {
      if (ev.pointerId === this.lookPointerId) this.lookPointerId = null;
    };
    this.on(this.lookZone, 'pointerup', endLook);
    this.on(this.lookZone, 'pointercancel', endLook);

    // Buttons.
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.touch-btn')) {
      const action = button.dataset.act!;
      const down = (ev: PointerEvent) => {
        ev.preventDefault();
        button.classList.add('pressed');
        switch (action) {
          case 'fire':
            this.input.setTouchFire(true);
            break;
          case 'jump':
            this.input.setTouchJump(true);
            break;
          case 'reload':
            this.input.pressReload();
            break;
          case 'stance':
            this.input.pressStance();
            break;
          case 'aim':
            this.input.toggleAim();
            button.classList.toggle('active', this.input.state.aim);
            break;
          case 'sprint':
            this.sprintLock = !this.sprintLock;
            this.input.setTouchSprint(this.sprintLock);
            button.classList.toggle('active', this.sprintLock);
            break;
          case 'crouch':
            this.crouchLock = !this.crouchLock;
            this.input.setTouchCrouch(this.crouchLock);
            button.classList.toggle('active', this.crouchLock);
            break;
          default:
            break;
        }
      };
      const up = () => {
        button.classList.remove('pressed');
        if (action === 'fire') this.input.setTouchFire(false);
        if (action === 'jump') this.input.setTouchJump(false);
      };
      this.on(button, 'pointerdown', down);
      this.on(button, 'pointerup', up);
      this.on(button, 'pointercancel', up);
      this.on(button, 'pointerleave', up);
    }
  }

  private updateStick(clientX: number, clientY: number): void {
    const dx = clientX - this.stickOrigin.x;
    const dy = clientY - this.stickOrigin.y;
    const distance = Math.hypot(dx, dy);
    const clamped = Math.min(distance, STICK_RADIUS);
    const nx = distance > 0.0001 ? (dx / distance) * clamped : 0;
    const ny = distance > 0.0001 ? (dy / distance) * clamped : 0;
    this.placeKnob(nx, ny);

    this.input.setTouchMove(nx / STICK_RADIUS, -ny / STICK_RADIUS);

    // Push the stick to the rim to sprint — standard mobile FPS affordance.
    if (clamped > STICK_RADIUS * 0.92) this.input.setTouchSprint(true);
    else if (!this.sprintLock) this.input.setTouchSprint(false);
  }

  private placeKnob(offsetX: number, offsetY: number): void {
    const baseRect = this.stickBase.getBoundingClientRect();
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    this.stickKnob.style.left = `${baseRect.width / 2 + offsetX}px`;
    this.stickKnob.style.top = `${baseRect.height / 2 + offsetY}px`;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /** DOM glue; handler params are narrowed at the call sites. */
  private on(target: EventTarget, type: string, handler: (ev: any) => void, options?: AddEventListenerOptions): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.disposers.push(() => target.removeEventListener(type, listener, options));
  }
}
