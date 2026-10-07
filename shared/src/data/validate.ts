// Load-time validation for data files. Every locomotive / coach / route JSON is
// checked against a small schema (required fields + sane number ranges) and
// gets a clear message naming the file and the field. Locomotives written in the
// nested layout (dimensions.* / performance.* / traction.*) are normalised to the
// flat layout the engine reads, so both styles work.

export interface DataIssue { file: string; level: 'error' | 'warning'; message: string }

type Num = { kind: 'number'; min: number; max: number; optional?: boolean };
type Str = { kind: 'string'; optional?: boolean };
type Arr = { kind: 'array'; minItems: number };
type Rule = Num | Str | Arr;
const num = (min: number, max: number, optional = false): Num => ({ kind: 'number', min, max, optional });
const str = (optional = false): Str => ({ kind: 'string', optional });
const arr = (minItems = 1): Arr => ({ kind: 'array', minItems });

const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const set = (o: any, path: string, value: unknown) => {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys[keys.length - 1]] = value;
};

function checkRules(file: string, obj: any, rules: Record<string, Rule>, issues: DataIssue[]) {
  for (const [path, r] of Object.entries(rules)) {
    const v = get(obj, path);
    if (v === undefined || v === null) {
      if (!(r as Num | Str).optional) issues.push({ file, level: 'error', message: `missing required field "${path}"` });
      continue;
    }
    if (r.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ file, level: 'error', message: `"${path}" must be a number (got ${JSON.stringify(v)})` });
      else if (v < r.min || v > r.max) issues.push({ file, level: 'error', message: `"${path}" = ${v} is outside ${r.min}..${r.max}` });
    } else if (r.kind === 'string') {
      if (typeof v !== 'string' || !v) issues.push({ file, level: 'error', message: `"${path}" must be a non-empty string` });
    } else if (!Array.isArray(v) || v.length < r.minItems) {
      issues.push({ file, level: 'error', message: `"${path}" must be an array with at least ${r.minItems} item(s)` });
    }
  }
}

// ---------------------------------------------------------------- locomotives
const LOCO_RULES: Record<string, Rule> = {
  id: str(), name: str(), operator: str(), number: str(), type: str(),
  massT: num(20, 400), lengthM: num(8, 60), axles: num(2, 16), bogieCentresM: num(2, 40), axleSpacingM: num(1, 5), wheelDiameterM: num(0.6, 1.6),
  maxPowerKW: num(100, 20000), maxTractiveEffortKN: num(20, 1500), maxSpeedKmph: num(10, 250), notches: num(1, 40),
  'regen.maxEffortKN': num(0, 1200), 'regen.maxPowerKW': num(0, 20000), 'regen.fadeStartKmph': num(0, 60), 'regen.fadeEndKmph': num(0, 60), 'regen.notches': num(1, 40),
  'brakes.maxBrakeForceKN': num(10, 1000), 'brakes.independentMaxBarKgcm2': num(0.5, 6),
  'resistance.aN': num(0, 20000), 'resistance.bNperMs': num(0, 1000), 'resistance.cNperMs2': num(0, 100),
  'adhesion.dry': num(0.1, 0.6), 'adhesion.wet': num(0.05, 0.5), 'adhesion.damp': num(0.05, 0.6), 'adhesion.sanderBonus': num(0, 0.2),
  'electrical.lineVoltageKV': num(0.6, 50), 'electrical.motorCount': num(1, 16), 'electrical.ampsPerKN': num(0.1, 20),
  'livery.body': str(), 'livery.band': str(), 'livery.roof': str(), 'livery.underframe': str(), 'livery.logoText': str(),
  'soundProfile.motorBaseHz': num(5, 500), 'soundProfile.motorHzPerKmph': num(0, 50), 'soundProfile.hornLowHz': arr(), 'soundProfile.hornHighHz': arr(), 'soundProfile.blowerHz': num(10, 1000),
};

/** Alternative (nested) field locations accepted for locomotives, in priority order. */
const LOCO_ALIASES: Record<string, string[]> = {
  lengthM: ['dimensions.lengthM'],
  bogieCentresM: ['dimensions.bogieCentresM'],
  axleSpacingM: ['dimensions.axleSpacingM'],
  wheelDiameterM: ['dimensions.wheelDiameterM'],
  maxPowerKW: ['performance.maxPowerKW', 'performance.continuousPowerKW'],
  maxTractiveEffortKN: ['performance.maxTractiveEffortKN', 'performance.startingTractiveEffortKN'],
  maxSpeedKmph: ['performance.maxSpeedKmph'],
  'electrical.motorCount': ['traction.motorCount'],
};

