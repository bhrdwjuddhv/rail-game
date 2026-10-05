import { safeStorageGet, safeStorageSet } from '../core/storage';
import { GodSettings, NORMAL } from '@rail/shared/gameplay/GodSettings';
export { NORMAL };
export type { GodSettings };

const SESSION_KEY = 'railbharat.god.session';
const FREE_ROAM_KEY = 'railbharat.god.freeRoam';

interface Saved { active: boolean; settings: GodSettings; remember: boolean }

export class GodMode {
  active = false;
  /** once God Mode has been on, scoring/achievements stay off for the rest of the run */
  usedThisRun = false;
  remember = false;
  settings: GodSettings = { ...NORMAL };
  private listeners = new Set<() => void>();

  constructor(private freeRoam: boolean) {
    // remembered Free Roam setup first, then anything set earlier in this browser session
    if (freeRoam) this.apply(safeStorageGet<Saved>(FREE_ROAM_KEY, { active: false, settings: { ...NORMAL }, remember: false }));
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) this.apply(JSON.parse(raw) as Saved);
    } catch { /* storage blocked: defaults */ }
    if (this.active) this.usedThisRun = true;
  }

  private apply(s: Saved) {
    this.active = !!s.active;
    this.remember = !!s.remember;
    this.settings = { ...NORMAL, ...s.settings };
  }

  /** Effective settings for the systems that read them. */
  get eff(): Readonly<GodSettings> { return this.active ? this.settings : NORMAL; }

  setActive(on: boolean) {
    this.active = on;
    if (on) this.usedThisRun = true;
    this.changed();
  }

  set<K extends keyof GodSettings>(key: K, value: GodSettings[K]) {
    this.settings[key] = value;
    this.changed();
  }

  setRemember(on: boolean) {
    this.remember = on;
    this.changed();
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private changed() {
    const saved: Saved = { active: this.active, settings: this.settings, remember: this.remember };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    if (this.freeRoam) safeStorageSet(FREE_ROAM_KEY, this.remember ? saved : { active: false, settings: { ...NORMAL }, remember: false });
    for (const l of this.listeners) l();
  }
}
