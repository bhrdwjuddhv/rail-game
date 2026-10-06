/**
 * "Tap to continue" cover over the frozen, dimmed game. Browsers only allow
 * fullscreen, orientation lock and audio inside a user gesture, so after the
 * tab comes back (or fullscreen was left) the game waits here for one tap and
 * restores all three inside that tap.
 */
export class ResumeScreen {
  readonly el = document.createElement('div');

  constructor(parent: HTMLElement, onContinue: () => void, onMenu: () => void) {
    this.el.className = 'resume-screen';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.innerHTML = `<button class="go">&#9654;&nbsp; Tap to continue</button><button class="menu-link">Main Menu</button>`;
    this.el.querySelector('.go')!.addEventListener('click', e => { e.stopPropagation(); this.hide(); onContinue(); });
    this.el.querySelector('.menu-link')!.addEventListener('click', e => { e.stopPropagation(); onMenu(); });
    parent.appendChild(this.el);
  }

  get visible() { return !this.el.hidden; }
  show() { this.el.hidden = false; }
  hide() { this.el.hidden = true; }
}
