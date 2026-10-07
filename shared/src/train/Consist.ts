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
  /** permanently coupled sections (WAG-12B: 2, each with a cab at its outer end); lengthM, massT and axles are for the whole loco */
  sections?: number;
  /** procedural body style (client): twin-cab body, one freight section, or a diesel hood unit */
  bodyStyle?: 'twin-cab' | 'freight-section' | 'diesel-hood';
  /** a real 3D model (GLB) replacing the procedural exterior once loaded; see LocoModelFile */
  model?: LocoModelFile;
  /** diesel-electric engine (type "diesel"): no pantograph or VCB */
  diesel?: DieselData;
}

export interface DieselData {
  /** engine gross power (kW); maxPowerKW is the power at the rail */
  engineKW: number;
  idleRpm: number;
  maxRpm: number;
  cylinders: number;
  /** cranking time before the engine fires (s) */
  crankS: number;
  /** turbocharger lag: time constant (s) of the power build-up after notching up */
  turboLagS: number;
  fuelLitres: number;
  /** exhaust stack position from the loco centre (m, along the loco) */
  stackX: number;
}

/**
 * A real 3D model (GLB) for a loco, fitted entirely by these values - the
 * file itself is never edited. The game loads the optimised copies written
 * by `npm run models` (KTX2 textures, Meshopt geometry, 3 LODs) and shows the
 * procedural model until it has loaded (or if it fails).
 */
export interface LocoModelFile {
  /** source GLB, relative to client/public */
  file: string;
  /** uniform scale, rotation (degrees, XYZ order, applied before the scale) and offset (m) in the loco frame: +x front, +y up from rail top, +z right */
  scale: number;
  rotationDeg: [number, number, number];
  offset: [number, number, number];
  /**
   * Bogies: the node (or several nodes, grouped) that make up each bogie, and
   * its wheelset nodes (spun about their own axle; leave empty when the model
   * merges a bogie's wheels into one mesh)
   */
  bogies: { node: string | string[]; wheels: string[] }[];
  /**
   * Use only part of the file: parts whose centre lies in [min, max] along a
   * source-model axis (0 x, 1 y, 2 z). For a twin-section loco modelled whole,
   * this keeps one section; the game shows it once per section.
   */
  keep?: { axis: 0 | 1 | 2; min?: number; max?: number };
  /**
   * The model's own pantograph arms are not rigged: remove these parts and use
   * the game's animated pantograph at x (m, loco frame) on the roof instead.
   */
  proceduralPantographs?: { remove: string[]; x: number[] };
  /** pantograph arms: lower arm (pivots at its base), upper arm with the pan head (pivots at the knee), knee joint part */
  pantographs: { lower: string; upper: string; joint?: string }[];
  /** parts hidden in the cab view when our procedural cab is used (no `cab` below): the model's own interior */
  hideInCab: string[];
  /**
   * Use the model's own cab in the first-person view: our procedural cab and
   * its clickable desk are not shown; the loco is driven with the keyboard,
   * gamepad or the touch controls. `eye`: driver's eye (m, loco frame).
   */
  cab?: { eye: [number, number, number]; interior?: 'wag12' };
  /** materials that are window glass (exported opaque): rendered see-through */
  glassMaterials?: string[];
  /** parts removed from the model (placeholders replaced by the game's own) */
  remove?: string[];
  /** where our headlight and marker lamps go on the model (m, loco frame, front cab; mirrored for the rear one) */
  lights: { head: [number, number]; markers: [number, number, number] };
  /** roughness / metalness for the model's materials (exported models are often flat 0.5 / 0) */
  look?: { roughness: number; metalness: number };
  /** text repainted on the model's textures by the optimiser (texture index, pixel rect x y w h) */
  texturePatches?: { texture: number; rect: [number, number, number, number]; fill: string; text: string; color: string; size: number }[];
  author?: string;
  licence?: string;
  source?: string;
}

/** Number of permanently coupled sections of a loco (1 for most). */
export const sectionsOf = (l: LocoData) => Math.max(1, Math.round(l.sections ?? 1));

export interface CoachData {
  id: string; name: string; massEmptyT: number; massLoadedT: number; lengthM: number;
  bogieCentresM: number; axleSpacingM: number; maxBrakeForceKN: number;
  resistance: { aN: number; bNperMs: number; cNperMs2: number };
  livery: { body: string; band: string; roof: string; window: string };
  windows: 'open' | 'sealed' | 'none'; interiorLight: string;
}

export interface Vehicle {
  kind: 'loco' | 'coach';
  /** locos: which unit (0 = the lead loco) and section of it; `reversed`: the section faces the rear (its cab at the back) */
  unit?: number;
  section?: number;
  reversed?: boolean;
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

/** `locos`: number of loco units (1-2) worked from the lead cab (multiple working) */
export interface ConsistSpec { loco: string; coaches: { type: string; count: number }[]; loaded?: boolean; locos?: number }

export const COUPLER_GAP = 0.6;

export class Consist {
  readonly vehicles: Vehicle[] = [];
  readonly length: number;
  readonly mass: number;
  readonly locoMass: number;
  /** loco units in multiple working (all powered from the lead cab) */
  readonly locoUnits: number;

  constructor(readonly loco: LocoData, coachTypes: Record<string, CoachData>, spec: ConsistSpec) {
    let off = 0;
    this.locoUnits = Math.max(1, Math.min(2, Math.round(spec.locos ?? 1)));
    // one vehicle per loco section (a twin-section loco bends at its middle coupling on curves);
    // rolling resistance is shared out, air drag (c) is on the leading section only
    const n = sectionsOf(loco), secL = loco.lengthM / n;
    for (let u = 0; u < this.locoUnits; u++) for (let s = 0; s < n; s++) {
      const lead = u === 0 && s === 0;
      this.vehicles.push({
        kind: 'loco', typeId: loco.id, massKg: (loco.massT * 1000) / n, length: secL, frontOffset: off,
        bogieCentres: loco.bogieCentresM, axleSpacing: loco.axleSpacingM, maxBrakeN: (loco.brakes.maxBrakeForceKN * 1000) / n,
        davis: { a: loco.resistance.aN / n, b: loco.resistance.bNperMs / n, c: lead ? loco.resistance.cNperMs2 : 0 },
        unit: u, section: s, reversed: n > 1 && s === n - 1,
      });
      off += secL + (s < n - 1 ? 0.3 : COUPLER_GAP);
    }
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
    this.locoMass = loco.massT * 1000 * this.locoUnits;
    if (!(this.length > 0) || !(this.mass > 0)) throw new Error(`Consist for loco "${loco.id}" has invalid length (${this.length}) or mass (${this.mass}) - check the locomotive/coach data files`);
  }

  get coachCount() { return this.vehicles.filter(v => v.kind === 'coach').length; }
  /** vehicles that are locomotive sections */
  get locoVehicles() { return this.vehicles.filter(v => v.kind === 'loco').length; }
}
