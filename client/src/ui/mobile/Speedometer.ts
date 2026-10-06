import { h, setAttr, setText } from './dom';

const CX = 100, CY = 100, R = 84;
/** point on the dial for fraction f (0 = left end, 1 = right end, over the top) */
const at = (f: number, r = R) => { const a = Math.PI + Math.PI * Math.min(1, Math.max(0, f)); return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) }; };

/**
 * Half-circle speedometer sitting on the bottom edge: arc filled up to the
 * current speed with a red needle, a big digital readout, and the current
 * speed limit as a sign riding on the arc. The arc turns red when overspeeding.
 */
export class Speedometer {
  readonly el = h('div', 'm-speedo');
  private max = 0;
  private shown = { speed: -1, limit: -1, over: false, units: '' };

  constructor() {
    const arc = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
    this.el.innerHTML = `<svg viewBox="0 0 200 106" aria-hidden="true">
      <path class="m-sp-back" d="${arc}" pathLength="100"/>
      <g class="m-sp-ticks"></g>
      <path class="m-sp-arc" d="${arc}" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
      <line class="m-sp-needle" x1="0" y1="0" x2="0" y2="0"/>
      <g class="m-sp-limit"><circle r="15"/><text dy="5"></text></g>
    </svg><div class="m-sp-read"><b>0</b><small>km/h</small></div>`;
    this.el.setAttribute('role', 'img');
  }

  /** Dial range: the loco's top speed rounded up to 20 (ticks every 20). */
  private scale(max: number) {
    if (max === this.max) return;
    this.max = max;
    let t = '';
    for (let v = 0; v <= max; v += 20) {
      const a = at(v / max, R + 8), b = at(v / max, R + 3);
      t += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
    }
    this.el.querySelector('.m-sp-ticks')!.innerHTML = t;
  }

  update(speed: number, limit: number, maxKmph: number, units: string) {
    this.scale(Math.max(40, Math.ceil(Math.max(maxKmph, limit) / 20) * 20));
    const s = Math.round(speed), sh = this.shown;
    const over = speed > limit + 2;
    if (s !== sh.speed) {
      sh.speed = s;
      setText(this.el.querySelector('.m-sp-read b')!, String(s));
      const f = Math.min(1, speed / this.max);
      setAttr(this.el.querySelector('.m-sp-arc')!, 'stroke-dashoffset', (100 - f * 100).toFixed(2));
      const a = at(f, R - 12), b = at(f, R + 9);
      const n = this.el.querySelector('.m-sp-needle')!;
      n.setAttribute('x1', a.x.toFixed(1)); n.setAttribute('y1', a.y.toFixed(1));
      n.setAttribute('x2', b.x.toFixed(1)); n.setAttribute('y2', b.y.toFixed(1));
      this.el.setAttribute('aria-label', `Speed ${s} ${units}, limit ${limit}`);
    }
    if (limit !== sh.limit) {
      sh.limit = limit;
      const p = at(limit / this.max, R);
      this.el.querySelector('.m-sp-limit')!.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      setText(this.el.querySelector('.m-sp-limit text')!, String(limit));
    }
    if (over !== sh.over) { sh.over = over; this.el.classList.toggle('over', over); }
    if (units !== sh.units) { sh.units = units; setText(this.el.querySelector('.m-sp-read small')!, units); }
  }
}
