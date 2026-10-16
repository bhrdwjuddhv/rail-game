import type { Ad } from '@rail/shared/ads/Ads';
import { icon } from './theme/icons';

/**
 * The card shown when a billboard is clicked or tapped (the game is paused
 * meanwhile: a tap on a billboard while driving is often an accident). Only
 * "Visit website" opens the advertiser's site, in a new tab; coming back, the
 * game stays paused until "Tap to continue".
 */
export class AdCard {
  readonly el = document.createElement('div');

  constructor(parent: HTMLElement, private onVisit: (ad: Ad) => void, private onClose: () => void) {
    this.el.className = 'ad-card';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.addEventListener('click', e => e.stopPropagation());
    this.el.addEventListener('pointerdown', e => e.stopPropagation());
    parent.appendChild(this.el);
  }

  get visible() { return !this.el.hidden; }

  show(ad: Ad, image: string | null) {
    const f = ad.fallback;
    this.el.replaceChildren();
    const box = document.createElement('div');
    box.className = 'ad-card-box';
    const pic = document.createElement('div');
    pic.className = 'ad-card-pic';
    if (image) {
      const img = document.createElement('img');
      img.src = image; img.alt = f.title;
      img.onerror = () => { img.remove(); pic.style.background = f.bg; pic.textContent = f.title; pic.style.color = f.fg; };
      pic.appendChild(img);
    } else { pic.style.background = f.bg; pic.style.color = f.fg; pic.textContent = f.title; }
    const title = document.createElement('h3');
    title.textContent = f.title;
    box.append(pic, title);
    if (f.sub) { const sub = document.createElement('p'); sub.textContent = f.sub; box.appendChild(sub); }
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.close());
    buttons.appendChild(cancel);
    if (ad.url) {
      const visit = document.createElement('button');
      visit.className = 'primary';
      visit.textContent = ad.house === 'advertise' ? 'Contact us' : 'Visit website';
      visit.addEventListener('click', () => {
        this.onVisit(ad);
        // an e-mail address opens the mail app (a new tab would stay blank)
        if (ad.url!.startsWith('mailto:')) location.href = ad.url!;
        else window.open(ad.url!, '_blank', 'noopener,noreferrer');
        // back from the site: still paused, until the player says so
        buttons.replaceChildren();
        const go = document.createElement('button');
        go.className = 'primary';
        go.innerHTML = `${icon('play')} Tap to continue`;
        go.addEventListener('click', () => this.close());
        buttons.appendChild(go);
      });
      buttons.appendChild(visit);
    }
    box.appendChild(buttons);
    this.el.appendChild(box);
    this.el.hidden = false;
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.onClose();
  }
}
