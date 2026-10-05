// Indian-style gradient notation: "level", "1 in 150 up", "1 in 60 down".
// Positive grade = rising in the direction of increasing km.

export function parseGradient(s: string): number {
  const t = s.trim().toLowerCase();
  if (t === 'level' || t === 'flat') return 0;
  const m = /^1\s*in\s*([\d.]+)\s*(up|down|rising|falling)?$/.exec(t);
  if (!m) throw new Error(`Bad gradient "${s}"`);
  const g = 1 / parseFloat(m[1]);
  return m[2] === 'down' || m[2] === 'falling' ? -g : g;
}

export function formatGradient(g: number): string {
  if (Math.abs(g) < 1 / 2000) return 'Level';
  return `1 in ${Math.round(1 / Math.abs(g))} ${g > 0 ? 'up' : 'down'}`;
}

export interface ProfilePoint { km: number; gradient: string }

/**
 * Builds per-metre elevation with vertical curves: the raw step gradient is
 * smoothed with a moving average, which turns each grade change into a
 * parabolic vertical curve of length `vcLength`.
 */
export function buildElevation(profile: ProfilePoint[], lengthM: number, startElev: number, vcLength = 200) {
  const n = Math.floor(lengthM) + 1;
  const raw = new Float64Array(n);
  const pts = [...profile].sort((a, b) => a.km - b.km);
  let pi = 0;
  for (let i = 0; i < n; i++) {
    while (pi + 1 < pts.length && pts[pi + 1].km * 1000 <= i) pi++;
    raw[i] = pts.length ? parseGradient(pts[pi].gradient) : 0;
  }
  const half = Math.floor(vcLength / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + raw[i];
  const grade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    grade[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  const elev = new Float64Array(n);
  elev[0] = startElev;
  for (let i = 1; i < n; i++) elev[i] = elev[i - 1] + (grade[i - 1] + grade[i]) * 0.5;
  return { grade, elev };
}
