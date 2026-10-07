import { fmtDist, h, setText, show } from './dom';
import { SIGNAL_HEAD } from './icons';

export type Aspect = 'R' | 'Y' | 'YY' | 'G';
const NAMES: Record<Aspect, string> = { R: 'Red Signal', Y: 'Yellow Signal', YY: 'Double Yellow', G: 'Green Signal' };

/** Next signal: coloured aspect badge, "Green Signal in 120 m", and a signal head lit to match. */
export class SignalCard {
  readonly el = h('div', 'm-card m-signal', `<span class="m-badge"></span><span class="m-txt"><b class="m-name m-lbl"></b><span class="m-lbl"> in </span><b class="m-dist"></b></span><span class="m-head">${SIGNAL_HEAD}</span>`);
  private aspect = '';

  update(s: { aspect: string; dist: number } | null) {
    show(this.el, !!s);
    if (!s) return;
    const a = s.aspect as Aspect;
    if (a !== this.aspect) {
      this.el.classList.remove(`asp-${this.aspect}`);
      this.el.classList.add(`asp-${a}`);
      this.aspect = a;
      setText(this.el.querySelector('.m-name')!, NAMES[a] ?? 'Signal');
    }
    setText(this.el.querySelector('.m-dist')!, fmtDist(s.dist));
  }
}
