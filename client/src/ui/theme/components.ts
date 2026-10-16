import { icon, type IconName } from './icons';

/**
 * The UI's components, styled by theme/tokens.css. Most return HTML (the menus are built from
 * template strings); the ones with behaviour (gallery, modal, toast) return or wire up elements.
 * Data attributes are passed as { name: value } and come out as data-name="value".
 */

export const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const dataAttrs = (d?: Record<string, string | number>) => (d ? Object.entries(d).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join('') : '');

export interface ButtonOpts { icon?: IconName; variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'lg'; data?: Record<string, string | number>; title?: string; disabled?: boolean; on?: boolean; cls?: string }

/** A button: optional icon, label (HTML allowed: pass escaped text), variant and size. */
export function button(label: string, o: ButtonOpts = {}) {
  const cls = ['btn', o.variant ? `btn-${o.variant}` : '', o.size ? `btn-${o.size}` : '', o.on ? 'on' : '', o.cls ?? ''].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}"${dataAttrs(o.data)}${o.title ? ` title="${esc(o.title)}"` : ''}${o.disabled ? ' disabled' : ''}${o.on !== undefined ? ` aria-pressed="${o.on}"` : ''}>${o.icon ? icon(o.icon) : ''}${label ? `<span>${label}</span>` : ''}</button>`;
}

/** A square (or round) button with only an icon; `label` is its accessible name and tooltip. */
export function iconButton(name: IconName, label: string, o: Omit<ButtonOpts, 'icon'> & { round?: boolean } = {}) {
  return `<button type="button" class="icon-btn${o.round ? ' round' : ''}${o.variant ? ` btn-${o.variant}` : ''}${o.on ? ' on' : ''}${o.cls ? ` ${o.cls}` : ''}"${dataAttrs(o.data)} aria-label="${esc(label)}" title="${esc(o.title ?? label)}"${o.disabled ? ' disabled' : ''}>${icon(name)}</button>`;
}

/** A selectable pill. */
export function chip(label: string, o: { icon?: IconName; on?: boolean; data?: Record<string, string | number>; title?: string } = {}) {
  return `<button type="button" class="chip${o.on ? ' on' : ''}"${dataAttrs(o.data)} aria-pressed="${!!o.on}"${o.title ? ` title="${esc(o.title)}"` : ''}>${o.icon ? icon(o.icon) : ''}<span>${esc(label)}</span></button>`;
}

/** A labelled on/off switch (a checkbox underneath: change events and .checked work as usual). */
export function toggle(label: string, o: { checked?: boolean; data?: Record<string, string | number>; hint?: string } = {}) {
  return `<label class="toggle"><span>${esc(label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</span><input type="checkbox" role="switch"${dataAttrs(o.data)}${o.checked ? ' checked' : ''}></label>`;
}

/** A labelled range slider with its value shown (call fillSliders after inserting, and on input). */
export function slider(label: string, o: { min: number; max: number; step: number; value: number; data?: Record<string, string | number>; out?: string }) {
  const pct = ((o.value - o.min) / (o.max - o.min)) * 100;
  return `<label class="slider"><span>${esc(label)}</span><output>${esc(o.out ?? String(o.value))}</output><input type="range" min="${o.min}" max="${o.max}" step="${o.step}" value="${o.value}" style="--fill:${pct}%"${dataAttrs(o.data)}></label>`;
}
/** Keep range tracks filled up to their thumbs (WebKit draws the fill from --fill). */
export function fillSliders(root: ParentNode) {
  const set = (r: HTMLInputElement) => r.style.setProperty('--fill', `${((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100}%`);
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(set);
  root.addEventListener('input', e => { const t = e.target as HTMLInputElement; if (t.type === 'range') set(t); });
}

/** Tabs (role tablist); each tab carries data-tab="id". */
export function tabs(items: { id: string; label: string; icon?: IconName }[], active: string) {
  return `<div class="tabs" role="tablist">${items.map(t => `<button type="button" role="tab" data-tab="${esc(t.id)}" aria-selected="${t.id === active}">${t.icon ? icon(t.icon) : ''}<span>${esc(t.label)}</span></button>`).join('')}</div>`;
}

/** A numbered stepper (1 Journey > 2 Train > ...): steps before `current` are done; each carries data-step="i". */
export function stepper(steps: string[], current: number) {
  return `<nav class="stepper" aria-label="Steps">${steps.map((s, i) => `${i ? `<i class="${i <= current ? 'done' : ''}"></i>` : ''}<button type="button" class="step ${i < current ? 'done' : i === current ? 'now' : ''}" data-step="${i}"${i === current ? ' aria-current="step"' : ''}><b>${i < current ? '&#10003;' : i + 1}</b><span>${esc(s)}</span></button>`).join('')}</nav>`;
}

/** A card wrapper. */
export const card = (inner: string, cls = '') => `<div class="card${cls ? ` ${cls}` : ''}">${inner}</div>`;

