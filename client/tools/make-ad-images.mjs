// Sample billboard artwork for the mock ads in data/ads.json (fictional brands), one image per format,
// at the sizes ADS_GUIDE.md recommends. Drawn on a canvas in headless Chrome and saved as JPG to
// client/public/assets/ads/. Usage: node tools/make-ad-images.mjs   (needs playwright-core and Chrome)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pw = (() => { try { return require('playwright-core'); } catch { return require(process.env.PLAYWRIGHT_CORE); } })();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(ROOT, '../public/assets/ads');
fs.mkdirSync(OUT, { recursive: true });

const FORMATS = { wide: [1536, 512], standard: [1024, 512], portrait: [512, 1024], screen: [1280, 720] };
const NAME = { wide: 'wide', standard: '2x1', portrait: '1x2', screen: '16x9' };
// art per ad: colours, an icon, a strapline (all invented)
const ART = {
  'chai-supreme': { a: '#c0392b', b: '#7b1d12', fg: '#fff7e8', accent: '#f6c453', icon: '☕', title: 'CHAI SUPREME', sub: 'Fresh every morning', tag: 'Since 1962' },
  'ganga-cement': { a: '#1f6f8b', b: '#0d3445', fg: '#ffffff', accent: '#9fd6e8', icon: '🏗️', title: 'GANGA CEMENT', sub: 'Strong like a bridge', tag: 'ISI grade 53' },
  'raja-mobiles': { a: '#f1c40f', b: '#d68910', fg: '#1d1d1d', accent: '#ffffff', icon: '📱', title: 'RAJA MOBILES', sub: '5G phones from Rs 6999', tag: 'Easy EMI' },
  'kisan-tractors': { a: '#27ae60', b: '#145a32', fg: '#ffffff', accent: '#f4d03f', icon: '🚜', title: 'KISAN TRACTORS', sub: 'Built for every field', tag: '5 year warranty' },
  'sagar-logistics': { a: '#2f3e8f', b: '#141b45', fg: '#ffffff', accent: '#59c3ff', icon: '🚢', title: 'SAGAR LOGISTICS', sub: 'Port to doorstep, on time', tag: 'Rail + road + sea' },
  'himgiri-woollens': { a: '#6d3b7f', b: '#2e1538', fg: '#fff6e0', accent: '#f7c6d9', icon: '🧣', title: 'HIMGIRI WOOLLENS', sub: 'Warm all winter', tag: 'Pure wool' },
  'diwali-sale': { a: '#ff8c1a', b: '#b33a00', fg: '#2a0c00', accent: '#ffe066', icon: '🪔', title: 'BAZAAR DIWALI SALE', sub: 'Up to 50% off, till 15 Nov', tag: 'In all stores' },
  'safe-crossing': { a: '#f5f5f0', b: '#d9dde2', fg: '#1b2a3a', accent: '#d7263d', icon: '🚸', title: 'STOP. LOOK. CROSS.', sub: 'Use the foot over bridge', tag: 'Bharat Rail Network' },
};

const b = await pw.chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await b.newPage();
await page.setContent('<canvas id="c"></canvas>');
for (const [id, art] of Object.entries(ART)) {
  for (const [fmt, [W, H]] of Object.entries(FORMATS)) {
    const data = await page.evaluate(([art, W, H]) => {
      const c = document.getElementById('c');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      // background: diagonal gradient, soft rays, a band
      const gr = g.createLinearGradient(0, 0, W, H);
      gr.addColorStop(0, art.a); gr.addColorStop(1, art.b);
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.globalAlpha = 0.08; g.fillStyle = '#ffffff';
      for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(W * 0.8, H * 0.5); g.arc(W * 0.8, H * 0.5, Math.max(W, H), i * 0.7, i * 0.7 + 0.25); g.closePath(); g.fill(); }
      g.globalAlpha = 1;
      const portrait = H > W, u = Math.min(W, H) / 100;
      // the safe area: everything inside the middle 80 %
      const sx = W * 0.1, sy = H * 0.1, sw = W * 0.8, sh = H * 0.8;
      const fit = (text, size, weight, maxW) => { let s = size; g.font = `${weight} ${s}px "Segoe UI", Arial, sans-serif`; while (g.measureText(text).width > maxW && s > 10) { s -= 2; g.font = `${weight} ${s}px "Segoe UI", Arial, sans-serif`; } return s; };
      g.textBaseline = 'middle';
      if (!portrait) {
        // icon in a disc on the left, words on the right
        const r = sh * 0.42, cx = sx + r, cy = H / 2;
        g.fillStyle = art.accent; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        g.font = `${r * 1.15}px "Segoe UI Emoji", sans-serif`; g.textAlign = 'center'; g.fillText(art.icon, cx, cy + r * 0.06);
        const tx = cx + r + sw * 0.05, tw = sx + sw - tx;
        g.textAlign = 'left'; g.fillStyle = art.fg;
        const titleSize = fit(art.title, sh * 0.34, 900, tw); g.fillText(art.title, tx, sy + sh * 0.3);
        fit(art.sub, Math.min(sh * 0.17, titleSize * 0.7), 600, tw); g.globalAlpha = 0.95; g.fillText(art.sub, tx, sy + sh * 0.62);
        g.globalAlpha = 1;
        // tag in a pill
        const ts = fit(art.tag, Math.min(sh * 0.1, titleSize * 0.45), 700, tw * 0.6), pw2 = g.measureText(art.tag).width + ts * 1.4;
        g.fillStyle = art.accent; g.beginPath(); g.roundRect(tx, sy + sh * 0.8, pw2, ts * 1.5, ts * 0.75); g.fill();
        g.fillStyle = art.b; g.fillText(art.tag, tx + ts * 0.7, sy + sh * 0.8 + ts * 0.78);
      } else {
        // stacked: icon, title words, sub, tag
        const r = sw * 0.32, cx = W / 2, cy = sy + r + 2 * u;
        g.fillStyle = art.accent; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        g.font = `${r * 1.15}px "Segoe UI Emoji", sans-serif`; g.textAlign = 'center'; g.fillText(art.icon, cx, cy + r * 0.06);
        g.fillStyle = art.fg;
        const words = art.title.split(' ');
        let y = cy + r + 14 * u;
        for (const w of words) { const s = fit(w, sw * 0.22, 900, sw); g.fillText(w, cx, y); y += s * 1.1; }
        fit(art.sub, sw * 0.08, 600, sw); g.fillText(art.sub, cx, Math.min(y + 4 * u, sy + sh * 0.9));
        fit(art.tag, sw * 0.07, 700, sw); g.fillStyle = art.accent; g.fillText(art.tag, cx, sy + sh - 2 * u);
      }
      return c.toDataURL('image/jpeg', 0.88);
    }, [art, W, H]);
    const file = path.join(OUT, `${id}-${NAME[fmt]}.jpg`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log('wrote', path.relative(process.cwd(), file));
  }
}
await b.close();
