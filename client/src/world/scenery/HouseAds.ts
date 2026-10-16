import { canvasTexture } from '../../core/Textures';
import { FORMAT_ASPECT, type Ad, type AdFormat, type HouseAds } from '@rail/shared/ads/Ads';

/** railway safety messages (English, Hindi, a smaller line) */
const SAFETY = [
  ["DON'T CROSS THE TRACKS", 'पटरी पार न करें', 'Use the foot over bridge'],
  ['STAND BEHIND THE YELLOW LINE', 'पीली रेखा के पीछे रहें', 'Trains pass at speed'],
  ["DON'T TRAVEL ON THE ROOF", 'छत पर यात्रा न करें', 'or on the footboard'],
  ['STOP · LOOK · LISTEN', 'रुकें · देखें · सुनें', 'at every level crossing'],
];
/** posters of the routes (fictional places): art, title, line */
const SCENIC: [string, string, string][] = [
  ['snow', 'HIMALAYAN SNOW LINE', 'Ride above the clouds'],
  ['ghats', 'THE GHATS BY RAIL', 'Waterfalls, tunnels and monsoon green'],
  ['desert', 'DESERT FORTS', 'Rajmahal and the golden dunes'],
  ['coast', 'SAGARPUR COAST', 'Sea breeze, palms and temple towers'],
  ['plains', 'SEE BHARAT BY TRAIN', 'Bharat Rail Network'],
];

const base = { frequency: 0, active: true, routes: ['all'], regions: ['all'], billboardTypes: ['all'], images: {} };

/**
 * The house designs as ads (frequency 0: never picked by the ads' own draw; Billboards puts them on the
 * billboards no ad took): the "advertise here" board, the safety messages, a poster per kind of country.
 */
export function houseAdList(h: HouseAds): Ad[] {
  return [
    { ...base, id: '_advertise-here', url: h.contactUrl, house: 'advertise', fallback: { bg: '#10213a', fg: '#ffffff', title: h.title, sub: h.sub } },
    ...SAFETY.map(([title, , sub], i): Ad => ({ ...base, id: `_safety-${i}`, url: null, house: 'safety', art: String(i), fallback: { bg: '#f5c400', fg: '#111111', title, sub } })),
    ...SCENIC.map(([art, title, sub]): Ad => ({ ...base, id: `_scenic-${art}`, url: null, house: 'scenic', art, fallback: { bg: '#1d3557', fg: '#ffffff', title, sub } })),
  ];
}

