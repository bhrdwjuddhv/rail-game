export interface MouseHandler {
  drag(dx: number, dy: number): void;
  /** click without dragging; returns true if something was activated */
  press(x: number, y: number, button: number): void;
  release(button: number): void;
  wheel(dy: number, x: number, y: number): void;
  hover(x: number, y: number): void;
}

interface Pt { x: number; y: number; sx: number; sy: number }

/**
 * Pointer input on the canvas (mouse and touch). Drag (left or right button,
 * or one finger) to look/orbit, click/tap to use cab controls, wheel or
 * two-finger pinch to zoom or adjust the control under the cursor. Each
 * pointer is tracked by id and only pointers that went down on the canvas
 * count, so a thumb on an on-screen slider never moves the camera.
 */
export class Mouse {
  private pts = new Map<number, Pt>();
  private dragging = false;
  private pressedButton = -1;
  private pinchD = 0;
  enabled = true;

  constructor(private el: HTMLElement, private h: MouseHandler) {
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  private rel(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  }

  private pinchDistance() {
    const [a, b] = [...this.pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (this.pts.size === 1) {
      this.dragging = false;
      // controls respond on press (so horn/sander can be held)
      const p = this.rel(e);
      this.pressedButton = e.button;
      this.h.press(p.x, p.y, e.button);
    } else {
      // a second finger: this is a pinch, not a control press
      if (this.pressedButton >= 0) { this.h.release(this.pressedButton); this.pressedButton = -1; }
      this.pinchD = this.pinchDistance();
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    const p = this.pts.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && this.pts.size === 0) { const r = this.rel(e); this.h.hover(r.x, r.y); }
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pts.size >= 2) {
      const d = this.pinchDistance();
      const c = this.rel({ clientX: e.clientX, clientY: e.clientY });
      // fingers apart = zoom in (negative wheel)
      if (this.pinchD > 0) this.h.wheel((this.pinchD - d) * 4, c.x, c.y);
      this.pinchD = d;
      return;
    }
    if (!this.dragging && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > (e.pointerType === 'touch' ? 8 : 4)) this.dragging = true;
    if (this.dragging) this.h.drag(dx, dy);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pts.delete(e.pointerId)) return;
    if (this.pts.size === 0) {
      if (this.pressedButton >= 0) this.h.release(this.pressedButton);
      this.pressedButton = -1;
      this.dragging = false;
    }
    if (this.pts.size < 2) this.pinchD = 0;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const p = this.rel(e);
    this.h.wheel(e.deltaY, p.x, p.y);
  };
}
