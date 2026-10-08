/**
 * Desktop pantograph indicator: when P is pressed on an electric loco, a small
 * card shows a drawn pantograph rising to (or dropping from) the contact
 * wire, following the real pantograph position, with its state underneath.
 * It stays a moment after the pantograph arrives, then fades out.
 * (Touch has its own pantograph button with a travel LED.)
 */
const FOOT = 104, WIRE = 22, L = 46;

export class PantoIndicator {
  private el: HTMLElement;
  private arms: SVGPolylineElement;
  private head: SVGLineElement;
  private wire: SVGLineElement;
  private text: HTMLElement;
  private hideAt = 0;
  private lastPos = -1;
  private lastUp: boolean | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'panto-ind';
    this.el.hidden = true;
    this.el.innerHTML = `
      <svg viewBox="0 0 140 120" aria-hidden="true">
        <line class="pi-wire" x1="6" y1="${WIRE}" x2="134" y2="${WIRE}"/>
        <rect class="pi-roof" x="10" y="${FOOT}" width="120" height="10" rx="2"/>
        <rect class="pi-ins" x="38" y="${FOOT - 5}" width="8" height="6"/><rect class="pi-ins" x="94" y="${FOOT - 5}" width="8" height="6"/>
        <polyline class="pi-arms" points=""/>
        <line class="pi-head" x1="0" y1="0" x2="0" y2="0"/>
      </svg>
      <b class="pi-text"></b>`;
    this.arms = this.el.querySelector('.pi-arms')!;
    this.head = this.el.querySelector('.pi-head')!;
    this.wire = this.el.querySelector('.pi-wire')!;
    this.text = this.el.querySelector('.pi-text')!;
    parent.appendChild(this.el);
  }

  /** pos: 0 down .. 1 on the wire; up: switch position; now: ms */
  update(pos: number, up: boolean, now: number) {
    const moving = up ? pos < 0.999 : pos > 0.001;
    if (this.lastUp !== null && up !== this.lastUp) this.el.hidden = false;   // P pressed
    this.lastUp = up;
    if (this.el.hidden) return;
    if (moving) this.hideAt = now + 2200;
    else if (now > this.hideAt) { this.el.hidden = true; return; }
    this.el.classList.toggle('fading', !moving && now > this.hideAt - 600);
    if (Math.abs(pos - this.lastPos) > 0.002) {
      this.lastPos = pos;
      // diamond pantograph: feet on the insulators, knees out to the sides, collector head on top
      const h = 10 + pos * (FOOT - WIRE - 12), top = FOOT - h;
      const w = Math.sqrt(Math.max(0, L * L - (h / 2) ** 2));
      const pts = [[42, FOOT - 5], [70 - Math.min(w, 40), FOOT - h / 2], [70, top], [70 + Math.min(w, 40), FOOT - h / 2], [98, FOOT - 5]];
      this.arms.setAttribute('points', pts.map(p => p.join(',')).join(' '));
      this.head.setAttribute('x1', '44'); this.head.setAttribute('x2', '96');
      this.head.setAttribute('y1', String(top)); this.head.setAttribute('y2', String(top));
    }
    const touching = pos >= 0.99;
    this.wire.classList.toggle('live', touching);
    this.text.textContent = moving ? (up ? 'Pantograph raising…' : 'Pantograph lowering…') : touching ? 'Pantograph up: on the wire' : 'Pantograph down';
  }
}