/** The picture of a house design in a format. */
export function houseArt(ad: Ad, format: AdFormat) {
  const aspect = FORMAT_ASPECT[format];
  const W = aspect >= 1 ? 768 : 384, H = Math.round(W / aspect);
  const f = ad.fallback;
  return canvasTexture(`house-${ad.id}-${format}-${f.title}-${f.sub ?? ''}`, W, H, g => {
    const fit = (text: string, size: number, weight: string, maxW: number) => {
      let s = size;
      g.font = `${weight} ${s}px "Nirmala UI", Arial, sans-serif`;
      while (g.measureText(text).width > maxW && s > 10) { s -= 2; g.font = `${weight} ${s}px "Nirmala UI", Arial, sans-serif`; }
    };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const wide = aspect >= 1;
    if (ad.house === 'advertise') {
      // navy board, saffron edge, the duotone megaphone, the offer
      g.fillStyle = '#10213a'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#ff9933'; g.fillRect(0, H - H * 0.07, W, H * 0.07);
      const ix = wide ? H * 0.55 : W / 2, iy = wide ? H * 0.47 : H * 0.24, is = wide ? H * 0.5 : W * 0.5;
      megaphone(g, ix, iy, is, '#ff9933');
      const tx = wide ? (ix + is * 0.6 + W) / 2 : W / 2, tw = wide ? W - ix - is * 0.75 : W * 0.88;
      g.fillStyle = '#ffffff';
      if (wide) {
        fit(f.title, Math.round(H * 0.24), '800', tw); g.fillText(f.title, tx, H * 0.4);
        g.fillStyle = '#ffcc80'; fit(f.sub ?? '', Math.round(H * 0.12), '600', tw); g.fillText(f.sub ?? '', tx, H * 0.68);
      } else {
        f.title.split(' ').forEach((w, i) => { fit(w, Math.round(W * 0.17), '800', tw); g.fillText(w, W / 2, H * 0.5 + i * W * 0.19); });
        g.fillStyle = '#ffcc80'; fit(f.sub ?? '', Math.round(W * 0.075), '600', tw); g.fillText(f.sub ?? '', W / 2, H * 0.86);
      }
      return;
    }
    if (ad.house === 'safety') {
      // yellow and black: hazard stripes top and bottom, the message in English and Hindi
      const [, hi] = SAFETY[Number(ad.art)];
      g.fillStyle = '#f5c400'; g.fillRect(0, 0, W, H);
      const band = Math.max(14, Math.round(Math.min(W, H) * 0.09));
      for (const y0 of [0, H - band]) {
        g.save(); g.beginPath(); g.rect(0, y0, W, band); g.clip();
        g.fillStyle = '#111';
        for (let x = -band * 2; x < W + band; x += band * 1.4) { g.beginPath(); g.moveTo(x, y0 + band); g.lineTo(x + band * 0.7, y0 + band); g.lineTo(x + band * 1.4, y0); g.lineTo(x + band * 0.7, y0); g.fill(); }
        g.restore();
      }
      g.fillStyle = '#111';
      if (wide) {
        fit(f.title, Math.round(H * 0.2), '800', W * 0.9); g.fillText(f.title, W / 2, H * 0.36);
        fit(hi, Math.round(H * 0.15), '700', W * 0.9); g.fillText(hi, W / 2, H * 0.58);
        fit(f.sub ?? '', Math.round(H * 0.09), '600', W * 0.9); g.fillText(f.sub ?? '', W / 2, H * 0.76);
      } else {
        const words = f.title.split(' ');
        words.forEach((w, i) => { fit(w, Math.round(W * 0.16), '800', W * 0.86); g.fillText(w, W / 2, H * 0.2 + i * W * 0.18); });
        fit(hi, Math.round(W * 0.1), '700', W * 0.86); g.fillText(hi, W / 2, H * 0.72);
        fit(f.sub ?? '', Math.round(W * 0.065), '600', W * 0.86); g.fillText(f.sub ?? '', W / 2, H * 0.84);
      }
      return;
    }
    // route poster: a painted landscape, the name on a band
    scene(g, W, H, ad.art ?? 'plains');
    const by = wide ? H * 0.7 : H * 0.74, bh = H - by;
    g.fillStyle = 'rgba(16,33,58,0.86)'; g.fillRect(0, by, W, bh);
    g.fillStyle = '#ffffff'; fit(f.title, Math.round(bh * 0.42), '800', W * 0.9); g.fillText(f.title, W / 2, by + bh * 0.38);
    g.fillStyle = '#ffcc80'; fit(f.sub ?? '', Math.round(bh * 0.22), '600', W * 0.9); g.fillText(f.sub ?? '', W / 2, by + bh * 0.75);
  }, { repeat: false });
}

/** a megaphone in the duotone style: the body at 30 % behind, the outline and details at full colour */
function megaphone(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: string) {
  const u = s / 24; // drawn on a 24-unit grid, like the UI icons
  const p = (x: number, y: number) => [cx + (x - 12) * u, cy + (y - 12) * u] as const;
  const body = () => { g.beginPath(); g.moveTo(...p(3, 9)); g.lineTo(...p(8, 9)); g.lineTo(...p(19, 4)); g.lineTo(...p(19, 20)); g.lineTo(...p(8, 15)); g.lineTo(...p(3, 15)); g.closePath(); };
  g.fillStyle = c; g.globalAlpha = 0.3; body(); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = c; g.lineWidth = 1.6 * u; g.lineJoin = 'round'; g.lineCap = 'round';
  body(); g.stroke();
  g.beginPath(); g.moveTo(...p(8, 9)); g.lineTo(...p(8, 15)); g.stroke();
  g.beginPath(); g.moveTo(...p(6, 15)); g.lineTo(...p(7.5, 20)); g.lineTo(...p(10, 20)); g.lineTo(...p(9.2, 15.6)); g.stroke();
  for (const [a, r] of [[-0.5, 3], [0, 3.6], [0.5, 3]] as const) { g.beginPath(); g.moveTo(...p(21, 12 + a * 6)); g.lineTo(...p(21 + r * 0.5, 12 + a * 8)); g.stroke(); }
}

