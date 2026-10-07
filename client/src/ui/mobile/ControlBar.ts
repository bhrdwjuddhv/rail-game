import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import type { Action } from '../../core/Settings';
import { buzz } from '../../input/Device';
import { h, longPress, onTap } from './dom';
import { ICON } from './icons';
import { PantographButton } from './PantographButton';

/**
 * Bottom control bar, one thin row in two groups either side of the
 * speedometer. Left: EMERGENCY STOP (hold 0.5 s), pantograph, main breaker
 * (VCB) - or, on a diesel, fuel pump and engine start/stop - and wipers.
 * Right: headlight and "More" for everything else. Each button has a small
 * LED: grey off, green on, amber while changing (VCB closing, engine cranking).
 */
export class ControlBar {
  /** left group (bottom-left corner) */
  readonly el = h('div', 'm-card m-bar m-bar-l');
  /** right group (left of the levers) */
  readonly right = h('div', 'm-card m-bar m-bar-r');
  /** electric locos only */
  readonly panto: PantographButton | null = null;
  private btn: Record<string, HTMLButtonElement> = {};
  private shown = { wipers: -1, head: -1, vcb: '', engine: '', fuel: false };

  constructor(act: (a: Action, down: boolean) => void, onMore: () => void, togglePanto: () => void, private diesel = false) {
    const emerg = h('button', 'm-emerg', `${ICON.octagon}<span>EMERGENCY<br>STOP</span>`);
    emerg.dataset.tid = 'emergency';
    emerg.setAttribute('aria-label', 'Emergency stop (hold)');
    longPress(emerg, 500, () => { act('emergency', true); buzz(80); });

    const add = (key: string, tid: string, icon: string, label: string, a: Action) => {
      const b = h('button', `m-btn m-${key}`, `${icon}<i class="led"></i>`);
      b.dataset.tid = tid;
      b.setAttribute('aria-label', label);
      onTap(b, () => { act(a, true); act(a, false); });
      this.btn[key] = b;
      return b;
    };
    this.el.append(emerg);
    if (diesel) {
      this.el.append(add('fuel', 'fuelPump', ICON.fuel, 'Fuel pump', 'fuelPump'), add('engine', 'engine', ICON.engine, 'Engine start / stop', 'engine'));
    } else {
      this.panto = new PantographButton(togglePanto);
      this.el.append(this.panto.el, add('vcb', 'vcb', ICON.vcb, 'Main circuit breaker (VCB)', 'vcb'));
    }
    this.el.append(add('wipers', 'wipers', ICON.wipers, 'Wipers', 'wipers'));
    const more = h('button', 'm-btn m-more', ICON.more);
    more.dataset.tid = 'more';
    more.setAttribute('aria-label', 'More controls');
    onTap(more, onMore);
    this.btn.more = more;
    this.right.append(add('headlight', 'headlight', ICON.headlight, 'Headlight', 'headlights'), more);
  }

  setMoreOpen(open: boolean) { this.btn.more.classList.toggle('on', open); }

  show(s: LocoSystems) {
    const sh = this.shown, b = this.btn;
    if (s.wipers !== sh.wipers) { sh.wipers = s.wipers; b.wipers.classList.toggle('on', s.wipers > 0); b.wipers.dataset.level = String(s.wipers); b.wipers.title = ['Wipers off', 'Wipers slow', 'Wipers fast'][s.wipers]; }
    if (s.headlight !== sh.head) { sh.head = s.headlight; b.headlight.classList.toggle('on', s.headlight > 0); b.headlight.dataset.level = String(s.headlight); b.headlight.title = ['Headlight off', 'Headlight dim', 'Headlight bright'][s.headlight]; }
    if (this.diesel) {
      // engine LED: grey stopped, amber cranking, green running; fuel pump LED green when on
      if (s.engine !== sh.engine) {
        sh.engine = s.engine;
        b.engine.classList.toggle('on', s.engine === 'running');
        b.engine.classList.toggle('moving', s.engine === 'cranking');
        b.engine.title = `Engine ${s.engine}`;
      }
      if (s.fuelPump !== sh.fuel) { sh.fuel = s.fuelPump; b.fuel.classList.toggle('on', s.fuelPump); b.fuel.title = `Fuel pump ${s.fuelPump ? 'on' : 'off'}`; }
      return;
    }
    // VCB LED: grey open, amber closing, green closed
    const vcb = s.vcb ? 'closed' : s.vcbClosing > 0 ? 'closing' : 'open';
    if (vcb !== sh.vcb) {
      sh.vcb = vcb;
      b.vcb.classList.toggle('on', vcb === 'closed');
      b.vcb.classList.toggle('moving', vcb === 'closing');
      b.vcb.title = `Main breaker ${vcb}`;
    }
    this.panto!.update(s.pantoPos, s.pantoUp);
  }
}
