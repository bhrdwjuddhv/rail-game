// Data shapes for rolling stock and the flat vehicle list the physics works on.

export interface LocoData {
  id: string; name: string; operator: string; number: string; type: 'electric' | 'diesel';
  massT: number; lengthM: number; axles: number; bogieCentresM: number; axleSpacingM: number; wheelDiameterM: number;
  maxPowerKW: number; maxTractiveEffortKN: number; maxSpeedKmph: number; notches: number;
  regen: { maxEffortKN: number; maxPowerKW: number; fadeStartKmph: number; fadeEndKmph: number; notches: number };
  brakes: { maxBrakeForceKN: number; independentMaxBarKgcm2: number };
  resistance: { aN: number; bNperMs: number; cNperMs2: number };
  adhesion: { dry: number; wet: number; damp: number; sanderBonus: number };
  electrical: { lineVoltageKV: number; motorCount: number; ampsPerKN: number };
  livery: { body: string; band: string; roof: string; underframe: string; logoText: string };
  cabLayout: string;
  soundProfile: { motorBaseHz: number; motorHzPerKmph: number; hornLowHz: number[]; hornHighHz: number[]; blowerHz: number };
}

export interface CoachData {
  id: string; name: string; massEmptyT: number; massLoadedT: number; lengthM: number;
  bogieCentresM: number; axleSpacingM: number; maxBrakeForceKN: number;
  resistance: { aN: number; bNperMs: number; cNperMs2: number };
  livery: { body: string; band: string; roof: string; window: string };
  windows: 'open' | 'sealed' | 'none'; interiorLight: string;
}

export interface Vehicle {
  kind: 'loco' | 'coach';
  typeId: string;
  massKg: number;
  length: number;
  /** distance from head of train to this vehicle's front, metres */
  frontOffset: number;
  bogieCentres: number;
  axleSpacing: number;
  maxBrakeN: number;
  davis: { a: number; b: number; c: number };
}

export interface ConsistSpec { loco: string; coaches: { type: string; count: number }[]; loaded?: boolean }

export const COUPLER_GAP = 0.6;

export class Consist {
  readonly vehicles: Vehicle[] = [];
  readonly length: number;
  readonly mass: number;
  readonly locoMass: number;

  constructor(readonly loco: LocoData, coachTypes: Record<string, CoachData>, spec: ConsistSpec) {
    let off = 0;
    this.vehicles.push({
      kind: 'loco', typeId: loco.id, massKg: loco.massT * 1000, length: loco.lengthM, frontOffset: 0,
      bogieCentres: loco.bogieCentresM, axleSpacing: loco.axleSpacingM, maxBrakeN: loco.brakes.maxBrakeForceKN * 1000,
      davis: { a: loco.resistance.aN, b: loco.resistance.bNperMs, c: loco.resistance.cNperMs2 },
    });
    off += loco.lengthM + COUPLER_GAP;
    for (const g of spec.coaches) {
      const c = coachTypes[g.type];
      if (!c) throw new Error(`Unknown coach type ${g.type}`);
      for (let i = 0; i < g.count; i++) {
        this.vehicles.push({
          kind: 'coach', typeId: c.id, massKg: (spec.loaded === false ? c.massEmptyT : c.massLoadedT) * 1000,
          length: c.lengthM, frontOffset: off, bogieCentres: c.bogieCentresM, axleSpacing: c.axleSpacingM,
          maxBrakeN: c.maxBrakeForceKN * 1000,
          davis: { a: c.resistance.aN, b: c.resistance.bNperMs, c: c.resistance.cNperMs2 },
        });
        off += c.lengthM + COUPLER_GAP;
      }
    }
    this.length = off - COUPLER_GAP;
    this.mass = this.vehicles.reduce((s, v) => s + v.massKg, 0);
    this.locoMass = loco.massT * 1000;
    if (!(this.length > 0) || !(this.mass > 0)) throw new Error(`Consist for loco "${loco.id}" has invalid length (${this.length}) or mass (${this.mass}) - check the locomotive/coach data files`);
  }

  get coachCount() { return this.vehicles.length - 1; }
}
