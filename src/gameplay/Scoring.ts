import { bus } from '../core/EventBus';

export type Category = 'punctuality' | 'stops' | 'smoothness' | 'signals' | 'speed' | 'horn' | 'safety';
export const CATEGORY_NAMES: Record<Category, string> = {
  punctuality: 'Punctuality', stops: 'Stop accuracy', smoothness: 'Smooth driving', signals: 'Signal compliance',
  speed: 'Speed compliance', horn: 'Horn at whistle boards', safety: 'Safety systems',
};

export interface ScoreEntry { category: Category; points: number; text: string; time: number }

/** Running score: every award/penalty is logged for the end-of-run report. */
export class Scoring {
  readonly entries: ScoreEntry[] = [];
  readonly totals: Record<Category, number> = { punctuality: 0, stops: 0, smoothness: 0, signals: 0, speed: 0, horn: 0, safety: 0 };
  static readonly BASE = 1000;

  /** false for practice / God Mode runs: nothing is scored or recorded */
  enabled = true;

  add(category: Category, points: number, text: string, time: number, announce = true) {
    if (!this.enabled) return;
    this.entries.push({ category, points, text, time });
    this.totals[category] += points;
    if (announce) {
      if (points < 0) bus.emit('penalty', { rule: category, points, text });
      bus.emit('message', { text: `${points > 0 ? '+' : ''}${Math.round(points)}  ${text}`, kind: points < 0 ? 'penalty' : 'good' });
    }
  }

  get total() { return Math.round(Scoring.BASE + Object.values(this.totals).reduce((a, b) => a + b, 0)); }
  get grade() {
    const t = this.total;
    return t >= 1250 ? 'S' : t >= 1100 ? 'A' : t >= 950 ? 'B' : t >= 750 ? 'C' : 'D';
  }
}
