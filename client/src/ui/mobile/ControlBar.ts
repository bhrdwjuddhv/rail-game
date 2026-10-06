import type { LocoSystems } from '@rail/shared/train/LocoSystems';
import type { Action } from '../../core/Settings';
import { buzz } from '../../input/Device';
import { h, longPress, onTap } from './dom';
import { ICON } from './icons';
import { PantographButton } from './PantographButton';

/**
 * Bottom control bar: EMERGENCY STOP (hold 0.5 s), then round buttons for the
 * loco's lights and wipers, the pantograph, and "More" for the rest. Each
 * button has a small LED: grey off, green on, amber while changing.
 */
export class ControlBar {
  readonly el = h('div', 'm-card m-bar');
  readonly panto: PantographButton;
  private btn: Record<string, HTMLButtonElement> = {};
  private shown = { wipers: -1, head: -1, cab: false, markers: false };

  constructor(act: (a: Action, down: boolean) => void, onMore: () => void, togglePanto: () => void) {
    const emerg = h('button', 'm-emerg', `${ICON.octagon}<span>EMERGENCY<br>STOP</span>`);
    emerg.dataset.tid = 'emergency';
    emerg.setAttribute('aria-label', 'Emergency stop (hold)');
    longPress(emerg, 500, () => { act('emergency', true); buzz(80); });
    this.el.append(emerg);

    const add = (key: string, tid: string, icon: string, label: string, a: Action) => {
      const b = h('button', `m-btn m-${key}`, `${icon}<i class="led"></i>`);
      b.dataset.tid = tid;
      b.setAttribute('aria-label', label);
      onTap(b, () => { act(a, true); act(a, false); });
      this.btn[key] = b;
      return b;
    };
    this.panto = new PantographButton(togglePanto);
    this.el.append(
      add('wipers', 'wipers', ICON.wipers, 'Wipers', 'wipers'),
      this.panto.el,
      add('headlight', 'headlight', ICON.headlight, 'Headlight', 'headlights'),
      add('cab', 'cabLight', ICON.cabLight, 'Cab light', 'cabLight'),
      add('markers', 'markers', ICON.markers, 'Marker lights', 'markers'),
    );
    const more = h('button', 'm-btn m-more', ICON.more);
    more.dataset.tid = 'more';
    more.setAttribute('aria-label', 'More controls');
    onTap(more, onMore);
    this.btn.more = more;
    this.el.append(more);
  }

  setMoreOpen(open: boolean) { this.btn.more.classList.toggle('on', open); }

  show(s: LocoSystems) {
    const sh = this.shown, b = this.btn;
    if (s.wipers !== sh.wipers) { sh.wipers = s.wipers; b.wipers.classList.toggle('on', s.wipers > 0); b.wipers.dataset.level = String(s.wipers); b.wipers.title = ['Wipers off', 'Wipers slow', 'Wipers fast'][s.wipers]; }
    if (s.headlight !== sh.head) { sh.head = s.headlight; b.headlight.classList.toggle('on', s.headlight > 0); b.headlight.dataset.level = String(s.headlight); b.headlight.title = ['Headlight off', 'Headlight dim', 'Headlight bright'][s.headlight]; }
    if (s.cabLight !== sh.cab) { sh.cab = s.cabLight; b.cab.classList.toggle('on', s.cabLight); }
    if (s.markers !== sh.markers) { sh.markers = s.markers; b.markers.classList.toggle('on', s.markers); }
    this.panto.update(s.pantoPos, s.pantoUp);
  }
}
