import { h, onTap } from './dom';

/** Reverser F / N / R as a segmented switch; the selected position has a green LED. */
export class ReverserSwitch {
  readonly el = h('div', 'm-card m-rev', `<small>REVERSER</small><span class="m-seg">
    <button data-rev="1" aria-label="Forward">F<i class="led"></i></button>
    <button data-rev="0" aria-label="Neutral">N<i class="led"></i></button>
    <button data-rev="-1" aria-label="Reverse">R<i class="led"></i></button></span>`);
  private value = 9;

  constructor(set: (r: -1 | 0 | 1) => void) {
    this.el.dataset.tid = 'reverser';
    this.el.querySelectorAll<HTMLButtonElement>('[data-rev]').forEach(b => onTap(b, () => set(Number(b.dataset.rev) as -1 | 0 | 1)));
  }

  show(r: number) {
    if (r === this.value) return;
    this.value = r;
    this.el.querySelectorAll<HTMLElement>('[data-rev]').forEach(b => b.classList.toggle('on', Number(b.dataset.rev) === r));
  }
}
