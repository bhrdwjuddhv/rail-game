import { h } from './dom';

// Side view in a 48x48 box: roof line, base pivot A, a Z arm (lower arm A->knee,
// upper arm knee->head) and the pan head under the contact wire at y = 8.
const A = { x: 10, y: 37 };
const L1 = 26, L2 = 14.1;
const HEAD_X = 22, HEAD_DOWN = 33, HEAD_UP = 9.5;
const RING = 2 * Math.PI * 22;

/** Knee of the two-link arm for a pan head at height y (always the right-hand solution: folds flat when down). */
function knee(hx: number, hy: number) {
  const dx = hx - A.x, dy = hy - A.y, d = Math.hypot(dx, dy);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const k = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const px = A.x + (a * dx) / d, py = A.y + (a * dy) / d;
  return { x: px + k * (-dy / d), y: py + k * (dx / d) };
}

/**
 * Pantograph button: an original pantograph drawing whose arm unfolds until the
 * pan head meets the wire, a progress ring for the travel, and an LED (grey
 * down, blinking amber moving, green up). It is driven by the loco's own
 * pantograph position (the same value the 3D model uses), so both always match.
 */
export class PantographButton {
  readonly el: HTMLButtonElement;
  private lower: SVGLineElement;
  private upper: SVGLineElement;
  private head: SVGGElement;
  private ring: SVGCircleElement;
  private pos = -1;
  private state = '';
  /** true while the pantograph travels: taps are ignored so it cannot be double-toggled */
  moving = false;
  /** called once when the pantograph finishes travelling (true = up and touching) */
  onSettled?: (up: boolean) => void;

  constructor(onTap: () => void) {
    this.el = h('button', 'm-btn m-panto', `
      <svg class="m-pt-ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="${RING.toFixed(2)}"/></svg>
      <svg class="m-pt-icon" viewBox="0 0 48 48" aria-hidden="true">
        <line class="wire" x1="3" y1="8" x2="45" y2="8"/>
        <line class="roof" x1="4" y1="41" x2="44" y2="41"/>
        <rect class="base" x="6" y="37" width="12" height="4" rx="1"/>
        <line class="arm lower" x1="${A.x}" y1="${A.y}" x2="0" y2="0"/>
        <line class="arm upper" x1="0" y1="0" x2="0" y2="0"/>
        <g class="head"><path d="M-10 0h20M-12 -2.5l2 2.5M12 -2.5l-2 2.5"/></g>
        <path class="spark" d="M22 8l-3-4M22 8l3-4M22 8l-4 0M22 8l4 0M22 8l0-5"/>
      </svg><i class="led"></i>`) as HTMLButtonElement;
    this.el.dataset.tid = 'panto';
    this.el.setAttribute('aria-label', 'Pantograph');
    this.lower = this.el.querySelector('.lower')!;
    this.upper = this.el.querySelector('.upper')!;
    this.head = this.el.querySelector('.head')!;
    this.ring = this.el.querySelector('.m-pt-ring circle')!;
    this.el.addEventListener('click', e => {
      e.stopPropagation();
      if (!this.moving) onTap();
    });
    this.draw(0);
  }

  private draw(p: number) {
    const hy = HEAD_DOWN + (HEAD_UP - HEAD_DOWN) * p;
    const k = knee(HEAD_X, hy);
    this.lower.setAttribute('x2', k.x.toFixed(2)); this.lower.setAttribute('y2', k.y.toFixed(2));
    this.upper.setAttribute('x1', k.x.toFixed(2)); this.upper.setAttribute('y1', k.y.toFixed(2));
    this.upper.setAttribute('x2', String(HEAD_X)); this.upper.setAttribute('y2', hy.toFixed(2));
    this.head.setAttribute('transform', `translate(${HEAD_X} ${hy.toFixed(2)})`);
  }

  /**
   * @param pos 0 down .. 1 touching the wire
   * @param up switch position (where it is heading)
   */
  update(pos: number, up: boolean) {
    const moving = up ? pos < 0.999 : pos > 0.001;
    if (Math.abs(pos - this.pos) > 0.002 || (pos !== this.pos && !moving)) {
      this.pos = pos;
      this.draw(pos);
      // ring fills over the travel, in either direction
      const progress = moving ? (up ? pos : 1 - pos) : 0;
      this.ring.setAttribute('stroke-dashoffset', (RING * (1 - progress)).toFixed(2));
    }
    const state = moving ? 'moving' : up ? 'up' : 'down';
    if (state !== this.state) {
      if (this.state === 'moving' && state === 'up') {
        // contact: a brief spark where the head meets the wire
        this.el.classList.remove('spark-on');
        void this.el.getBoundingClientRect();
        this.el.classList.add('spark-on');
      }
      this.el.classList.toggle('moving', moving);
      this.el.classList.toggle('on', state === 'up');
      if (this.state === 'moving') this.onSettled?.(state === 'up');
      this.state = state;
    }
    this.moving = moving;
  }
}
