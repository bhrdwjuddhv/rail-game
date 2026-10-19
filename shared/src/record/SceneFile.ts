import { currentCoach } from '../train/Consist';
import type { DriveMode, DriveStyle } from './RecordTrain';

/** What a path does when its train reaches the end: stand, run back and repeat, start again, or leave. */
export type PathEnd = 'stop' | 'turnback' | 'loop' | 'disappear';
export type PathStart = 'now' | 'go' | 'after';

/** km here are surveyed km (the route data's), so a scene reads the same whatever line a train is on. */
export interface ScenePath {
  dest: { km: number; station?: string } | null;
  /** stations or points it runs through, with the line it takes there (a loop, the middle line) */
  via: { km: number; station?: string; line?: string }[];
  stopAtStations: boolean; stopS: number; boarding: boolean;
  /** "Stop here X s" */
  markers: { km: number; seconds: number }[];
  /** "Slow to X km/h" */
  slow: { fromKm: number; toKm: number; kmph: number }[];
  cruiseKmph: number; obeySignals: boolean; obeyLimits: boolean;
  end: PathEnd; start: PathStart; afterS: number;
}

export interface SceneTrain {
  name: string; loco: string; coaches: { type: string; count: number }[]; loaded: boolean;
  /** direction view (running line id: DOWN / UP) and the line offset in it */
  track: string; km: number; offset: number;
  mode: DriveMode; kmph: number; style: DriveStyle; obeySignals: boolean; obeyLimits: boolean;
  headlight: number; markers: boolean; cabLight: boolean; interior: boolean; panto: boolean; engine: boolean; smoke: number;
  autoHorn: boolean; doors: boolean;
  path: ScenePath | null;
}

/** Flat settings blocks (camera, film, world, record settings): names to numbers, strings or booleans. */
export type Flat = Record<string, number | string | boolean>;

export interface SceneFile {
  format: typeof SCENE_FORMAT; version: 1; name: string; route: string; savedAt: string;
  trains: SceneTrain[];
  /** camera bookmarks (index 0..8 = keys 1..9), each a pose and how it is held */
  bookmarks: ({ pos: number[]; quat: number[]; fov: number; relative: boolean; train: number; thumb?: string } | null)[];
  film: Flat; camera: Flat; world: Flat; settings: Flat;
}

export const SCENE_FORMAT = 'rail-bharat-record-scene';
const MODES: DriveMode[] = ['parked', 'auto', 'speed'];
const STYLE_IDS: DriveStyle[] = ['gentle', 'normal', 'aggressive'];
const ENDS: PathEnd[] = ['stop', 'turnback', 'loop', 'disappear'];
const STARTS: PathStart[] = ['now', 'go', 'after'];
const MAX_TRAINS = 24;
const THUMB_MAX = 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d: string, max = 80) => (typeof v === 'string' ? v.slice(0, max) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const pick = <T extends string>(v: unknown, list: T[], d: T) => (list.includes(v as T) ? (v as T) : d);
const flat = (v: unknown): Flat => {
  const out: Flat = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v).slice(0, 200)) {
    if (typeof x === 'boolean' || (typeof x === 'string' && x.length <= 200) || (typeof x === 'number' && Number.isFinite(x))) out[k.slice(0, 40)] = x;
  }
  return out;
};

export interface Known { locos: Set<string>; coaches: Set<string>; routeLengthKm: number; tracks: string[] }

/**
 * Read a scene file (an import or localStorage), keeping only what is valid:
 * numbers clamped to their ranges, unknown locos / coaches / lines dropped
 * with a note. Returns null with the reason when it is not a scene at all.
 */
