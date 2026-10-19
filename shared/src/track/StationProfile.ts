import { hash2 } from '../util';
import type { StationData } from './Route';

/**
 * A station's personality (data/stations/<route>.json): its class, look, landmark and goods yard. Every field
 * but the class may be left out: a seeded choice from the station code fills it (the same every run).
 *
 * The class also sets the layout of an ordinary two-platform station (no loops of its own in the route file):
 *   halt, rural   as in the route file
 *   town          a loop on the building's side: an outer platform (1) and an island (2/3), the far side's (4)
 *   city          loops both sides: platforms 1, 2/3, 4/5, 6, and the full-length roofs, two foot over bridges
 * Junctions keep their own architecture; freight crossing stations their loops.
 */
export type StationClass = 'halt' | 'rural' | 'town' | 'city';
export type StationScheme = 'cream-maroon' | 'yellow-red' | 'white-blue' | 'stone';
export type CanopyType = 'shelter' | 'long' | 'cast-iron' | 'steel' | 'tiled';
export type Landmark = 'banyan' | 'watertank' | 'signalcabin' | 'clock' | 'garden' | 'steamloco' | 'viewdeck' | 'well';
export type Stall = 'tea' | 'snacks' | 'books' | 'fruit';
export type Cargo = 'grain' | 'sugar' | 'cement' | 'stone' | 'marble' | 'salt' | 'fish' | 'tea' | 'timber' | 'steel' | 'cartons' | 'fertiliser';

export interface GoodsYard {
  /** the side of the line it is on (+1: increasing offsets, the Up side); the trains of that side's running line use it */
  side: 1 | -1;
  /** the goods line's id at the station (its loop) */
  line: string;
  /** the line's offset, and the loading platform's inner and outer edges (offsets) */
  offset: number; platformFrom: number; platformTo: number;
  /** what is handled here (the stacks on the platform) */
  cargo: Cargo[];
  /** what it loads into wagons, and what wagons bring it (GoodsPlanner) */
  sends: Cargo[]; receives: Cargo[];
}

export interface StationProfile {
  class: StationClass;
  scheme: StationScheme;
  canopy: CanopyType;
  landmark: Landmark;
  stalls: Stall[];
  /** boards beside the name board: height above sea level (ghats, hills), "Hill station 2 km"... */
  boards: string[];
  goods?: GoodsYard;
}

/** what the data file may say (every field optional but the class) */
export interface StationProfileData {
  class?: StationClass; scheme?: StationScheme; canopy?: CanopyType; landmark?: Landmark; stalls?: Stall[]; boards?: string[];
  goods?: { side?: 1 | -1; cargo?: Cargo[]; sends?: Cargo[]; receives?: Cargo[] } | boolean;
}

const pick = <T>(list: readonly T[], code: string, salt: number) => list[Math.floor(hash2([...code].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100003, salt, 773) * list.length)];
export const SCHEMES: StationScheme[] = ['cream-maroon', 'yellow-red', 'white-blue', 'stone'];
export const LANDMARKS: Landmark[] = ['banyan', 'watertank', 'signalcabin', 'clock', 'garden', 'steamloco', 'viewdeck', 'well'];

/** The class a station has when its data file does not say. */
export const defaultClass = (s: StationData): StationClass => (s.type === 'halt' ? 'halt' : s.type === 'terminal' ? 'town' : 'rural');

/** The station's full profile: the data's choices, the rest seeded from its code. */
export function resolveProfile(s: StationData, d: StationProfileData = {}, cargo: Cargo[] = ['grain', 'cartons']): StationProfile {
  const cls = d.class ?? defaultClass(s);
  const canopy = d.canopy ?? (cls === 'halt' ? 'shelter' : cls === 'city' ? 'steel' : cls === 'town' ? pick(['long', 'cast-iron', 'tiled'] as const, s.code, 2) : pick(['shelter', 'long', 'tiled'] as const, s.code, 3));
  const stalls = d.stalls ?? (cls === 'halt' ? [] : cls === 'rural' ? ['tea'] : cls === 'town' ? ['tea', pick(['snacks', 'fruit', 'books'] as const, s.code, 4)] : ['tea', 'snacks', 'books', 'fruit']) as Stall[];
  return {
    class: cls,
    scheme: d.scheme ?? pick(SCHEMES, s.code, 1),
    canopy,
    landmark: d.landmark ?? pick(LANDMARKS, s.code, 5),
    stalls,
    boards: d.boards ?? [],
    goods: d.goods ? goodsYard(s, cls, typeof d.goods === 'object' ? d.goods : {}, cargo) : undefined,
  };
}

