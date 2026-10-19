import type { Route } from '../track/Route';
import type { Cargo, StationProfile } from '../track/StationProfile';
import type { CoachData, Consist, ConsistSpec } from '../train/Consist';

/**
 * The goods dispatcher: where a goods train loads and unloads on its way, by rules (no planning service).
 * Every goods yard sends some cargoes and receives others (StationProfile); every wagon carries one cargo or
 * is empty, and can carry some cargoes (CoachData.carries). Going along the line, at each yard the train can
 * be routed into (its goods line on the train's side, long enough for the whole train):
 *   - wagons loaded with a cargo the yard receives are unloaded there;
 *   - empty wagons that can carry a cargo it sends are loaded with it (its first such cargo).
 * A yard whose siding is too short for the train is passed by, with the reason. The same for the player (Route
 * Mode suggestions, Free Roam and goods scenarios) and AI goods trains.
 */
export interface PlanWagon { carries: Cargo[]; loaded: boolean; cargo?: Cargo }
export interface GoodsStation { code: string; name: string; km: number; profile?: StationProfile; goodsLine?: { id: string; lengthKm: number } }
export interface GoodsStop {
  station: string; name: string; line: string; work: ('unload' | 'load')[];
  unload: { cargo: Cargo; wagons: number }[]; load: { cargo: Cargo; wagons: number }[];
  /** for the player: "Unload 20 wagons of cement at Retiwala (goods siding)" */
  note: string;
}
export interface GoodsSkip { station: string; name: string; reason: string }

export const CARGO_NAME: Record<Cargo, string> = {
  grain: 'grain', sugar: 'sugar', cement: 'cement', stone: 'stone', marble: 'marble', salt: 'salt', fish: 'fish',
  tea: 'tea', timber: 'timber', steel: 'steel', cartons: 'cartons', fertiliser: 'fertiliser',
};

const wagonsOf = (n: number) => `${n} wagon${n > 1 ? 's' : ''}`;
const describe = (u: GoodsStop['unload'], l: GoodsStop['load'], name: string) => {
  const say = [...u.map(x => `unload ${wagonsOf(x.wagons)} of ${CARGO_NAME[x.cargo]}`), ...l.map(x => `load ${wagonsOf(x.wagons)} with ${CARGO_NAME[x.cargo]}`)].join(', then ');
  return `${say.charAt(0).toUpperCase()}${say.slice(1)} at ${name} (goods siding)`;
};

/** Plan the train's goods work along `stations` (in running order). `wagons` are changed as the plan goes (pass a copy). */
export function planGoods(stations: GoodsStation[], wagons: PlanWagon[], trainLengthM: number): { stops: GoodsStop[]; skipped: GoodsSkip[] } {
  const stops: GoodsStop[] = [], skipped: GoodsSkip[] = [];
  for (const st of stations) {
    const yard = st.profile?.goods;
    if (!yard || !st.goodsLine) continue;
    const unloadIdx = wagons.map((w, i) => (w.loaded && w.cargo && yard.receives.includes(w.cargo) ? i : -1)).filter(i => i >= 0);
    const loadAs = wagons.map(w => (!w.loaded ? yard.sends.find(c => w.carries.includes(c)) : undefined));
    // (wagons emptied here can be loaded again here)
    for (const i of unloadIdx) loadAs[i] = yard.sends.find(c => wagons[i].carries.includes(c));
    const loadIdx = loadAs.map((c, i) => (c ? i : -1)).filter(i => i >= 0);
    if (!unloadIdx.length && !loadIdx.length) continue;
    const siding = Math.round(st.goodsLine.lengthKm * 1000);
    if (siding < trainLengthM + 20) {
      skipped.push({ station: st.code, name: st.name, reason: `The train (${Math.round(trainLengthM)} m) is longer than the goods siding at ${st.name} (${siding} m): passed by` });
      continue;
    }
    const count = (idx: number[], of: (i: number) => Cargo) => {
      const m = new Map<Cargo, number>();
      for (const i of idx) m.set(of(i), (m.get(of(i)) ?? 0) + 1);
      return [...m].map(([cargo, n]) => ({ cargo, wagons: n }));
    };
    const unload = count(unloadIdx, i => wagons[i].cargo!), load = count(loadIdx, i => loadAs[i]!);
    for (const i of unloadIdx) { wagons[i].loaded = false; wagons[i].cargo = undefined; }
    for (const i of loadIdx) { wagons[i].loaded = true; wagons[i].cargo = loadAs[i]; }
    stops.push({ station: st.code, name: st.name, line: st.goodsLine.id, work: [...(unload.length ? ['unload' as const] : []), ...(load.length ? ['load' as const] : [])], unload, load, note: describe(unload, load, st.name) });
  }
  return { stops, skipped };
}

/** What the train will do at one yard now (for the player's next stop: "Unload 20 wagons of cement at Retiwala (goods siding)"). */
export function yardNote(st: { code: string; name: string; km: number; profile?: StationProfile }, wagons: PlanWagon[]) {
  return planGoods([{ ...st, goodsLine: { id: 'goods', lengthKm: Infinity } }], wagons.map(w => ({ ...w })), 0).stops[0]?.note ?? null;
}

/** The stations of a route's view (its direction) ahead of `fromKm`, with the goods line this direction can use. */
export function goodsStations(view: Route, fromKm = -Infinity): GoodsStation[] {
  return view.stations.filter(s => s.km > fromKm).map(s => {
    const gl = s.goodsLine ? s.lineInfo.find(l => l.id === s.goodsLine) : undefined;
    return { code: s.code, name: s.name, km: s.km, profile: s.profile, goodsLine: gl ? { id: gl.id, lengthKm: gl.toKm - gl.fromKm } : undefined };
  });
}

/** A consist's goods wagons for planning (from its spec, before it runs; or from a running consist). */
export function planWagonsOfSpec(spec: ConsistSpec, coaches: Record<string, CoachData>): PlanWagon[] {
  return spec.coaches.flatMap(g => {
    const c = coaches[g.type];
    if (!c || !(c.carries?.length || c.load)) return [];
    const carries = c.carries ?? [c.load!];
    return Array.from({ length: g.count }, () => ({ carries, loaded: spec.loaded !== false, cargo: spec.loaded !== false ? g.cargo ?? c.load ?? carries[0] : undefined }));
  });
}
export function planWagonsOfConsist(c: Consist, coaches: Record<string, CoachData>): PlanWagon[] {
  return c.vehicles.flatMap(v => {
    const t = coaches[v.typeId];
    if (v.kind !== 'coach' || !t || !(t.carries?.length || t.load)) return [];
    return [{ carries: t.carries ?? [t.load!], loaded: v.loaded !== false, cargo: v.cargo }];
  });
}