export function readScene(raw: unknown, known: Known): { scene: SceneFile; notes: string[] } | { scene: null; notes: string[] } {
  if (!isObj(raw) || raw.format !== SCENE_FORMAT) return { scene: null, notes: ['Not a Rail Bharat Record Mode scene file'] };
  if (raw.version !== 1) return { scene: null, notes: [`Scene version ${String(raw.version)} is not supported (this game reads version 1)`] };
  const notes: string[] = [];
  const L = known.routeLengthKm;
  const km = (v: unknown) => num(v, 0, L, 0);
  const path = (p: unknown): ScenePath | null => {
    if (!isObj(p)) return null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObj).slice(0, 50) : []);
    return {
      dest: isObj(p.dest) ? { km: km(p.dest.km), station: typeof p.dest.station === 'string' ? p.dest.station.slice(0, 12) : undefined } : null,
      via: list(p.via).map(x => ({ km: km(x.km), station: typeof x.station === 'string' ? x.station.slice(0, 12) : undefined, line: typeof x.line === 'string' ? x.line.slice(0, 12) : undefined })),
      stopAtStations: bool(p.stopAtStations, false), stopS: num(p.stopS, 0, 3600, 30), boarding: bool(p.boarding, true),
      markers: list(p.markers).map(x => ({ km: km(x.km), seconds: num(x.seconds, 0, 3600, 10) })),
      slow: list(p.slow).map(x => ({ fromKm: km(x.fromKm), toKm: km(x.toKm), kmph: num(x.kmph, 5, 400, 30) })).filter(z => z.toKm > z.fromKm),
      cruiseKmph: num(p.cruiseKmph, 5, 400, 100), obeySignals: bool(p.obeySignals, true), obeyLimits: bool(p.obeyLimits, true),
      end: pick(p.end, ENDS, 'stop'), start: pick(p.start, STARTS, 'now'), afterS: num(p.afterS, 0, 3600, 0),
    };
  };
  const trains: SceneTrain[] = [];
  for (const [i, t] of (Array.isArray(raw.trains) ? raw.trains : []).entries()) {
    if (!isObj(t)) { notes.push(`Train ${i + 1}: not a train, skipped`); continue; }
    if (trains.length >= MAX_TRAINS) { notes.push(`More than ${MAX_TRAINS} trains: the rest were skipped`); break; }
    const loco = str(t.loco, '');
    if (!known.locos.has(loco)) { notes.push(`Train ${i + 1}: unknown locomotive "${loco}", skipped`); continue; }
    const track = str(t.track, known.tracks[0]);
    if (!known.tracks.includes(track)) { notes.push(`Train ${i + 1}: no ${track} line on this route, skipped`); continue; }
    // (a coach type no longer made: its replacement)
    const coaches = (Array.isArray(t.coaches) ? t.coaches : []).filter(isObj).map(c => ({ type: currentCoach(str(c.type, '')), count: Math.round(num(c.count, 0, 80, 0)) }));
    const bad = coaches.filter(c => !known.coaches.has(c.type));
    if (bad.length) notes.push(`Train ${i + 1}: unknown wagon types ${bad.map(c => `"${c.type}"`).join(', ')} left out`);
    trains.push({
      name: str(t.name, `Train ${i + 1}`, 40), loco, coaches: coaches.filter(c => known.coaches.has(c.type) && c.count > 0), loaded: bool(t.loaded, true),
      track, km: km(t.km), offset: num(t.offset, -40, 40, 0),
      mode: pick(t.mode, MODES, 'parked'), kmph: num(t.kmph, 0, 400, 60), style: pick(t.style, STYLE_IDS, 'normal'),
      obeySignals: bool(t.obeySignals, true), obeyLimits: bool(t.obeyLimits, true),
      headlight: Math.round(num(t.headlight, 0, 2, 1)), markers: bool(t.markers, true), cabLight: bool(t.cabLight, false), interior: bool(t.interior, true),
      panto: bool(t.panto, true), engine: bool(t.engine, true), smoke: num(t.smoke, 0, 2, 1), autoHorn: bool(t.autoHorn, true), doors: bool(t.doors, false),
      path: path(t.path),
    });
  }
  const bookmarks = (Array.isArray(raw.bookmarks) ? raw.bookmarks : []).slice(0, 9).map(b => {
    if (!isObj(b) || !Array.isArray(b.pos) || !Array.isArray(b.quat)) return null;
    const pos = b.pos.slice(0, 3).map(v => num(v, -1e6, 1e6, 0)), quat = b.quat.slice(0, 4).map(v => num(v, -1, 1, 0));
    if (pos.length !== 3 || quat.length !== 4) return null;
    const thumb = typeof b.thumb === 'string' && b.thumb.startsWith('data:image/') && b.thumb.length < THUMB_MAX ? b.thumb : undefined;
    return { pos, quat, fov: num(b.fov, 5, 120, 50), relative: bool(b.relative, false), train: Math.round(num(b.train, -1, MAX_TRAINS, -1)), thumb };
  });
  while (bookmarks.length < 9) bookmarks.push(null);
  return {
    scene: {
      format: SCENE_FORMAT, version: 1, name: str(raw.name, 'Imported scene', 60), route: str(raw.route, ''), savedAt: str(raw.savedAt, ''),
      trains, bookmarks, film: flat(raw.film), camera: flat(raw.camera), world: flat(raw.world), settings: flat(raw.settings),
    },
    notes,
  };
}