/** Defaults for optional engineering details, applied with a warning so the author knows. */
const LOCO_DEFAULTS: Record<string, unknown> = {
  'electrical.ampsPerKN': 3.4,
  'electrical.lineVoltageKV': 25,
  'regen.fadeStartKmph': 15,
  'regen.fadeEndKmph': 3,
  'adhesion.sanderBonus': 0.07,
  'livery.underframe': '#26282a',
  'soundProfile.blowerHz': 100,
  cabLayout: 'ep-desk-left',
};

export function normaliseLoco(file: string, raw: unknown, issues: DataIssue[]) {
  const o = JSON.parse(JSON.stringify(raw ?? {}));
  for (const [path, alts] of Object.entries(LOCO_ALIASES)) {
    if (get(o, path) !== undefined) continue;
    const from = alts.find(a => get(o, a) !== undefined);
    if (from) set(o, path, get(o, from));
  }
  for (const [path, v] of Object.entries(LOCO_DEFAULTS)) {
    if (get(o, path) !== undefined) continue;
    set(o, path, v);
    issues.push({ file, level: 'warning', message: `"${path}" missing - using default ${JSON.stringify(v)}` });
  }
  const before = issues.length;
  checkRules(file, o, LOCO_RULES, issues);
  if (issues.slice(before).some(i => i.level === 'error')) return null;
  // physics sanity checks (warnings: the loco still runs)
  const weightKN = o.massT * 9.81;
  if (o.maxTractiveEffortKN > weightKN * o['adhesion'].dry * 1.02) {
    issues.push({ file, level: 'warning', message: `maxTractiveEffortKN ${o.maxTractiveEffortKN} needs adhesion ${(o.maxTractiveEffortKN / weightKN).toFixed(2)} but adhesion.dry is ${o.adhesion.dry}: full power will wheel-slip even on a dry rail` });
  }
  const brakeDecel = (o.brakes.maxBrakeForceKN * 1000) / (o.massT * 1000);
  if (brakeDecel > 2.0) issues.push({ file, level: 'warning', message: `brakes.maxBrakeForceKN ${o.brakes.maxBrakeForceKN} gives ${brakeDecel.toFixed(1)} m/s^2 on a light engine (wheels would lock above ~1.5); typical is ${Math.round(o.massT * 1.1)} kN or less` });
  if (o.regen.maxEffortKN > o.maxTractiveEffortKN * 1.2) issues.push({ file, level: 'warning', message: `regen.maxEffortKN (${o.regen.maxEffortKN}) is far above maxTractiveEffortKN (${o.maxTractiveEffortKN})` });
  const secL = o.lengthM / Math.max(1, o.sections ?? 1);
  if (o.bogieCentresM >= secL) issues.push({ file, level: 'error', message: `bogieCentresM (${o.bogieCentresM}) must be less than the section length (${secL.toFixed(1)} m)` });
  if (o.type === 'diesel') {
    const d = o.diesel;
    if (!d) issues.push({ file, level: 'error', message: 'a diesel loco needs a "diesel" block (engineKW, idleRpm, maxRpm, cylinders, crankS, turboLagS, fuelLitres, stackX)' });
    else for (const k of ['engineKW', 'idleRpm', 'maxRpm', 'cylinders', 'crankS', 'turboLagS', 'fuelLitres', 'stackX']) {
      if (typeof d[k] !== 'number' || !Number.isFinite(d[k])) issues.push({ file, level: 'error', message: `diesel.${k} must be a number` });
    }
    if (d && d.maxRpm <= d.idleRpm) issues.push({ file, level: 'error', message: 'diesel.maxRpm must be above diesel.idleRpm' });
  } else if (o.type !== 'electric') issues.push({ file, level: 'error', message: `type must be "electric" or "diesel", got ${JSON.stringify(o.type)}` });
  return issues.slice(before).some(i => i.level === 'error') ? null : o;
}

// ---------------------------------------------------------------- coaches
const COACH_RULES: Record<string, Rule> = {
  id: str(), name: str(), massEmptyT: num(5, 200), massLoadedT: num(5, 200), lengthM: num(5, 30), bogieCentresM: num(2, 25),
  axleSpacingM: num(1, 4), maxBrakeForceKN: num(1, 200), 'resistance.aN': num(0, 10000), 'resistance.bNperMs': num(0, 500), 'resistance.cNperMs2': num(0, 50),
  'livery.body': str(), 'livery.band': str(), 'livery.roof': str(), 'livery.window': str(), windows: str(), interiorLight: str(),
};

