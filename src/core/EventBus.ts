// Typed pub/sub. Systems emit and listen here instead of importing each other.

export type Aspect = 'R' | 'Y' | 'YY' | 'G';

export interface GameEvents {
  /** A cab control changed (from keyboard, mouse click on cab, or gamepad). */
  'control': { id: string; value: number | string | boolean };
  'control-click': { id: string };
  'horn': { on: boolean; tone: 'low' | 'high' };
  'message': { text: string; kind?: 'info' | 'warn' | 'penalty' | 'good'; ms?: number };
  'penalty': { rule: string; points: number; text: string };
  'score': { category: string; points: number; text: string };
  'spad': { signalId: string };
  'scenario-end': { success: boolean; reason: string };
  'station-arrival': { code: string; name: string; errorM: number; lateS: number };
  'station-departure': { code: string };
  'signal-passed': { id: string; aspect: Aspect };
  'coupler-jolt': { magnitude: number };
  'wheel-slip': { on: boolean };
  'vigilance': { state: 'ok' | 'warning' | 'penalty' };
  'camera': { mode: number };
  'lightning': { intensity: number };
  'switch-crossed': { id: string };
  'pantograph': { up: boolean };
  'vcb': { closed: boolean };
  'announcement': { stationCode: string };
  'ui-toggle': { what: 'hud' | 'map' | 'perf' | 'help' | 'pause' };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E> {
  private handlers = new Map<keyof E, Set<Handler<any>>>();

  on<K extends keyof E>(type: K, h: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  emit<K extends keyof E>(type: K, payload: E[K]) {
    const set = this.handlers.get(type);
    if (set) for (const h of set) h(payload);
  }
}

export const bus = new EventBus<GameEvents>();