/** the painted country of a poster */
function scene(g: CanvasRenderingContext2D, W: number, H: number, art: string) {
  const sky = g.createLinearGradient(0, 0, 0, H);
  const skies: Record<string, [string, string]> = { snow: ['#7fb3e6', '#e6f1fb'], ghats: ['#8fc1d8', '#e9f3e6'], desert: ['#f2a65a', '#fde3b0'], coast: ['#ffb26b', '#ffe3c2'], plains: ['#9fd0f0', '#fff4d6'] };
  const [a, b] = skies[art] ?? skies.plains;
  sky.addColorStop(0, a); sky.addColorStop(1, b);
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const ridge = (y: number, amp: number, col: string, seed: number, peaks = 5) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += W / 60) g.lineTo(x, y - Math.abs(Math.sin((x / W) * Math.PI * peaks + seed)) * amp);
    g.lineTo(W, H); g.fill();
  };
  // a train along the bottom ridge
  const train = (y: number) => {
    g.fillStyle = '#b8322c'; g.fillRect(W * 0.12, y - H * 0.05, W * 0.16, H * 0.05);
    g.fillStyle = '#2c5aa0'; for (let i = 0; i < 4; i++) g.fillRect(W * (0.285 + i * 0.12), y - H * 0.045, W * 0.115, H * 0.045);
  };
  if (art === 'snow') {
    ridge(H * 0.45, H * 0.3, '#9db0c8', 0.4, 3);
    g.fillStyle = '#ffffff';
    for (let k = 0; k < 3; k++) { const x = W * (0.2 + k * 0.32); g.beginPath(); g.moveTo(x - W * 0.07, H * 0.32); g.lineTo(x, H * 0.16); g.lineTo(x + W * 0.07, H * 0.32); g.fill(); }
    ridge(H * 0.62, H * 0.08, '#3f6b4a', 1.3, 7);
    train(H * 0.66);
  } else if (art === 'ghats') {
    ridge(H * 0.4, H * 0.18, '#4f8a4f', 0.2, 2);
    g.fillStyle = '#e6f4fa'; g.fillRect(W * 0.62, H * 0.22, W * 0.03, H * 0.38);
    ridge(H * 0.6, H * 0.1, '#2f6b3a', 0.9, 4);
    train(H * 0.64);
  } else if (art === 'desert') {
    g.fillStyle = '#c98a4b';
    g.fillRect(W * 0.55, H * 0.3, W * 0.3, H * 0.18);
    for (let k = 0; k < 4; k++) g.fillRect(W * (0.55 + k * 0.09), H * 0.24, W * 0.04, H * 0.08);
    ridge(H * 0.6, H * 0.08, '#e3b26b', 0.5, 3);
    train(H * 0.64);
  } else if (art === 'coast') {
    g.fillStyle = '#ffd36b'; g.beginPath(); g.arc(W * 0.75, H * 0.36, Math.min(W, H) * 0.08, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2f7f9e'; g.fillRect(0, H * 0.46, W, H * 0.2);
    g.fillStyle = '#bf6a43';
    for (let k = 0; k < 4; k++) { const w = W * (0.1 - k * 0.02); g.fillRect(W * 0.2 - w / 2, H * (0.2 + k * 0.06), w, H * 0.06); }
    ridge(H * 0.66, H * 0.03, '#e9d3a3', 0.1, 2);
    train(H * 0.68);
  } else {
    ridge(H * 0.56, H * 0.04, '#7fae5a', 0.3, 3);
    g.fillStyle = '#4b7a3a'; for (let k = 0; k < 6; k++) { g.beginPath(); g.arc(W * (0.08 + k * 0.17), H * 0.5, H * 0.05, 0, Math.PI * 2); g.fill(); }
    train(H * 0.66);
  }
}
