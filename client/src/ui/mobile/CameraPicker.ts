import { h, onTap, setText } from './dom';
import { ICON } from './icons';

/** Short names of the game's camera modes, by index. */
export const CAMERA_SHORT = ['Cab', 'Front', 'Rear', 'Side', 'Chase', 'Cinematic', 'Free'];

/** Camera icon + current camera name + arrow; tap opens a list of the camera modes. */
export class CameraPicker {
  readonly el = h('div', 'm-campick');
  private btn: HTMLButtonElement;
  private list: HTMLElement;
  private current = -1;

  constructor(private select: (i: number) => void) {
    this.el.innerHTML = `<button class="m-cam-btn" aria-haspopup="listbox" aria-label="Camera">${ICON.camera}<span></span>${ICON.chevron}</button>
      <div class="m-cam-list" role="listbox" hidden>${CAMERA_SHORT.map((n, i) => `<button role="option" data-i="${i}">${n}</button>`).join('')}</div>`;
    this.el.dataset.tid = 'camera';
    this.btn = this.el.querySelector('.m-cam-btn')!;
    this.list = this.el.querySelector('.m-cam-list')!;
    onTap(this.btn, () => this.open(this.list.hidden === true));
    this.list.querySelectorAll<HTMLButtonElement>('[data-i]').forEach(b => onTap(b, () => { this.select(Number(b.dataset.i)); this.open(false); }));
  }

  get isOpen() { return !this.list.hidden; }
  open(on: boolean) { this.list.hidden = !on; this.btn.setAttribute('aria-expanded', String(on)); }

  show(i: number) {
    if (i === this.current) return;
    this.current = i;
    setText(this.btn.querySelector('span')!, CAMERA_SHORT[i] ?? '');
    this.list.querySelectorAll<HTMLElement>('[data-i]').forEach(b => b.setAttribute('aria-selected', String(Number(b.dataset.i) === i)));
  }
}
