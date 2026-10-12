/**
 * Contextual card for a station stop (desktop: bottom centre; touch: above
 * the bottom bar). It shows only what the moment needs:
 *   - how well the train stopped ("Stopped on the mark" / "Overshot by 12 m")
 *   - the next action: Open doors (T) / Start loading / Start unloading
 *   - progress: "Boarding... 60%  off 34 / on 52" or "Loading... 45% - 1,800 t / 4,000 t", with x4
 *   - Close doors (T) when boarding is over
 *   - "Scheduled departure 07:42" + Skip to departure, or "Waiting for X to pass" + Skip wait
 *   - "Waiting for the signal..." then "Ready to depart"
 * The elements are built once and only their text changes (a card rebuilt
 * every frame would swallow clicks on its buttons).
 */
export interface StopView {
  accuracy: string | null;
  action: { label: string; id: 'start' | 'close' } | null;
  progress: { text: string; value: number; fast: boolean } | null;
  wait: { text: string; skip: string } | null;
  status: string | null;
}

export class StopCard {
  readonly el: HTMLElement;
  private q: Record<'acc' | 'prog' | 'bar' | 'ptext' | 'fast' | 'main' | 'wait' | 'wtext' | 'skip' | 'status', HTMLElement>;

  constructor(parent: HTMLElement, private on: (id: 'start' | 'close' | 'fast' | 'skip') => void, private key: () => string | null) {
    this.el = document.createElement('div');
    this.el.className = 'stop-card';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="sc-acc"></div>
      <div class="sc-prog"><div class="sc-bar"><i></i></div><span class="sc-ptext"></span><button data-a="fast" title="Speed up x4">&#9193; x4</button></div>
      <button data-a="start" class="sc-main"></button>
      <div class="sc-wait"><span class="sc-wtext"></span><button data-a="skip"></button></div>
      <div class="sc-status"></div>`;
    const $ = (s: string) => this.el.querySelector<HTMLElement>(s)!;
    this.q = { acc: $('.sc-acc'), prog: $('.sc-prog'), bar: $('.sc-bar i'), ptext: $('.sc-ptext'), fast: $('[data-a="fast"]'), main: $('.sc-main'), wait: $('.sc-wait'), wtext: $('.sc-wtext'), skip: $('[data-a="skip"]'), status: $('.sc-status') };
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b?.dataset.a) return;
      e.stopPropagation(); b.blur();
      this.on(b.dataset.a as 'start' | 'close' | 'fast' | 'skip');
    });
    parent.appendChild(this.el);
  }

  update(v: StopView | null) {
    this.el.hidden = !v;
    if (!v) return;
    const q = this.q;
    const set = (e: HTMLElement, html: string | null) => { e.hidden = html === null; if (html !== null && e.innerHTML !== html) e.innerHTML = html; };
    set(q.acc, v.accuracy);
    q.prog.hidden = !v.progress;
    if (v.progress) {
      set(q.ptext, v.progress.text);
      q.bar.style.width = `${Math.round(v.progress.value * 100)}%`;
      q.fast.classList.toggle('on', v.progress.fast);
    }
    const k = this.key();
    set(q.main, v.action ? `${v.action.label}${k ? ` <kbd>${k}</kbd>` : ''}` : null);
    if (v.action) q.main.dataset.a = v.action.id;
    q.wait.hidden = !v.wait;
    if (v.wait) { set(q.wtext, v.wait.text); set(q.skip, v.wait.skip); }
    set(q.status, v.status);
  }
}
