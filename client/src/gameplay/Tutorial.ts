import { safeStorageGet, safeStorageSet } from '../core/storage';

/**
 * Data-driven tutorials (data/tutorials/*.json). Each step names a control to
 * highlight and a completion condition evaluated against a small state snapshot
 * provided by the game every frame. Text is keyed by language for later Hindi.
 */
export type Lang = 'en' | 'hi';
export type Condition =
  | { manual: true }
  | { after: number }
  | { field: keyof TutorialState; op: '==' | '>=' | '<=' | 'in'; value: unknown }
  | { all: Condition[] }
  | { any: Condition[] };

export interface TutorialStep {
  id: string;
  text: Partial<Record<Lang, string>> & { en: string };
  key: string | null;
  highlight: string | null;
  showMe?: string;
  complete: Condition;
}

export interface TutorialData { id: string; title: Partial<Record<Lang, string>> & { en: string }; steps: TutorialStep[] }

export interface TutorialState {
  pantoPos: number; vcb: boolean; headlight: number; reverser: number; signalAspect: string;
  bp: number; trainBrake: number; locoBrake: number; hornSounded: boolean; notch: number;
  speedKmph: number; underLimitSeconds: number; stoppedAfterMoving: boolean;
}

export const TUTORIALS: Record<string, TutorialData> = {};
for (const m of Object.values(import.meta.glob('../../../data/tutorials/*.json', { eager: true, import: 'default' }))) {
  const t = m as TutorialData;
  TUTORIALS[t.id] = t;
}

const PREFS = 'railbharat.tutorial.v1';
interface Prefs { dontShow: boolean; completed: boolean }
export const tutorialPrefs = {
  get: () => safeStorageGet<Prefs>(PREFS, { dontShow: false, completed: false }),
  set: (p: Partial<Prefs>) => safeStorageSet(PREFS, { ...tutorialPrefs.get(), ...p }),
  /** auto-start on a player's first runs until they finish it or tick "Don't show again" */
  shouldAutoStart: () => { const p = tutorialPrefs.get(); return !p.dontShow && !p.completed; },
};

export function evaluate(c: Condition, s: TutorialState, stepTime: number): boolean {
  if ('manual' in c) return false;
  if ('after' in c) return stepTime >= c.after;
  if ('all' in c) return c.all.every(x => evaluate(x, s, stepTime));
  if ('any' in c) return c.any.some(x => evaluate(x, s, stepTime));
  const v = s[c.field] as unknown;
  switch (c.op) {
    case '==': return v === c.value;
    case '>=': return (v as number) >= (c.value as number);
    case '<=': return (v as number) <= (c.value as number);
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
  }
}

/** Runs one tutorial: tracks the current step and advances when its condition is met. */
export class Tutorial {
  index = 0;
  private stepTime = 0;
  private doneDelay = -1;
  finished = false;
  onStep?: (step: TutorialStep, index: number) => void;
  onFinish?: (completed: boolean) => void;

  constructor(readonly data: TutorialData, readonly lang: Lang = 'en') {}

  get step() { return this.data.steps[this.index]; }
  get count() { return this.data.steps.length; }
  text(step = this.step) { return step.text[this.lang] ?? step.text.en; }

  start() { this.go(0); }

  go(i: number) {
    this.index = Math.max(0, Math.min(this.count - 1, i));
    this.stepTime = 0;
    this.doneDelay = -1;
    this.onStep?.(this.step, this.index);
  }
  next() { if (this.index >= this.count - 1) this.finish(true); else this.go(this.index + 1); }
  back() { this.go(this.index - 1); }
  skip() { this.finish(false); }

  finish(completed: boolean) {
    if (this.finished) return;
    this.finished = true;
    if (completed) tutorialPrefs.set({ completed: true });
    this.onFinish?.(completed);
  }

  /** Call every frame. A short pause after success lets the player see the change. */
  update(dt: number, s: TutorialState) {
    if (this.finished) return;
    this.stepTime += dt;
    if (this.doneDelay >= 0) {
      this.doneDelay -= dt;
      if (this.doneDelay < 0) this.next();
      return;
    }
    if (evaluate(this.step.complete, s, this.stepTime)) this.doneDelay = 0.9;
  }

  /** true for 0.9 s after the step condition is met (card shows a tick) */
  get stepDone() { return this.doneDelay >= 0; }
}
