import { isPortrait, isTouch } from '../input/Device';

/**
 * Full-screen "Rotate your phone" cover shown on touch devices held in
 * portrait. `onChange(portrait)` lets the game pause while it is up.
 */
export class RotateScreen {
  readonly el = document.createElement('div');
  portrait = false;
  onChange?: (portrait: boolean) => void;

  constructor(parent: HTMLElement) {
    this.el.className = 'rotate-screen';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="phone" aria-hidden="true"><i></i></div><p><b>Rotate your phone</b><br>Rail Bharat plays in landscape.</p>`;
    parent.appendChild(this.el);
    if (!isTouch) return;
    const check = () => {
      const p = isPortrait();
      this.el.hidden = !p;
      if (p !== this.portrait) { this.portrait = p; this.onChange?.(p); }
    };
    addEventListener('resize', check);
    screen.orientation?.addEventListener?.('change', check);
    check();
  }
}
