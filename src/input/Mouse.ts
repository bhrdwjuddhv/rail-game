export interface MouseHandler {
  drag(dx: number, dy: number): void;
  /** click without dragging; returns true if something was activated */
  press(x: number, y: number, button: number): void;
  release(button: number): void;
  wheel(dy: number, x: number, y: number): void;
  hover(x: number, y: number): void;
}

/**
 * Mouse on the canvas: drag (left or right button) to look/orbit, click to use
 * cab controls, wheel to zoom or adjust the control under the cursor.
 */
export class Mouse {
  private downAt: { x: number; y: number; button: number } | null = null;
  private dragging = false;
  private pressedButton = -1;
  enabled = true;

  constructor(private el: HTMLElement, private h: MouseHandler) {
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  private rel(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.downAt = { x: e.clientX, y: e.clientY, button: e.button };
    this.dragging = false;
    // controls respond on press (so horn/sander can be held)
    const p = this.rel(e);
    this.pressedButton = e.button;
    this.h.press(p.x, p.y, e.button);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    if (this.downAt) {
      const dx = e.movementX, dy = e.movementY;
      if (!this.dragging && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4) this.dragging = true;
      if (this.dragging) this.h.drag(dx, dy);
    } else {
      const p = this.rel(e);
      this.h.hover(p.x, p.y);
    }
  };

  private onUp = (_e: PointerEvent) => {
    if (this.pressedButton >= 0) this.h.release(this.pressedButton);
    this.pressedButton = -1;
    this.downAt = null;
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const p = this.rel(e);
    this.h.wheel(e.deltaY, p.x, p.y);
  };
}
