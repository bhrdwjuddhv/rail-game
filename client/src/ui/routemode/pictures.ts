import type { CoachData, LocoData } from '@rail/shared/train/Consist';

/**
 * Side-view pictures of rolling stock drawn from its data (livery colours, kind, containers), all at
 * the same angle and light: picture cards, the consist strip, the journey review. Transparent
 * background; cached per vehicle type. Width follows the real length (8 px per metre).
 */
const PX = 8, H = 46;
const cache = new Map<string, string>();

const wheels = (x0: number, x1: number, y: number, r = 4.2) =>
  [x0 + 10, x0 + 22, x1 - 22, x1 - 10].map(x => `<circle cx="${x}" cy="${y}" r="${r}" fill="#222"/><circle cx="${x}" cy="${y}" r="${r * 0.45}" fill="#777"/>`).join('')
  + `<rect x="${x0 + 6}" y="${y - 5}" width="22" height="3" rx="1" fill="#333"/><rect x="${x1 - 28}" y="${y - 5}" width="22" height="3" rx="1" fill="#333"/>`;
/** soft light from above: a highlight on the top half, shade under */
const shade = (x: number, y: number, w: number, h: number, r = 3) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#lt)"/>`;
const defs = `<defs><linearGradient id="lt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient></defs>`;

function svg(w: number, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${H}" width="${w}" height="${H}">${defs}${body}</svg>`;
}

/** A coach or wagon. */
export function coachSvg(c: CoachData) {
  const key = `c:${c.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = Math.round(c.lengthM * PX), L = c.livery, y0 = 8, bh = 26, wy = H - 6;
  let b = '';
  const kind = c.kind ?? 'coach';
  if (kind === 'container') {
    b += `<rect x="3" y="${wy - 12}" width="${w - 6}" height="5" rx="1" fill="#3a3d40"/>`;
    const tints = c.tints?.length ? c.tints : ['#b5452f', '#2f6aa8', '#3d8a52', '#c79a2c'];
    const box = (x: number, y: number, ww: number, hh: number, col: string) => `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" rx="1" fill="${col}"/>${shade(x, y, ww, hh, 1)}` + Array.from({ length: Math.floor(ww / 6) }, (_, i) => `<path d="M${x + 3 + i * 6} ${y + 2}v${hh - 4}" stroke="#000" stroke-opacity=".18"/>`).join('');
    // (an empty well wagon is the bare deck)
    const deck = wy - 12;
    if (c.containers === 'single') b += box(6, deck - 18, w - 12, 18, tints[0]);
    else if (c.containers === 'double' || c.containers === 'double-20') {
      // two high: the lower tier (two 20 ft boxes or one 40 ft), a 40 ft box on top
      const ch = 13, lo = deck - ch, hi = lo - ch - 1;
      if (c.containers === 'double-20') b += box(6, lo, (w - 14) / 2, ch, tints[0]) + box(8 + (w - 14) / 2, lo, (w - 14) / 2, ch, tints[1]);
      else b += box(6, lo, w - 12, ch, tints[0]);
      b += box(6, hi, w - 12, ch, tints[2 % tints.length]);
    }
  } else if (kind === 'boxcar') {
    b += `<rect x="3" y="${y0}" width="${w - 6}" height="${bh}" rx="2" fill="${L.body}"/>${shade(3, y0, w - 6, bh, 2)}`;
    for (let x = 10; x < w - 6; x += 9) b += `<path d="M${x} ${y0 + 2}v${bh - 4}" stroke="#000" stroke-opacity=".22"/>`;
    b += `<rect x="${w / 2 - 12}" y="${y0 + 4}" width="24" height="${bh - 8}" fill="#000" fill-opacity=".15"/>`;
  } else if (kind === 'brakevan') {
    b += `<rect x="3" y="${y0 + 8}" width="${w - 6}" height="${bh - 8}" rx="2" fill="${L.body}"/><rect x="${w * 0.3}" y="${y0}" width="${w * 0.45}" height="${bh}" rx="2" fill="${L.body}"/>${shade(3, y0 + 8, w - 6, bh - 8, 2)}`;
    b += `<rect x="${w * 0.36}" y="${y0 + 5}" width="10" height="8" fill="${L.window}"/><rect x="${w * 0.56}" y="${y0 + 5}" width="10" height="8" fill="${L.window}"/>`;
  } else {
    // passenger coach: roof, body, band, windows, doors at the ends
    b += `<rect x="3" y="${y0 - 3}" width="${w - 6}" height="6" rx="3" fill="${L.roof}"/>`;
    b += `<rect x="3" y="${y0}" width="${w - 6}" height="${bh}" rx="3" fill="${L.body}"/>`;
    b += `<rect x="3" y="${y0 + bh - 9}" width="${w - 6}" height="3" fill="${L.band}"/>`;
    const n = Math.max(4, Math.floor((w - 50) / 15));
    for (let i = 0; i < n; i++) b += `<rect x="${24 + i * ((w - 48) / n)}" y="${y0 + 5}" width="${(w - 48) / n - 4}" height="8" rx="1.5" fill="${L.window}"/>`;
    for (const x of [8, w - 18]) b += `<rect x="${x}" y="${y0 + 3}" width="10" height="${bh - 5}" rx="1" fill="#000" fill-opacity=".2"/>`;
    b += shade(3, y0, w - 6, bh);
  }
  b += wheels(3, w - 3, wy);
  const s = svg(w, b);
  cache.set(key, s);
  return s;
}

