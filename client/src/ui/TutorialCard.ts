import type { Tutorial } from '../gameplay/Tutorial';
import { tutorialPrefs } from '../gameplay/Tutorial';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Bottom-centre instruction card: one step at a time with the key to press,
 * Back / Show me / Next / Skip, progress dots and "Don't show again".
 */
export class TutorialCard {
  readonly el = document.createElement('div');
  private body: HTMLElement;
  private shown = -1;
  private lastDone = false;

  constructor(parent: HTMLElement, private t: Tutorial, private showMe: () => void) {
    this.el.className = 'tutorial-card';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-live', 'polite');
    this.el.innerHTML = `
      <div class="tc-head"><span class="tc-title">${esc(t.data.title[t.lang] ?? t.data.title.en)}</span><span class="tc-count"></span></div>
      <div class="tc-body"></div>
      <div class="tc-dots">${t.data.steps.map(() => '<i></i>').join('')}</div>
      <div class="tc-foot">
        <label class="tc-dont"><input type="checkbox" ${tutorialPrefs.get().dontShow ? 'checked' : ''}> Don't show again</label>
        <span class="tc-buttons">
          <button data-a="back">Back</button><button data-a="show">Show me</button><button data-a="next">Next</button><button data-a="skip">Skip</button>
        </span>
      </div>`;
    this.body = this.el.querySelector('.tc-body')!;
    parent.appendChild(this.el);
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      b.blur(); // keep keyboard focus on the game
      const a = b.dataset.a;
      if (a === 'back') t.back();
      if (a === 'next') t.next();
      if (a === 'skip') t.skip();
      if (a === 'show') this.showMe();
    });
    this.el.querySelector<HTMLInputElement>('.tc-dont input')!.addEventListener('change', e => tutorialPrefs.set({ dontShow: (e.target as HTMLInputElement).checked }));
  }

  update() {
    const t = this.t;
    if (this.shown !== t.index || this.lastDone !== t.stepDone) {
      this.shown = t.index;
      this.lastDone = t.stepDone;
      const s = t.step;
      this.el.querySelector('.tc-count')!.textContent = `Step ${t.index + 1} of ${t.count}`;
      this.body.innerHTML = `<p>${esc(t.text())}</p>${t.key(s) ? `<p class="tc-key">Press <kbd>${esc(t.key(s)!)}</kbd></p>` : ''}${t.stepDone ? '<p class="tc-ok">&#10004; Done</p>' : ''}`;
      this.el.querySelectorAll('.tc-dots i').forEach((d, i) => { d.className = i < t.index ? 'past' : i === t.index ? 'now' : ''; });
      const last = t.index === t.count - 1;
      const next = this.el.querySelector<HTMLButtonElement>('[data-a="next"]')!;
      next.textContent = last ? 'Finish' : 'Next';
      this.el.querySelector<HTMLButtonElement>('[data-a="back"]')!.disabled = t.index === 0;
      this.el.querySelector<HTMLButtonElement>('[data-a="show"]')!.hidden = !s.highlight && !s.showMe;
      this.el.querySelector<HTMLButtonElement>('[data-a="skip"]')!.hidden = last;
    }
  }

  dispose() { this.el.remove(); }
}
