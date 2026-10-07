export interface RouteChoice { id: string; label: string; current: boolean }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Free Roam "Route ahead": a small pop-up listing the lines the train can be
 * received on at the next station (main line through, a platform, a loop).
 * Picking one asks the interlocking to set it; Esc, the key again or Close
 * dismisses it. Same panel on desktop and touch.
 */
export class RoutePicker {
  readonly el = document.createElement('div');

  constructor(parent: HTMLElement) {
    this.el.className = 'route-picker';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  get open() { return !this.el.hidden; }

  show(station: string, choices: RouteChoice[], pick: (id: string) => void) {
    this.el.innerHTML = `<h3>Route ahead: ${esc(station)}</h3>
      <div class="rp-list">${choices.map(c => `<button data-id="${esc(c.id)}" class="${c.current ? 'on' : ''}">${esc(c.label)}${c.current ? '<small>set</small>' : ''}</button>`).join('')}</div>
      <button class="rp-close" data-close>Close</button>`;
    this.el.onclick = e => {
      e.stopPropagation();
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.id) pick(b.dataset.id);
      this.hide();
    };
    this.el.hidden = false;
  }

  hide() { this.el.hidden = true; }
}
