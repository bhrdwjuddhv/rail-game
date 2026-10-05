import { Action, settings } from '../core/Settings';

export interface KeyHandler {
  action(a: Action, down: boolean, e: KeyboardEvent): void;
  digit(n: number): void;
}

const REPEATABLE = new Set<Action>(['throttleUp', 'throttleDown', 'regenUp', 'regenDown', 'trainBrakeApply', 'trainBrakeRelease', 'locoBrakeApply', 'locoBrakeRelease']);

/** Keyboard: rebindable actions (KeyboardEvent.code), held-key state for the free camera. */
export class Keyboard {
  private down = new Set<string>();
  private lastRepeat = new Map<string, number>();
  /** when set, the next key press is captured (for rebinding) instead of acting */
  capture: ((code: string) => void) | null = null;
  enabled = true;

  constructor(private handler: KeyHandler) {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown = (code: string) => this.down.has(code);

  private actionFor(code: string): Action | null {
    const keys = settings.get().keys;
    for (const a in keys) if (keys[a as Action] === code) return a as Action;
    return null;
  }

  private onDown = (e: KeyboardEvent) => {
    if (this.capture) { e.preventDefault(); const c = this.capture; this.capture = null; c(e.code); return; }
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
    if (['Space', 'Backspace', 'Tab', 'F1', 'F3', 'Quote', 'Slash', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    const a = this.actionFor(e.code);
    if (e.repeat) {
      if (!a || !REPEATABLE.has(a)) return;
      const now = performance.now();
      if (now - (this.lastRepeat.get(e.code) ?? 0) < 160) return;
      this.lastRepeat.set(e.code, now);
    }
    this.down.add(e.code);
    if (!this.enabled && a !== 'pause' && a !== 'help') return;
    if (/^Digit[1-7]$/.test(e.code) && !a) { this.handler.digit(Number(e.code.slice(5))); return; }
    if (a) this.handler.action(a, true, e);
  };

  private onUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
    const a = this.actionFor(e.code);
    if (a && this.enabled) this.handler.action(a, false, e);
  };

  dispose() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
  }
}
