import { buildElevation, ProfilePoint } from './Gradient';
import { resolveSegments, SegmentDef } from './TrackSegment';

/** Rail centre spacing for broad gauge cant angle (1676 mm gauge + head width). */
export const CANT_BASE_MM = 1750;
export const GAUGE_M = 1.676;
/** Height of rail top above formation level. */
export const RAIL_TOP = 0.63;

export interface TrackFrame {
  x: number; y: number; z: number; // y = formation level (add RAIL_TOP for rail top)
  heading: number; // radians; direction = (cos h, 0, sin h)
  cant: number;    // radians, + = right rail low (left high) for right curves
  grade: number;   // rise/run
  curvature: number;
}

export const newFrame = (): TrackFrame => ({ x: 0, y: 0, z: 0, heading: 0, cant: 0, grade: 0, curvature: 0 });

/**
 * The route centreline, integrated once at 1 m resolution from segment
 * curvature (clothoids come out exact enough at this step). All queries are
 * O(1) table lookups with linear interpolation.
 */
export class Alignment {
  readonly length: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly heading: Float64Array;
  readonly curvature: Float32Array;
  readonly cantMm: Float32Array;
  readonly elev: Float64Array;
  readonly grade: Float32Array;

  constructor(segments: SegmentDef[], profile: ProfilePoint[], startElev = 100) {
    const segs = resolveSegments(segments);
    const last = segs[segs.length - 1];
    this.length = last.start + last.length;
    const n = Math.floor(this.length) + 1;
    this.x = new Float64Array(n);
    this.z = new Float64Array(n);
    this.heading = new Float64Array(n);
    this.curvature = new Float32Array(n);
    this.cantMm = new Float32Array(n);

    const kAt = (s: number) => {
      // binary search would be faster; 80 segments * 54k samples is still trivial
      for (const g of segs) {
        if (s <= g.start + g.length) {
          const t = g.length > 0 ? (s - g.start) / g.length : 0;
          return [g.k0 + (g.k1 - g.k0) * t, g.c0 + (g.c1 - g.c0) * t];
        }
      }
      return [0, 0];
    };

    let x = 0, z = 0, h = 0;
    for (let i = 0; i < n; i++) {
      const [k, c] = kAt(i);
      this.curvature[i] = k;
      this.cantMm[i] = c;
      this.x[i] = x; this.z[i] = z; this.heading[i] = h;
      // midpoint integration of the heading
      const [kn] = kAt(i + 1);
      const hm = h + (k + kn) * 0.25;
      x += Math.cos(hm);
      z += Math.sin(hm);
      h += (k + kn) * 0.5;
    }
    const e = buildElevation(profile, this.length, startElev);
    this.elev = e.elev;
    this.grade = e.grade;
  }

  /** Fill `out` for chainage s (metres). Clamped to the route. */
  sample(s: number, out: TrackFrame): TrackFrame {
    const max = this.x.length - 1;
    const c = s < 0 ? 0 : s > max ? max : s;
    const i = Math.min(Math.floor(c), max - 1);
    const t = c - i;
    const ext = s - c; // extrapolate straight beyond the ends
    const h = this.heading[i] + (this.heading[i + 1] - this.heading[i]) * t;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t + Math.cos(h) * ext;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t + Math.sin(h) * ext;
    out.y = this.elev[i] + (this.elev[i + 1] - this.elev[i]) * t;
    out.heading = h;
    out.curvature = this.curvature[i] + (this.curvature[i + 1] - this.curvature[i]) * t;
    out.grade = this.grade[i] + (this.grade[i + 1] - this.grade[i]) * t;
    const cmm = this.cantMm[i] + (this.cantMm[i + 1] - this.cantMm[i]) * t;
    out.cant = Math.asin(Math.min(0.2, cmm / CANT_BASE_MM)) * Math.sign(out.curvature || 1);
    return out;
  }

  /** Frame of a parallel track `offset` metres to the right of the centreline. */
  sampleOffset(s: number, offset: number, out: TrackFrame): TrackFrame {
    this.sample(s, out);
    if (offset !== 0) {
      out.x += -Math.sin(out.heading) * offset;
      out.z += Math.cos(out.heading) * offset;
    }
    return out;
  }

  private tmp = newFrame();
  positionAt(km: number) { const f = this.sample(km * 1000, this.tmp); return { x: f.x, y: f.y, z: f.z }; }
  tangentAt(km: number) { const h = this.sample(km * 1000, this.tmp).heading; return { x: Math.cos(h), y: 0, z: Math.sin(h) }; }
  cantAt(km: number) { return this.sample(km * 1000, this.tmp).cant; }
  gradientAt(km: number) { return this.sample(km * 1000, this.tmp).grade; }
  elevationAt(km: number) { return this.sample(km * 1000, this.tmp).y; }
  curvatureAt(km: number) { return this.sample(km * 1000, this.tmp).curvature; }
  radiusAt(km: number) { const k = this.curvatureAt(km); return Math.abs(k) < 1e-6 ? Infinity : 1 / Math.abs(k); }
}
