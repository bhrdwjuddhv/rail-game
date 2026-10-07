import { VIGILANCE_GRACE } from '@rail/shared/train/LocoSystems';

const R = 30, RING = 2 * Math.PI * R;

/**
 * Vigilance ACKNOWLEDGE pop-up (desktop and touch): a big amber pulsing button
 * with a ring counting down the seconds left before the penalty brake. Tap or
 * click acknowledges (any throttle / brake movement does too, in LocoSystems).
 * After a penalty it asks the driver to stop, then tap to reset.
 * Desktop also shows the key. Placed centre-right, clear of the track ahead
 * (touch: above the bottom bar, near the right thumb).
 */
export class VigilancePopup {
  readonly el: HTMLButtonElement;
  private ring: SVGCircleElement;
  private label: HTMLElement;
  private sub: HTMLElement;
  private shown = '';
  private lastFrac = -1;

  constructor(parent: HTMLElement, key: () => string | null, onAck: () => void) {
    this.el = document.createElement('button');
    this.el.className = 'vig-pop';
    this.el.hidden = true;
    this.el.dataset.tid = 'vigilance';
    this.el.innerHTML = `
      <svg viewBox="0 0 72 72" aria-hidden="true"><circle class="vp-back" cx="36" cy="36" r="${R}"/><circle class="vp-ring" cx="36" cy="36" r="${R}" stroke-dasharray="${RING.toFixed(2)}"/></svg>
      <b class="vp-label">ACKNOWLEDGE</b><small class="vp-sub"></small>`;
    this.ring = this.el.querySelector('.vp-ring')!;
    this.label = this.el.querySelector('.vp-label')!;
    this.sub = this.el.querySelector('.vp-sub')!;
    this.el.addEventListener('click', e => { e.stopPropagation(); this.el.blur(); onAck(); });
    this.key = key;
    parent.appendChild(this.el);
  }
  private key: () => string | null;

  /** state from LocoSystems, `left` = seconds until the penalty brake */
  update(state: 'ok' | 'warning' | 'penalty', left: number) {
    if (state !== this.shown) {
      this.shown = state;
      this.el.hidden = state === 'ok';
      this.el.classList.toggle('penalty', state === 'penalty');
      const k = this.key();
      this.label.textContent = state === 'penalty' ? 'PENALTY BRAKE' : 'ACKNOWLEDGE';
      this.sub.textContent = state === 'penalty' ? `stop, then ${k ? `press ${k}` : 'tap'} to reset` : k ? `vigilance - press ${k}` : 'vigilance - tap';
    }
    if (state !== 'warning') return;
    // ring empties as the grace time runs out
    const frac = Math.max(0, Math.min(1, left / VIGILANCE_GRACE));
    if (Math.abs(frac - this.lastFrac) > 0.004) { this.lastFrac = frac; this.ring.style.strokeDashoffset = String(RING * (1 - frac)); }
  }
}
