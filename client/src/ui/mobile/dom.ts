// Tiny DOM helpers for the mobile HUD: every component writes to the DOM only when a value changes.

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export function setText(e: Element, v: string) { if (e.textContent !== v) e.textContent = v; }
export function setAttr(e: Element, k: string, v: string) { if (e.getAttribute(k) !== v) e.setAttribute(k, v); }
export function show(e: HTMLElement, on: boolean) { if (e.hidden === on) e.hidden = !on; }

/** Metres under 1 km, then km with one decimal ("1.4 km"). */
export const fmtDist = (m: number) => (m < 999.5 ? `${Math.max(0, Math.round(m))} m` : `${(m / 1000).toFixed(1)} km`);

/** Press-and-hold on a button for `ms` (Pointer Events, one pointer); `arming` class while held. */
export function longPress(b: HTMLElement, ms: number, fire: () => void) {
  let timer = 0;
  b.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    b.setPointerCapture(e.pointerId);
    b.classList.add('arming');
    clearTimeout(timer);
    timer = window.setTimeout(() => { b.classList.remove('arming'); fire(); }, ms);
  });
  const cancel = () => { clearTimeout(timer); b.classList.remove('arming'); };
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointercancel', cancel);
}

/** Tap handler that never reaches the 3D view underneath. */
export function onTap(e: HTMLElement, fn: (ev: MouseEvent) => void) {
  e.addEventListener('click', ev => { ev.stopPropagation(); fn(ev); });
}
