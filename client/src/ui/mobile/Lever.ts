import { buzz } from '../../input/Device';
import { h, setText } from './dom';

/**
 * A vertical cab lever: chunky metal handle in a slotted track, a thin fill
 * bar for the current level and a label underneath. Snaps to whole steps
 * (with a light vibration per step). Tracks its own pointer, so it can be held
 * while other fingers use other controls.
 */
export class Lever {
  readonly el: HTMLElement;
  private handle: HTMLElement;
  private value = -1;
  private pointer = -1;
  /** last step sent during this drag (the shown value lags by up to one HUD update) */
  private dragV = -1;

  /**
   * @param upIsMore throttle: up = more; brake: top = release, pulled down = applied
   * @param set called with the snapped step while dragging
   * @param fmt text on the handle for a step
   */
  constructor(label: string, tid: string, private upIsMore: boolean, private max: number, private set: (v: number) => void, private fmt: (v: number) => string) {
    this.el = h('div', `m-lever m-lever-${tid}`, `
      <div class="m-lv-track"><div class="m-lv-slot"></div><div class="m-lv-fill"></div>
        <div class="m-lv-handle"><i></i><i></i><i></i><span></span></div></div>
      <label>${label}</label>`);
    this.el.dataset.tid = tid;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', label);
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', String(max));
    this.handle = this.el.querySelector('.m-lv-handle')!;
    const track = this.el.querySelector<HTMLElement>('.m-lv-track')!;
    const stepAt = (y: number) => {
      const r = track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (y - r.top) / r.height));
      return Math.round((upIsMore ? 1 - f : f) * max);
    };
    const drag = (y: number) => {
      const v = stepAt(y);
      if (v === this.dragV) return;
      this.dragV = v;
      this.set(v);
      this.show(v); // follow the finger now, not at the next HUD update
      buzz();
    };
    this.el.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      this.pointer = e.pointerId;
      this.el.setPointerCapture(e.pointerId);
      this.el.classList.add('active');
      this.dragV = this.value;
      drag(e.clientY);
    });
    this.el.addEventListener('pointermove', e => { if (e.pointerId === this.pointer) { e.preventDefault(); drag(e.clientY); } });
    const end = (e: PointerEvent) => { if (e.pointerId === this.pointer) { this.pointer = -1; this.el.classList.remove('active'); } };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  /** Show the train's actual position (it can also move by keyboard, auto-drive or the tutorial). */
  show(v: number) {
    if (v === this.value) return;
    this.value = v;
    const f = Math.min(1, Math.max(0, v / this.max));
    // fraction of travel from the top of the track
    const top = this.upIsMore ? 1 - f : f;
    this.el.style.setProperty('--pos', top.toFixed(4));
    this.el.style.setProperty('--level', f.toFixed(4));
    setText(this.handle.querySelector('span')!, this.fmt(v));
    this.el.setAttribute('aria-valuenow', String(v));
  }
}