const LOOP = 12.15, OUTER: [number, number] = [13.9, 19.9];

/**
 * The station as its class lays it out (see the top): loops and platforms added to an ordinary station with
 * a platform each side on the running lines, and the goods line beyond everything on the yard's side.
 */
export function applyProfile(s: StationData, p: StationProfile): StationData {
  let out: StationData = { ...s, profile: p };
  const plain = !s.junction && !s.servicePlatformM && !s.lines.length && s.platforms.length === 2 && s.platforms.every(x => x.lines.length === 1);
  if (plain && (p.class === 'town' || p.class === 'city')) {
    const near = (side: number) => s.platforms.find(x => Math.sign(x.from) === side)!;
    const sides = p.class === 'city' ? [s.buildingSide, -s.buildingSide] : [s.buildingSide];
    const lines = [...s.lines], platforms: StationData['platforms'] = [];
    let n = 1;
    for (const side of [s.buildingSide, -s.buildingSide]) {
      const pf = near(side), run = pf.lines[0];
      if (!sides.includes(side)) { platforms.push({ ...pf, num: `${n++}` }); continue; }
      const id = side > 0 ? 'UL' : 'DL';
      lines.push({ id, offset: side * LOOP });
      // outer platform first from the building side, the island after it (numbered from the building outwards)
      const outer = { num: '', from: side * OUTER[0], to: side * OUTER[1], lines: [id] }, island = { num: '', from: pf.from, to: pf.to, lines: [run, id] };
      if (side === s.buildingSide) { outer.num = `${n++}`; island.num = `${n}/${n + 1}`; n += 2; platforms.push(outer, island); }
      else { island.num = `${n}/${n + 1}`; n += 2; outer.num = `${n++}`; platforms.push(island, outer); }
    }
    out = { ...out, lines, platforms };
  }
  if (p.goods) {
    const g = p.goods;
    out = { ...out, lines: [...out.lines, { id: g.line, offset: g.offset, role: 'goods' }] };
  }
  return out;
}

/** The goods yard of a station of this class: beyond its outermost platform or loop on the yard's side. */
function goodsYard(s: StationData, cls: StationClass, d: { side?: 1 | -1; cargo?: Cargo[]; sends?: Cargo[]; receives?: Cargo[] }, cargo: Cargo[]): GoodsYard {
  const side = d.side ?? (-s.buildingSide as 1 | -1);
  // what will be there on that side once the class has laid the station out
  const loopsBoth = cls === 'city', loopHere = cls === 'city' || (cls === 'town' && side === s.buildingSide);
  const plain = !s.junction && !s.servicePlatformM && !s.lines.length && s.platforms.length === 2;
  const edges = [
    ...s.platforms.flatMap(x => [x.from, x.to]).filter(v => Math.sign(v) === side).map(Math.abs),
    ...s.lines.filter(l => Math.sign(l.offset) === side).map(l => Math.abs(l.offset) + 1.6),
    ...(plain && (loopHere || loopsBoth) ? [OUTER[1]] : []),
  ];
  const outer = Math.max(...edges, 4);
  const offset = side * (outer + 1.75);
  const handled = d.cargo ?? cargo;
  // (by default it sends the first of what it handles - its own produce - and receives the rest)
  const sends = d.sends ?? handled.slice(0, Math.max(1, Math.ceil(handled.length / 2))), receives = d.receives ?? handled.filter(c => !sends.includes(c));
  return { side, line: side > 0 ? 'UG' : 'DG', offset, platformFrom: side * (outer + 3.5), platformTo: side * (outer + 12.5), cargo: [...new Set([...handled, ...sends, ...receives])], sends, receives };
}