/** A loco (or a trainset, drawn as its power car with a streamlined nose). */
export function locoSvg(l: LocoData) {
  const key = `l:${l.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const len = l.trainset ? 26 : l.lengthM;
  const w = Math.round(len * PX), L = l.livery, y0 = 8, bh = 27, wy = H - 6;
  let b = '';
  if (l.trainset) {
    b += `<path d="M3 ${y0 + bh} V${y0 + 6} Q3 ${y0} 12 ${y0} H${w - 70} Q${w - 18} ${y0 + 2} ${w - 3} ${y0 + bh} Z" fill="${L.body}"/>`;
    b += `<path d="M${w - 52} ${y0 + 4} Q${w - 28} ${y0 + 6} ${w - 16} ${y0 + 14} H${w - 52} Z" fill="#1a2430"/>`;
    b += `<rect x="3" y="${y0 + bh - 9}" width="${w - 30}" height="3" fill="${L.band}"/>`;
    for (let i = 0; i < 6; i++) b += `<rect x="${16 + i * ((w - 90) / 6)}" y="${y0 + 6}" width="${(w - 90) / 6 - 4}" height="7" rx="1.5" fill="#1a2430"/>`;
    b += shade(3, y0, w - 6, bh, 6);
  } else if (l.type === 'diesel') {
    // long hood, cab, short hood
    b += `<rect x="3" y="${y0 + 6}" width="${w * 0.62}" height="${bh - 6}" rx="2" fill="${L.body}"/><rect x="${w * 0.62}" y="${y0}" width="${w * 0.2}" height="${bh}" rx="2" fill="${L.body}"/><rect x="${w * 0.82}" y="${y0 + 8}" width="${w * 0.18 - 3}" height="${bh - 8}" rx="2" fill="${L.body}"/>`;
    b += `<rect x="${w * 0.65}" y="${y0 + 4}" width="${w * 0.14}" height="8" rx="1" fill="#1a2430"/><rect x="3" y="${y0 + bh - 8}" width="${w - 6}" height="3" fill="${L.band}"/>`;
    for (let x = 10; x < w * 0.6; x += 10) b += `<rect x="${x}" y="${y0 + 9}" width="6" height="6" fill="#000" fill-opacity=".2"/>`;
    b += `<rect x="${w * 0.2}" y="${y0 + 2}" width="8" height="5" fill="#333"/>`;
    b += shade(3, y0, w - 6, bh, 2);
  } else {
    // electric: cabs both ends, roof equipment, pantographs
    b += `<rect x="3" y="${y0}" width="${w - 6}" height="${bh}" rx="3" fill="${L.body}"/>`;
    b += `<rect x="3" y="${y0 + bh - 9}" width="${w - 6}" height="3" fill="${L.band}"/>`;
    for (const x of [8, w - 24]) b += `<rect x="${x}" y="${y0 + 4}" width="16" height="9" rx="2" fill="#1a2430"/>`;
    for (let x = 34; x < w - 34; x += 12) b += `<rect x="${x}" y="${y0 + 6}" width="8" height="5" fill="#000" fill-opacity=".22"/>`;
    b += `<rect x="${w * 0.3}" y="${y0 - 3}" width="${w * 0.4}" height="3" fill="${L.roof}"/>`;
    for (const x of [w * 0.22, w * 0.72]) b += `<path d="M${x} ${y0} l8 -6 l-6 -2 M${x - 4} ${y0 - 8} h14" stroke="#cfd4d8" stroke-width="1.4" fill="none"/>`;
    b += shade(3, y0, w - 6, bh);
  }
  if (L.bufferBeam) b += `<rect x="1" y="${y0 + bh - 2}" width="4" height="5" fill="${L.bufferBeam}"/><rect x="${w - 5}" y="${y0 + bh - 2}" width="4" height="5" fill="${L.bufferBeam}"/>`;
  b += wheels(3, w - 3, wy, 4.6);
  const s = svg(w, b);
  cache.set(key, s);
  return s;
}

/** as a data: URL, for <img> */
export const svgUrl = (s: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
