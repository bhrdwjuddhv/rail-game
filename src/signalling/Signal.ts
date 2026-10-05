import type { Aspect } from '../core/EventBus';
import type { SignalDef } from '../track/Route';

export type { Aspect };

export class Signal {
  aspect: Aspect = 'R';
  callingOn = false;
  /** platform/line label shown by the junction route indicator, or null when dark */
  routeIndicator: string | null = null;
  constructor(readonly def: SignalDef) {}
  get id() { return this.def.id; }
  get km() { return this.def.km; }
  /** Distant signals are permissive repeaters; everything else is a stop signal. */
  get isStop() { return this.def.kind !== 'distant'; }
}

export const ASPECT_RANK: Record<Aspect, number> = { R: 0, Y: 1, YY: 2, G: 3 };

/** Anything that occupies track: the player's train or an AI train. */
export interface Occupant {
  id: string;
  headKm: number;
  tailKm: number;
  offsetAt(km: number): number;
}