export function validateCoach(file: string, raw: any, issues: DataIssue[]) {
  const before = issues.length;
  checkRules(file, raw, COACH_RULES, issues);
  if (raw && raw.massLoadedT < raw.massEmptyT) issues.push({ file, level: 'error', message: 'massLoadedT must be >= massEmptyT' });
  if (raw && raw.bogieCentresM >= raw.lengthM) issues.push({ file, level: 'error', message: 'bogieCentresM must be less than lengthM' });
  return issues.slice(before).some(i => i.level === 'error') ? null : raw;
}

// ---------------------------------------------------------------- routes
const ROUTE_RULES: Record<string, Rule> = {
  id: str(), name: str(), startElevationM: num(-500, 5000), segments: arr(1), profile: arr(1), stations: arr(1), regions: arr(1),
  speedLimits: arr(1), scenery: arr(1), autoSignalSpacingKm: num(0.5, 10),
};

export function validateRoute(file: string, raw: any, regions: Record<string, unknown>, issues: DataIssue[]) {
  const before = issues.length;
  checkRules(file, raw, ROUTE_RULES, issues);
  raw?.segments?.forEach((s: any, i: number) => {
    if (!['straight', 'curve', 'transition'].includes(s.type)) issues.push({ file, level: 'error', message: `segments[${i}].type "${s.type}" must be straight/curve/transition` });
    if (!(s.lengthM > 0)) issues.push({ file, level: 'error', message: `segments[${i}].lengthM must be > 0` });
    if (s.type === 'curve' && !(s.radiusM > 50)) issues.push({ file, level: 'error', message: `segments[${i}].radiusM must be > 50 for a curve` });
  });
  // running lines: omitted / one line = single line "main"; two = double line, which must be UP and DOWN
  const double = Array.isArray(raw?.lines) && raw.lines.length > 1;
  if (raw?.lines !== undefined && !Array.isArray(raw.lines)) issues.push({ file, level: 'error', message: '"lines" must be a list like ["UP", "DOWN"]' });
  if (double && (raw.lines.length !== 2 || !raw.lines.includes('UP') || !raw.lines.includes('DOWN'))) issues.push({ file, level: 'error', message: `"lines" ${JSON.stringify(raw.lines)}: a double line must be exactly ["UP", "DOWN"]` });
  if (raw?.lineSpacingM !== undefined && !(raw.lineSpacingM >= 4 && raw.lineSpacingM <= 8)) issues.push({ file, level: 'error', message: `lineSpacingM ${raw.lineSpacingM} must be between 4 and 8 (broad gauge: about 5.3)` });
  const running: string[] = double ? ['UP', 'DOWN'] : [raw?.lines?.[0] ?? 'main'];
  const checkXo = (c: any, where: string, known: string[]) => {
    if (typeof c?.km !== 'number' || !known.includes(c.fromLine) || !known.includes(c.toLine)) issues.push({ file, level: 'error', message: `${where}: crossover needs numeric "km" and lines from ${known.join('/')}` });
  };
  raw?.stations?.forEach((s: any, i: number) => {
    const where = `stations[${i}] (${s?.code})`;
    if (!s.code || typeof s.km !== 'number') issues.push({ file, level: 'error', message: `stations[${i}] needs "code" and numeric "km"` });
    if (!Array.isArray(s.lines)) { issues.push({ file, level: 'error', message: `${where} needs a "lines" list (loops; [] for none)` }); return; }
    if (!double && !s.lines.some((l: any) => l.id === running[0])) issues.push({ file, level: 'error', message: `${where} needs a "${running[0]}" line` });
    const known = [...running, ...s.lines.map((l: any) => l.id)];
    for (const p of s.platforms ?? []) for (const l of p.lines ?? []) {
      if (!known.includes(l)) issues.push({ file, level: 'error', message: `${where} platform ${p.num} serves unknown line "${l}"` });
    }
    for (const c of s.crossovers ?? []) checkXo(c, where, known);
  });
  for (const c of raw?.crossovers ?? []) checkXo(c, 'crossovers', running);
  raw?.regions?.forEach((r: any, i: number) => {
    if (!regions[r.region]) issues.push({ file, level: 'error', message: `regions[${i}].region "${r.region}" has no data/regions file` });
  });
  return issues.slice(before).some(i => i.level === 'error') ? null : raw;
}

/** Print issues once, grouped, so authors see them in the console. */
export function reportIssues(issues: DataIssue[]) {
  for (const i of issues) (i.level === 'error' ? console.error : console.warn)(`[data] ${i.file}: ${i.message}`);
}
