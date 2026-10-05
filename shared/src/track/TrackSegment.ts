// Horizontal alignment segments. A transition (clothoid) ramps curvature and cant
// linearly between its neighbours, so data only gives its length.

export interface SegmentDef {
  type: 'straight' | 'curve' | 'transition';
  lengthM: number;
  radiusM?: number;
  direction?: 'left' | 'right';
  cantMm?: number;
}

export interface ResolvedSegment {
  start: number; // metres from route start
  length: number;
  k0: number; k1: number; // curvature 1/m, + = right turn
  c0: number; c1: number; // cant mm
  type: SegmentDef['type'];
}

const curvatureOf = (s: SegmentDef) =>
  s.type === 'curve' ? (s.direction === 'left' ? -1 : 1) / (s.radiusM ?? 1000) : 0;
const cantOf = (s: SegmentDef) => (s.type === 'curve' ? s.cantMm ?? 0 : 0);

export function resolveSegments(defs: SegmentDef[]): ResolvedSegment[] {
  const out: ResolvedSegment[] = [];
  let s = 0;
  defs.forEach((d, i) => {
    let k0 = curvatureOf(d), k1 = k0, c0 = cantOf(d), c1 = c0;
    if (d.type === 'transition') {
      const prev = defs[i - 1], next = defs[i + 1];
      k0 = prev ? curvatureOf(prev) : 0;
      c0 = prev ? cantOf(prev) : 0;
      k1 = next ? curvatureOf(next) : 0;
      c1 = next ? cantOf(next) : 0;
    }
    out.push({ start: s, length: d.lengthM, k0, k1, c0, c1, type: d.type });
    s += d.lengthM;
  });
  return out;
}