export interface ImageCardOpts { img?: string | null; title: string; sub?: string; badge?: string; on?: boolean; tint?: string; data?: Record<string, string | number>; disabled?: boolean; title2?: string }
/** A picture card (button): image (a shimmer until it loads, a tinted panel if it never does), title, details. */
export function imageCard(o: ImageCardOpts) {
  const img = o.img ? `<span class="shimmer"></span><img src="${esc(o.img)}" alt="" loading="lazy" decoding="async" onload="this.previousElementSibling&&this.previousElementSibling.remove()" onerror="this.previousElementSibling&&this.previousElementSibling.remove();this.remove()">` : '';
  return `<button type="button" class="image-card${o.on ? ' on' : ''}"${dataAttrs(o.data)} style="--tint:${esc(o.tint ?? '#3a4450')}" aria-pressed="${!!o.on}"${o.disabled ? ' aria-disabled="true"' : ''}${o.title2 ? ` title="${esc(o.title2)}"` : ''}>
    <span class="ic-pic">${img}${o.badge ? `<span class="ic-badge">${esc(o.badge)}</span>` : ''}</span>
    <span class="ic-body"><span class="ic-title">${esc(o.title)}</span>${o.sub ? `<span class="ic-sub">${esc(o.sub)}</span>` : ''}</span></button>`;
}

/** A horizontal gallery of cards (swipe on touch; wheel, drag and arrows on desktop; snaps to cards). Call bindGallery after inserting. */
export function gallery(itemsHtml: string[], o: { label: string; cardWidth?: number; data?: Record<string, string | number> }) {
  return `<div class="hgallery"${dataAttrs(o.data)} role="group" aria-label="${esc(o.label)}" style="--card-w:${o.cardWidth ?? 210}px">
    <button type="button" class="hg-arrow l" aria-label="Scroll left">${icon('caretLeft')}</button>
    <div class="hg-track">${itemsHtml.join('')}</div>
    <button type="button" class="hg-arrow r" aria-label="Scroll right">${icon('caretRight')}</button></div>`;
}
/** Behaviour for every gallery under root: arrow buttons, vertical wheel scrolls sideways, mouse drag (a drag is not a click). */
export function bindGallery(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('.hgallery').forEach(g => {
    if (g.dataset.bound) return;
    g.dataset.bound = '1';
    const track = g.querySelector<HTMLElement>('.hg-track')!, l = g.querySelector<HTMLElement>('.hg-arrow.l')!, r = g.querySelector<HTMLElement>('.hg-arrow.r')!;
    const arrows = () => { l.hidden = track.scrollLeft < 4; r.hidden = track.scrollLeft + track.clientWidth > track.scrollWidth - 4; };
    const page = (d: number) => track.scrollBy({ left: d * Math.max(200, track.clientWidth * 0.8), behavior: 'smooth' });
    l.addEventListener('click', e => { e.stopPropagation(); page(-1); });
    r.addEventListener('click', e => { e.stopPropagation(); page(1); });
    track.addEventListener('scroll', arrows, { passive: true });
    track.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && track.scrollWidth > track.clientWidth) { track.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    let down: { x: number; s: number } | null = null, moved = false;
    track.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') return; down = { x: e.clientX, s: track.scrollLeft }; moved = false; });
    window.addEventListener('pointermove', (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 6) { moved = true; track.classList.add('dragging'); }
      if (moved) track.scrollLeft = down.s - dx;
    });
    window.addEventListener('pointerup', () => { if (!down) return; down = null; track.classList.remove('dragging'); });
    // a drag ends without selecting the card under the pointer
    track.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    requestAnimationFrame(arrows);
  });
}

/** A modal dialog over everything: title, body HTML, buttons ({ id, label, variant }). Resolves with the button id (or null: Esc / outside). */
export function modal(o: { title: string; icon?: IconName; body: string; buttons: { id: string; label: string; variant?: 'primary' | 'danger' }[] }): Promise<string | null> {
  return new Promise(res => {
    const el = document.createElement('div');
    el.className = 'modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<div class="modal-box"><h3>${o.icon ? icon(o.icon) : ''}${esc(o.title)}</h3><div class="modal-body">${o.body}</div>
      <div class="buttons">${o.buttons.map(b => `<button type="button" data-m="${esc(b.id)}" class="${b.variant ? `btn-${b.variant}` : ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const done = (v: string | null) => { el.remove(); removeEventListener('keydown', key, true); res(v); };
    const key = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopPropagation(); done(null); } };
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
      if (b) done(b.dataset.m!);
      else if (e.target === el) done(null);
    });
    addEventListener('keydown', key, true);
    document.body.appendChild(el);
    el.querySelector<HTMLButtonElement>('.buttons button:last-child')?.focus();
  });
}

let toastBox: HTMLElement | null = null;
/** A short message at the bottom of the screen (menus; the HUD has its own message stack). */
export function toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad' = 'info', ms = 3200) {
  if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; document.body.appendChild(toastBox); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', 'status');
  t.innerHTML = `${icon(kind === 'good' ? 'check' : kind === 'warn' || kind === 'bad' ? 'warning' : 'info')}<span>${esc(text)}</span>`;
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms);
}
