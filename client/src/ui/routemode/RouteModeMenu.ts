import { COACHES, JUNCTIONS, LOCOS, REGIONS, ROUTES } from '../../data';
import { WEATHER, type WeatherId } from '../../environment/Weather';
import type { RouteData } from '@rail/shared/track/Route';
import { currentCoach, type ConsistSpec } from '@rail/shared/train/Consist';
import { goodsStations, planGoods, planWagonsOfSpec } from '@rail/shared/gameplay/GoodsPlanner';
import { Railway } from '@rail/shared/track/Railway';
import { canWorkGoods, checkJourney, defaultStops, goodsTrain, stopWork, estimateMinutes, type Journey, type JourneyPath, type JourneyStop, type JourneyWarning, journeyStations, RailNetwork, trainSize } from '@rail/shared/routemode/Journey';
import { icon, type IconName } from '../theme/icons';
import { bindGallery, chip, esc, fillSliders, gallery, imageCard, stepper, toast, toggle } from '../theme/components';
import { coachSvg, locoSvg, svgUrl } from './pictures';
import './routemode.css';

export interface RouteModeHost {
  show(el: HTMLElement, back: (() => void) | null): void;
  main(): void;
  start(j: Journey): void;
}

const STEPS = ['Journey', 'Train', 'Plan', 'Start'];
const TIMES: [string, string, IconName][] = [['Dawn', '05:40', 'sunHorizon'], ['Morning', '08:30', 'sun'], ['Noon', '12:30', 'sun'], ['Evening', '16:30', 'sun'], ['Sunset', '18:10', 'sunHorizon'], ['Night', '21:30', 'moon']];
const WX_ICON: Record<WeatherId, IconName> = { clear: 'sun', hazy: 'hazy', fog: 'fog', rain: 'rain', storm: 'storm', snow: 'snow' };
const DWELLS = [30, 60, 120, 180, 300];
const ROUTE_COLOURS = ['#5fb4ff', '#4cd28a', '#ffa64d', '#c38bff', '#ff6f91', '#7de0e6'];
const PRESETS: Record<string, { loco?: string; coaches: ConsistSpec['coaches']; loaded?: boolean }> = {
  'Express 22': { coaches: [{ type: 'icf', count: 2 }, { type: 'lhb', count: 18 }, { type: 'icf', count: 2 }] },
  'Local 12': { coaches: [{ type: 'icf', count: 12 }] },
  'Freight 40': { loco: 'wag-9', coaches: [{ type: 'boxcar', count: 40 }, { type: 'brakevan', count: 1 }], loaded: true },
  'Double-stack 60': { loco: 'wag-12b', coaches: [{ type: 'container-ds', count: 60 }, { type: 'brakevan', count: 1 }], loaded: true },
};
const MAX_VEHICLES = 90;

// ---------------------------------------------------------------- saved and recent journeys (this browser)
const KEY = 'railbharat.routemode.v1';
interface Store { saved: Journey[]; recent: Journey[] }
function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && Array.isArray(s.saved) && Array.isArray(s.recent)) {
      // (coach types no longer made: their replacements)
      for (const j of [...s.saved, ...s.recent] as Journey[]) {
        for (const c of j.consist?.coaches ?? []) c.type = currentCoach(c.type);
        for (const st of j.stops ?? []) for (const c of st.couple ?? []) c.type = currentCoach(c.type);
      }
      return s;
    }
  } catch { /* private window, blocked storage */ }
  return { saved: [], recent: [] };
}
function saveStore(s: Store) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* keep going without */ } }
const sameTrip = (a: Journey, b: Journey) => JSON.stringify({ ...a, name: undefined }) === JSON.stringify({ ...b, name: undefined });

const html = (s: string) => { const d = document.createElement('div'); d.innerHTML = s.trim(); return d.firstElementChild as HTMLElement; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`);

/**
 * Route Mode: plan a journey between any two stations (across routes, through the junctions), choose
 * the train from picture galleries, plan the stops and the coupling work, and go. A stepper on top
 * (Journey, Train, Plan, Start), Back / Next below, and a summary bar (way, distance, time, train).
 */
export class RouteModeMenu {
  private net = new RailNetwork(ROUTES, JUNCTIONS);
  private j: Journey = this.blank();
  private step = 0;
  private picking: 'from' | 'to' = 'from';
  private query = '';
  private built = new Map<string, RouteData>();
  private el: HTMLElement | null = null;
  /** timeline stations whose shunting choices are shown (tap the station to open or close) */
  private expanded = new Set<string>();

  constructor(private host: RouteModeHost) {}

  private blank(): Journey {
    return { v: 1, from: '', to: '', via: [], time: '08:30', weather: 'clear', consist: { loco: LOCOS.wap7 ? 'wap7' : Object.keys(LOCOS)[0], coaches: clone(PRESETS['Express 22'].coaches), loaded: true }, stops: [], realistic: true, autoShunt: true };
  }

  // ---------------------------------------------------------------- derived
  private paths(): JourneyPath[] { return this.j.from && this.j.to ? this.net.paths(this.j.from, this.j.to) : []; }
  private path() { return this.j.from && this.j.to ? this.net.pathFor(this.j.from, this.j.to, this.j.via) : null; }
  private route(): RouteData | null {
    const p = this.path();
    if (!p) return null;
    const k = `${p.from}>${p.to}:${p.junctions.join()}`;
    let r = this.built.get(k);
    if (!r) { r = this.net.compose(p); this.built.set(k, r); }
    return r;
  }
  private stations() { const r = this.route(); return r ? journeyStations(r, this.j.from, this.j.to) : []; }
  /** the plan's stops for the way chosen (choices kept for stations still on it) */
  private syncStops() {
    const r = this.route();
    if (!r) { this.j.stops = []; return; }
    const keep = new Map(this.j.stops.map(s => [s.code, s]));
    this.j.stops = defaultStops(r, this.j.from, this.j.to).map(d => {
      const k = keep.get(d.code);
      return k ? { ...k, stop: d.code === this.j.from || d.code === this.j.to ? true : k.stop } : d;
    });
  }
  private size() { return trainSize(this.j.consist, LOCOS, COACHES); }
  private warnings(): JourneyWarning[] { const r = this.route(); return r ? checkJourney(this.j, this.net, r, LOCOS, COACHES) : []; }
  private name(code: string) { return this.net.stations.get(code)?.name ?? code; }
  private routeColour(id: string) { return ROUTE_COLOURS[Object.keys(this.net.routes).indexOf(id) % ROUTE_COLOURS.length] ?? '#9aa'; }
  /** vehicles front to back (the consist's runs, one entry each) */
  private vehicles() { return this.j.consist.coaches.flatMap(c => Array<string>(c.count).fill(c.type)); }
  private setVehicles(list: string[]) {
    const runs: ConsistSpec['coaches'] = [];
    for (const t of list.slice(0, MAX_VEHICLES)) { const last = runs[runs.length - 1]; if (last?.type === t) last.count++; else runs.push({ type: t, count: 1 }); }
    this.j.consist.coaches = runs;
  }

  // ---------------------------------------------------------------- the start screen
  open() {
    const st = loadStore();
    const row = (j: Journey, i: number, saved: boolean) => `<div class="rm-saved card">
      <div><b>${esc(j.name ?? `${this.name(j.from)} → ${this.name(j.to)}`)}</b>
      <small>${esc(this.name(j.from))} → ${esc(this.name(j.to))}${j.via.length ? ` · via ${j.via.map(v => esc(this.net.junctions.find(x => x.id === v)?.name ?? v)).join(', ')}` : ''} · ${esc(LOCOS[j.consist.loco]?.name ?? j.consist.loco)} · ${j.time}</small></div>
      <div class="rm-saved-btns"><button data-go="${saved ? 's' : 'r'}${i}">${icon('play')}Start</button><button data-edit="${saved ? 's' : 'r'}${i}">${icon('sliders')}Edit</button><button data-del="${saved ? 's' : 'r'}${i}" title="Delete this journey">${icon('trash')}Delete</button></div></div>`;
    const el = html(`<div class="menu rm rm-start"><h2>${icon('route')} Route Mode</h2>
      <p class="sub">Drive from any station to any other: across the routes, through the junctions. Plan the stops, pick up and leave coaches, change locos.</p>
      <button class="btn-primary btn-lg rm-new" data-a="new">${icon('plus')}Plan a new journey</button>
      ${st.saved.length ? `<h3>${icon('save')} Saved journeys</h3>${st.saved.map((j, i) => row(j, i, true)).join('')}` : ''}
      ${st.recent.length ? `<h3>${icon('recent')} Recent journeys</h3>${st.recent.map((j, i) => row(j, i, false)).join('')}` : ''}
      <div class="buttons"><button data-a="menu">${icon('arrowLeft')}Main menu</button></div></div>`);
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const pick = (v: string) => (v[0] === 's' ? st.saved : st.recent)[Number(v.slice(1))];
      if (b.dataset.a === 'menu') this.host.main();
      if (b.dataset.a === 'new') { this.j = this.blank(); this.step = 0; this.picking = 'from'; this.render(); }
      if (b.dataset.go) this.go(clone(pick(b.dataset.go)));
      if (b.dataset.edit) { this.j = clone(pick(b.dataset.edit)); this.step = 0; this.render(); }
      if (b.dataset.del) { (b.dataset.del[0] === 's' ? st.saved : st.recent).splice(Number(b.dataset.del.slice(1)), 1); saveStore(st); this.open(); }
    });
    this.host.show(el, () => this.host.main());
  }

  /** Off we go: remembered among the recent journeys first. */
  private go(j: Journey) {
    const st = loadStore();
    st.recent = [j, ...st.recent.filter(x => !sameTrip(x, j))].slice(0, 6);
    saveStore(st);
    this.host.start(j);
  }

  /** Pause menu "Change plan for remaining stops": the plan step for the stations still ahead. */
  editRemaining(j: Journey, ahead: string[], done: (stops: JourneyStop[]) => void, back: () => void) {
    this.j = clone(j);
    const el = html(`<div class="menu rm"><h2>${icon('route')} Change the plan</h2><p class="sub">Stations still ahead. The start and the end stay stops.</p>
      <div class="rm-body">${this.timeline(ahead)}</div>
      <div class="buttons"><button data-a="cancel">Cancel</button><button data-a="ok">${icon('check')}Use this plan</button></div></div>`);
    const bindPlan = () => {
      el.querySelector('.rm-body')!.innerHTML = this.timeline(ahead);
    };
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.a === 'cancel') back();
      if (b.dataset.a === 'ok') done(this.j.stops);
      if (b.dataset.stop) { this.toggleStop(b.dataset.stop); bindPlan(); }
      if (b.dataset.open) { this.toggleOpen(b.dataset.open); bindPlan(); }
    });
    el.addEventListener('change', e => { this.planInput(e.target as HTMLInputElement); bindPlan(); });
    this.host.show(el, back);
  }

  // ---------------------------------------------------------------- the wizard
  /**
   * Each planned "leave the last N" fitted to the train as it is at that stop (after the coaches left and picked
   * up before it): the train made shorter after planning leaves at most what it then has, less one. (The list
   * offers only what fits, so a number left over from before showed as "Keep all" and could not be undone.)
   */
  private fitPlan() {
    let left = this.vehicles().length;
    for (const s of this.stations()) {
      const p = this.j.stops.find(x => x.code === s.code);
      if (!p?.stop) continue;
      if (p.decouple && p.decouple > left - 1) p.decouple = left > 1 ? left - 1 : undefined;
      if (p.decouple) left -= p.decouple;
      for (const c of p.couple ?? []) left += c.count;
    }
  }

  private render() {
    this.fitPlan();
    const old = this.el, scroll = old?.scrollTop ?? 0;
    const tracks = old ? [...old.querySelectorAll<HTMLElement>('.hg-track')].map(t => t.scrollLeft) : [];
    const body = [() => this.stepJourney(), () => this.stepTrain(), () => this.stepPlan(), () => this.stepReview()][this.step]();
    const blocks = this.warnings().filter(w => w.level === 'block');
    const ok = this.step === 0 ? !!this.path() : this.step === 3 ? !blocks.length : true;
    const el = html(`<div class="menu rm">
      <div class="rm-head"><h2>${icon('route')} Route Mode</h2>${stepper(STEPS, this.step)}</div>
      <div class="rm-body">${body}</div>
      ${this.summary()}
      <div class="buttons"><button data-a="back">${icon('arrowLeft')}${this.step ? 'Back' : 'Journeys'}</button>
      <button data-a="next"${ok ? '' : ' disabled'} title="${ok ? '' : esc(this.step === 0 ? 'Choose where from and where to' : blocks.map(b => b.text).join(' '))}">${this.step === 3 ? `${icon('play')}Start journey` : `Next${icon('arrowRight')}`}</button></div></div>`);
    this.el = el;
    this.bind(el);
    this.host.show(el, () => this.back());
    el.scrollTop = scroll;
    el.querySelectorAll<HTMLElement>('.hg-track').forEach((t, i) => { t.style.scrollBehavior = 'auto'; t.scrollLeft = tracks[i] ?? 0; t.style.scrollBehavior = ''; });
  }

  private back() { if (this.step) { this.step--; this.render(); } else this.open(); }

  private summary() {
    const p = this.path(), r = this.route(), sz = this.size();
    const est = r && p ? estimateMinutes(r, this.j.from, this.j.to, Math.min(sz.maxKmph || 110, 130), this.j.stops) : 0;
    const via = p?.junctions.length ? ` via ${p.junctions.map(v => esc(this.net.junctions.find(x => x.id === v)?.name ?? v)).join(', ')}` : '';
    return `<div class="rm-summary">
      <span>${icon('route')}<b>${p ? `${esc(this.name(this.j.from))} → ${esc(this.name(this.j.to))}` : 'Choose a journey'}</b>${via}</span>
      ${p ? `<span>${icon('map')}${p.distanceKm.toFixed(1)} km</span><span>${icon('clock')}about ${dur(est)}</span>` : ''}
      <span>${icon('train')}${Math.round(sz.lengthM)} m · ${Math.round(sz.massT).toLocaleString('en-IN')} t</span></div>`;
  }

  // ---------------------------------------------------------------- step 1: journey
  private stepJourney() {
    const ps = this.paths(), p = this.path();
    const wxOk = (w: WeatherId) => w !== 'snow' || !p || p.legs.some(l => l.route.includes('himalaya')) || (p.from === 'NVJ' || p.to === 'NVJ');
    return `<div class="rm-journey">
      <section class="rm-map-wrap">${this.mapSvg()}
        <p class="note">${icon('info')} Tap a station on the map or in the list: first where from, then where to.</p></section>
      <section class="rm-pick">
        <div class="rm-ends">
          <button class="rm-end${this.picking === 'from' ? ' on' : ''}" data-picking="from"><small>From</small><b>${this.j.from ? esc(this.name(this.j.from)) : 'Choose'}</b></button>
          <button class="icon-btn round" data-a="swap" aria-label="Swap from and to" title="Swap">${icon('swap')}</button>
          <button class="rm-end${this.picking === 'to' ? ' on' : ''}" data-picking="to"><small>To</small><b>${this.j.to ? esc(this.name(this.j.to)) : 'Choose'}</b></button>
        </div>
        <label class="rm-search">${icon('search')}<input type="search" data-f="search" placeholder="Search stations" value="${esc(this.query)}"></label>
        <div class="rm-list">${this.stationList()}</div>
      </section></div>
      ${ps.length > 1 ? `<h3>${icon('route')} Ways</h3><div class="chips">${ps.map((x, i) => chip(`${x.junctions.length ? `via ${x.junctions.map(v => this.net.junctions.find(j => j.id === v)?.name ?? v).join(' + ')}` : 'direct'} · ${x.distanceKm.toFixed(0)} km${i ? '' : ' (shortest)'}`, { on: x.junctions.join() === (p?.junctions.join() ?? ''), data: { via: i }, icon: i ? 'route' : 'star' })).join('')}</div>` : ''}
      <h3>${icon('clock')} Time of day</h3>
      <div class="chips">${TIMES.map(([n, t, ic]) => chip(`${n} ${t}`, { icon: ic, on: this.j.time === t, data: { time: t } })).join('')}</div>
      <label class="slider rm-time"><span>Fine</span><output>${this.j.time}</output><input type="range" min="0" max="1435" step="5" value="${mins(this.j.time)}" data-f="time"></label>
      <h3>${icon('cloud')} Weather</h3>
      <div class="rm-wx">${(Object.keys(WEATHER) as WeatherId[]).filter(wxOk).map(w => `<button class="rm-wx-card${this.j.weather === w ? ' on' : ''}" data-wx="${w}" aria-pressed="${this.j.weather === w}">${icon(WX_ICON[w])}<span>${esc(WEATHER[w].name)}</span></button>`).join('')}</div>`;
  }

  /** stations grouped by route (junctions first), filtered by the search */
  private stationList() {
    const q = this.query.trim().toLowerCase();
    const hit = (n: string, c: string) => !q || n.toLowerCase().includes(q) || c.toLowerCase().includes(q);
    const card = (code: string, name: string, sub: string, colour: string, jn = false) => `<button class="rm-stn-card${code === this.j.from ? ' from' : ''}${code === this.j.to ? ' to' : ''}" data-pick="${code}" style="--rc:${colour}">
      ${jn ? icon('junction') : '<i></i>'}<span><b>${esc(name)}</b><small>${esc(sub)}</small></span>${code === this.j.from ? '<em>From</em>' : code === this.j.to ? '<em>To</em>' : ''}</button>`;
    let out = '';
    const js = this.net.junctions.filter(j => hit(j.name, j.code));
    if (js.length) out += `<h4>Junctions</h4>${js.map(j => card(j.code, j.name, `${j.code} · ${j.connects.map(c => this.net.routes[c.route].name).join(' ↔ ')}`, '#ff9933', true)).join('')}`;
    for (const r of Object.values(this.net.routes)) {
      const list = r.stations.filter(s => hit(s.name, s.code));
      if (!list.length) continue;
      out += `<h4><i style="background:${this.routeColour(r.id)}"></i>${esc(r.name)}</h4>${list.map(s => card(s.code, s.name, `${s.code} · km ${s.km}${s.type === 'halt' ? ' · halt' : ''}`, this.routeColour(r.id))).join('')}`;
    }
    return out || '<p class="note">No station by that name.</p>';
  }

  /**
   * The network drawn as a schematic: junctions round a circle, each route a curve between the junctions
   * at its ends (an end with no junction runs out to the side), stations along it by km. The chosen way
   * is drawn bold; from (green) and to (saffron) are labelled.
   */
  private mapSvg(small = false) {
    const W = 400, Hh = 280, cx = W / 2, cy = Hh / 2 + 6, R = 104;
    const js = this.net.junctions, pos = new Map<string, [number, number]>();
    js.forEach((j, i) => { const a = -Math.PI / 2 + (i / Math.max(1, js.length)) * Math.PI * 2; pos.set(j.id, [cx + Math.cos(a) * R, cy + Math.sin(a) * R]); });
    const endAt = (route: string, end: 'start' | 'end') => js.find(j => j.connects.some(c => c.route === route && c.end === end));
    const p = this.path(), onPath = new Set(p ? this.stations().map(s => s.code) : []);
    const pathRoutes = new Set(p?.legs.map(l => l.route) ?? []);
    let lines = '', dots = '', labels = '';
    for (const [k, r] of Object.entries(this.net.routes)) {
      const js0 = endAt(k, 'start'), js1 = endAt(k, 'end');
      const a = js0 ? pos.get(js0.id)! : null, b = js1 ? pos.get(js1.id)! : null;
      const p0: [number, number] = a ?? (b ? [b[0] + (cx - b[0]) * 1.6, b[1] + (cy - b[1]) * 1.6] : [40, 30 + Object.keys(this.net.routes).indexOf(k) * 40]);
      const p1: [number, number] = b ?? [p0[0] + (cx - p0[0]) * 1.6, p0[1] + (cy - p0[1]) * 1.6];
      // bow outwards from the centre
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2, dx = mx - cx, dy = my - cy, d = Math.hypot(dx, dy) || 1;
      const c: [number, number] = [mx + (dx / d) * 46, my + (dy / d) * 46];
      const at = (t: number): [number, number] => [(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]];
      const col = this.routeColour(k), on = pathRoutes.has(k);
      lines += `<path d="M${p0[0]} ${p0[1]} Q${c[0]} ${c[1]} ${p1[0]} ${p1[1]}" stroke="${col}" stroke-width="${on ? 7 : 3.5}" stroke-opacity="${on || !p ? 1 : 0.4}" fill="none" stroke-linecap="round"/>`;
      const L = this.net.lengthKm(k);
      const [lx, ly] = at(0.5);
      labels += `<text x="${lx + (dx / d) * 16}" y="${ly + (dy / d) * 16}" class="rm-map-route" fill="${col}">${esc(r.name)}</text>`;
      for (const s of r.stations) {
        // (stations kept inside the line: the junction straights take the ends)
        const [x, y] = at(0.06 + 0.88 * (s.km / L)), sel = s.code === this.j.from ? 'from' : s.code === this.j.to ? 'to' : onPath.has(s.code) ? 'path' : '';
        dots += `<g class="rm-map-stn ${sel}" data-pick="${s.code}"><circle cx="${x}" cy="${y}" r="${sel ? 7 : 5}" fill="${sel === 'from' ? '#34d17e' : sel === 'to' ? '#ff9933' : col}"/><circle cx="${x}" cy="${y}" r="13" fill="transparent"/><title>${esc(s.name)} (${s.code})</title></g>`;
        if (sel === 'from' || sel === 'to') labels += `<text x="${x}" y="${y - 12}" class="rm-map-lbl ${sel}">${esc(s.name)}</text>`;
      }
    }
    for (const j of js) {
      const [x, y] = pos.get(j.id)!, sel = j.code === this.j.from ? 'from' : j.code === this.j.to ? 'to' : onPath.has(j.code) ? 'path' : '';
      dots += `<g class="rm-map-jn ${sel}" data-pick="${j.code}"><circle cx="${x}" cy="${y}" r="13" fill="#10213a" stroke="${sel === 'from' ? '#34d17e' : sel === 'to' ? '#ff9933' : '#ff9933'}" stroke-width="${sel ? 4 : 2.5}"/><text x="${x}" y="${y + 4}" class="rm-map-jcode">${esc(j.code)}</text><title>${esc(j.name)}</title></g>`;
      labels += `<text x="${x}" y="${y + (y < cy ? -19 : 27)}" class="rm-map-lbl jn">${esc(j.name)}</text>`;
    }
    return `<svg class="rm-map${small ? ' small' : ''}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Network map">${lines}${labels}${dots}</svg>`;
  }

  // ---------------------------------------------------------------- step 2: train
  private stepTrain() {
    const L = LOCOS[this.j.consist.loco], locked = !!L?.trainset, n = this.vehicles().length;
    const locoCard = (id: string) => {
      const l = LOCOS[id], type = l.type === 'diesel' ? 'Diesel' : l.type === 'trainset' ? 'Trainset' : 'Electric';
      return imageCard({ img: `assets/thumbs/${id}.jpg`, title: l.name, sub: `${type} · ${Math.round(l.maxPowerKW).toLocaleString('en-IN')} kW · ${l.maxSpeedKmph} km/h`, on: id === this.j.consist.loco, tint: l.livery.body, data: { loco: id } })
        .replace('onerror="', `onerror="this.onerror=null;this.src='${svgUrl(locoSvg(l)).replace(/'/g, '%27')}';return;`);
    };
    const count = (t: string) => this.vehicles().filter(v => v === t).length;
    const coachCard = (id: string) => {
      const c = COACHES[id];
      return imageCard({ img: svgUrl(coachSvg(c)), title: c.name, sub: `${c.lengthM.toFixed(1)} m · ${Math.round(c.massLoadedT)} t loaded`, badge: count(id) ? `× ${count(id)}` : undefined, tint: '#26303a', data: { addc: id }, disabled: locked, title2: locked ? 'This train has its own cars' : `Add a ${c.name}` });
    };
    const strip = [`<span class="rm-veh loco" title="${esc(L?.name ?? '')}"><img src="${svgUrl(L ? locoSvg(L) : '')}" alt="${esc(L?.name ?? '')}"></span>`,
      ...this.vehicles().map((t, i) => `<button class="rm-veh" data-veh="${i}" title="${esc(COACHES[t]?.name ?? t)}: tap to take off, drag to move"><img src="${svgUrl(coachSvg(COACHES[t]))}" alt="${esc(COACHES[t]?.name ?? t)}"></button>`)].join('');
    const freight = this.vehicles().some(t => COACHES[t]?.kind && COACHES[t].kind !== 'coach');
    return `<h3>${icon('loco')} Locomotive</h3>${gallery(Object.keys(LOCOS).map(locoCard), { label: 'Locomotives', cardWidth: 220 })}
      <h3>${icon('coach')} Coaches and wagons <small>tap to add at the end</small></h3>
      ${locked ? `<p class="rm-locked">${icon('info')} ${esc(L.name)} is a fixed trainset: this train has its own cars.</p>` : gallery(Object.keys(COACHES).map(coachCard), { label: 'Coaches and wagons', cardWidth: 190 })}
      <h3>${icon('train')} Your train <small>${n} ${freight ? 'wagons' : 'coaches'} · tap one to take it off, drag to move it</small></h3>
      <div class="rm-strip" data-strip>${strip}</div>
      ${locked ? '' : `<div class="rm-strip-ctl">
        <div class="chips">${Object.keys(PRESETS).map(k => chip(k, { data: { preset: k }, icon: k.includes('Freight') ? 'wagon' : k.includes('Double') ? 'container' : 'coach' })).join('')}</div>
        <div class="rm-counts">${[...new Set(this.vehicles())].map(t => `<span class="rm-count"><span>${esc(COACHES[t]?.name ?? t)}</span><button class="icon-btn" data-subc="${t}" aria-label="One fewer">${icon('minus')}</button><b>${count(t)}</b><button class="icon-btn" data-addc="${t}" aria-label="One more">${icon('plus')}</button></span>`).join('')}</div>
        ${freight ? toggle('Loaded', { checked: this.j.consist.loaded !== false, data: { f: 'loaded' }, hint: 'Wagons full (heavier, slower to stop) or empty' }) : ''}</div>`}
      ${toggle('Realistic rules', { checked: this.j.realistic, data: { f: 'realistic' }, hint: 'On: passenger trains stay off freight-only lines, as in real life' })}
      ${this.warningList()}`;
  }

  private warningList(code?: string) {
    const ws = this.warnings().filter(w => (code ? w.code === code : !w.code || this.step !== 2));
    if (!ws.length) return '';
    return `<ul class="rm-warn">${ws.map(w => `<li class="${w.level}">${icon(w.level === 'note' ? 'info' : 'warning')}<span>${esc(w.text)}</span></li>`).join('')}</ul>`;
  }

  // ---------------------------------------------------------------- step 3: plan
  private stepPlan() {
    return `<p class="sub">Every station on the way. Stop or pass; at a stop, how long, and the shunting work there.</p>
      ${toggle('Auto shunt', { checked: this.j.autoShunt, data: { f: 'auto' }, hint: 'The game makes the coupling moves for you' })}
      ${this.goodsSuggestions()}${this.timeline()}${this.warningList()}`;
  }

  /**
   * A goods train: the goods dispatcher's suggested stops (GoodsPlanner: unload what a yard receives, load what it
   * sends), put in the plan unless turned off; yards it has to pass by, and why.
   */
  private dismissed = new Set<string>();
  private goodsSuggestions() {
    const r = this.route();
    if (!r || !goodsTrain(this.j.consist, COACHES)) return '';
    const view = new Railway(r, REGIONS).view('DOWN');
    const codes = new Set(this.stations().map(s => s.code));
    // (what is aboard as it leaves: loaded at the start when it starts empty and loads there)
    const startStop = this.j.stops.find(x => x.code === this.j.from) ?? { code: this.j.from, stop: true, dwellS: 120 };
    const loadsAtStart = stopWork(this.j, startStop, true).includes('load');
    const wagons = planWagonsOfSpec(loadsAtStart ? { ...this.j.consist, loaded: true } : this.j.consist, COACHES);
    const { stops, skipped } = planGoods(goodsStations(view).filter(s => codes.has(s.code) && s.code !== this.j.from && s.code !== this.j.to), wagons, trainSize(this.j.consist, LOCOS, COACHES).lengthM);
    if (!stops.length && !skipped.length) return '';
    const same = (a?: string[], b?: string[]) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
    for (const g of stops) {
      const p = this.j.stops.find(x => x.code === g.station);
      if (p && p.work === undefined && !this.dismissed.has(g.station)) { p.stop = true; p.work = [...g.work]; }
    }
    return `<div class="rm-suggest"><b>${icon('freightLoad')} Goods work</b>
      ${stops.map(g => { const p = this.j.stops.find(x => x.code === g.station), on = !!p?.stop && same(p.work, g.work); return `<label class="tog"><input type="checkbox" data-sugg="${g.station}" ${on ? 'checked' : ''}><span>Suggested: ${esc(g.note)}</span></label>`; }).join('')}
      ${skipped.map(k => `<p class="note">${esc(k.reason)}</p>`).join('')}</div>`;
  }

  /** the vertical timeline (only = the stations to show, e.g. those still ahead) */
  private timeline(only?: string[]) {
    let left = this.vehicles().length;
    const first = this.stations()[0]?.km ?? 0;
    const locos = Object.values(LOCOS).filter(l => !l.trainset);
    // a fixed trainset (the bullet train): no coaches to leave or pick up, no loco to change
    const trainset = !!LOCOS[this.j.consist.loco]?.trainset;
    const rows = this.stations().map(s => {
      const p = this.j.stops.find(x => x.code === s.code) ?? { code: s.code, stop: false, dwellS: 60 };
      const end = s.code === this.j.from || s.code === this.j.to, start = s.code === this.j.from, fixed = end;
      if (p.stop && p.decouple) left -= p.decouple;
      if (p.stop && p.couple) for (const c of p.couple) left += c.count;
      if (only && !only.includes(s.code)) return '';
      // the station's choices open from its name: the platform work (any stop, the start too), the shunting (not at the start)
      const canAct = p.stop && s.code !== this.j.to, isOpen = canAct && this.expanded.has(s.code);
      const goods = goodsTrain(this.j.consist, COACHES), work = stopWork(this.j, p, goods)[0] ?? '';
      // (a goods train loads and unloads at its start, at terminals and at goods yards on its side of the line)
      const workSel = goods && !canWorkGoods(this.j, s)
        ? `<p class="note">${icon('freightLoad')} No goods yard on this side here: the train only stops.</p>`
        : goods
        ? `<label>${icon('freightLoad')}<select data-work="${s.code}"><option value="load"${work === 'load' ? ' selected' : ''}>Load the wagons</option><option value="unload"${work === 'unload' ? ' selected' : ''}>Unload the wagons</option><option value=""${!work ? ' selected' : ''}>No loading</option></select></label>`
        : `<label>${icon('users')}<select data-work="${s.code}"><option value="board"${work === 'board' ? ' selected' : ''}>Passengers board and alight</option><option value=""${!work ? ' selected' : ''}>No passenger work</option></select></label>`;
      // what is planned here, shown on the closed row
      const planned = [p.decouple ? icon('decouple') : '', p.couple?.length ? icon('couple') : '', p.changeLoco ? icon('loco') : ''].join('');
      const acts = isOpen && (start || trainset) ? `<div class="rm-acts">${workSel}</div>` : isOpen ? `<div class="rm-acts">${workSel}
        <label>${icon('decouple')}<select data-dec="${s.code}"><option value="0">Keep all</option>${Array.from({ length: Math.max(0, left + (p.decouple ?? 0) - 1) }, (_, i) => `<option value="${i + 1}"${p.decouple === i + 1 ? ' selected' : ''}>Leave the last ${i + 1}</option>`).join('')}</select></label>
        <label>${icon('couple')}<select data-ctype="${s.code}"><option value="">Pick up none</option>${Object.values(COACHES).map(c => `<option value="${c.id}"${p.couple?.[0]?.type === c.id ? ' selected' : ''}>Pick up ${esc(c.name)}</option>`).join('')}</select>
        ${p.couple?.length ? `<input type="number" min="1" max="40" value="${p.couple[0].count}" data-ccount="${s.code}" aria-label="How many">` : ''}</label>
        ${s.junction ? `<label>${icon('loco')}<select data-cloco="${s.code}"><option value="">Keep the loco</option>${locos.map(l => `<option value="${l.id}"${p.changeLoco === l.id ? ' selected' : ''}>Change to ${esc(l.name)}</option>`).join('')}</select></label>` : ''}</div>` : '';
      return `<li class="rm-tl${s.junction ? ' jn' : ''}${p.stop ? ' stop' : ''}${isOpen ? ' open' : ''}">
        <span class="rm-tl-dot">${s.junction ? icon('junction') : ''}</span>
        <div class="rm-tl-main"><div class="rm-tl-top">${canAct
          ? `<button type="button" class="rm-tl-name" data-open="${s.code}" aria-expanded="${isOpen}" title="${trainset ? 'Platform work here' : `Shunting here: leave or pick up coaches${s.junction ? ', change the loco' : ''}`}"><b>${esc(s.name)}</b><small>${s.code} · ${(s.km - first).toFixed(1)} km${s.junction ? ' · Junction' : ''}</small><span class="rm-tl-planned">${planned}</span>${icon('caretDown', 'rm-caret')}</button>`
          : `<span class="rm-tl-name"><b>${esc(s.name)}</b><small>${s.code} · ${(s.km - first).toFixed(1)} km${s.junction ? ' · Junction' : ''}</small></span>`}
          <span class="rm-tl-ctl">${fixed ? `<span class="chip on">${start ? 'Start' : 'End'}</span>` : chip(p.stop ? 'Stop' : 'Pass', { on: p.stop, data: { stop: s.code }, icon: p.stop ? 'platform' : 'arrowRight' })}
          ${p.stop && !start ? `<select data-dwell="${s.code}" aria-label="Stop time">${DWELLS.map(d => `<option value="${d}"${p.dwellS === d ? ' selected' : ''}>${d < 60 ? `${d} s` : `${d / 60} min`}</option>`).join('')}</select>` : ''}</span></div>
          ${acts}${this.warningList(s.code)}</div></li>`;
    }).join('');
    return `<ol class="rm-timeline">${rows}</ol>`;
  }

  private toggleOpen(code: string) { if (!this.expanded.delete(code)) this.expanded.add(code); }

  private toggleStop(code: string) {
    const p = this.j.stops.find(x => x.code === code);
    // (the start and the end are always stops; a station with shunting or a loco change planned stays one)
    if (!p || code === this.j.from || code === this.j.to) return;
    if (p.stop && (p.decouple || p.couple?.length || p.changeLoco)) { toast('Shunting is planned here: take it off first to pass this station', 'info'); return; }
    p.stop = !p.stop;
  }
  private planInput(t: HTMLInputElement) {
    const d = t.dataset, stop = (c: string) => this.j.stops.find(x => x.code === c)!;
    if (d.dwell) stop(d.dwell).dwellS = Number(t.value);
    if (d.work !== undefined) stop(d.work).work = t.value ? [t.value as 'board' | 'load' | 'unload'] : [];
    if (d.dec) stop(d.dec).decouple = Number(t.value) || undefined;
    if (d.ctype !== undefined) { const p = stop(d.ctype); p.couple = t.value ? [{ type: t.value, count: p.couple?.[0]?.count ?? 4 }] : undefined; }
    if (d.ccount) { const p = stop(d.ccount); if (p.couple?.[0]) p.couple[0].count = Math.max(1, Math.min(40, Number(t.value) || 1)); }
    if (d.cloco !== undefined) stop(d.cloco).changeLoco = t.value || undefined;
  }

  // ---------------------------------------------------------------- step 4: review and start
  private stepReview() {
    const st = this.stations(), first = st[0]?.km ?? 0, L = LOCOS[this.j.consist.loco];
    const act = (p: JourneyStop) => [p.decouple ? `${icon('decouple')} leave the last ${p.decouple}` : '', p.couple?.length ? `${icon('couple')} pick up ${p.couple[0].count} ${esc(COACHES[p.couple[0].type]?.name ?? '')}` : '', p.changeLoco ? `${icon('loco')} change to ${esc(LOCOS[p.changeLoco]?.name ?? '')}` : ''].filter(Boolean).join(' · ');
    const stops = this.j.stops.filter(p => p.stop);
    return `<div class="rm-review">
      <section class="card">${this.mapSvg(true)}</section>
      <section class="card"><h3>${icon('platform')} Stops</h3><ol class="rm-rv-stops">${stops.map(p => { const s = st.find(x => x.code === p.code); return `<li><b>${esc(s?.name ?? p.code)}</b> <small>${((s?.km ?? first) - first).toFixed(1)} km${p.code === this.j.from ? '' : ` · ${p.dwellS < 60 ? `${p.dwellS} s` : `${p.dwellS / 60} min`}`}</small>${act(p) ? `<div class="rm-rv-act">${act(p)}</div>` : ''}</li>`; }).join('')}</ol></section>
      <section class="card"><h3>${icon('train')} ${esc(L?.name ?? '')}</h3><div class="rm-strip small">${L ? `<span class="rm-veh loco"><img src="${svgUrl(locoSvg(L))}" alt=""></span>` : ''}${this.vehicles().map(t => `<span class="rm-veh"><img src="${svgUrl(coachSvg(COACHES[t]))}" alt=""></span>`).join('')}</div>
        <p>${icon(WX_ICON[this.j.weather])} ${esc(WEATHER[this.j.weather].name)} · ${icon('clock')} ${this.j.time} · ${this.j.autoShunt ? 'auto shunt' : 'you do the shunting'}</p></section></div>
      ${this.warningList()}
      <div class="rm-save"><label><span>Name</span><input type="text" data-f="name" maxlength="60" placeholder="${esc(`${this.name(this.j.from)} → ${this.name(this.j.to)}`)}" value="${esc(this.j.name ?? '')}"></label>
      <button data-a="save">${icon('save')}Save journey</button></div>`;
  }

  // ---------------------------------------------------------------- events
  private bind(el: HTMLElement) {
    bindGallery(el);
    fillSliders(el);
    el.addEventListener('click', e => {
      const t = e.target as Element, b = t.closest<HTMLElement>('[data-pick],button');
      if (!b) return;
      const d = b.dataset;
      if (d.a === 'back') return this.back();
      if (d.a === 'next') {
        if (this.step < 3) { this.step++; if (this.step === 2 && !this.j.stops.length) this.syncStops(); return this.render(); }
        return this.go(clone(this.j));
      }
      if (d.step !== undefined && Number(d.step) < this.step) { this.step = Number(d.step); return this.render(); }
      // step 1
      if (d.pick) {
        if (this.picking === 'from') { this.j.from = d.pick; if (this.j.to === d.pick) this.j.to = ''; this.picking = 'to'; }
        else { if (d.pick === this.j.from) return; this.j.to = d.pick; }
        this.j.via = this.paths()[0]?.junctions ?? [];
        this.syncStops();
        return this.render();
      }
      if (d.picking) { this.picking = d.picking as 'from' | 'to'; return this.render(); }
      if (d.a === 'swap') { [this.j.from, this.j.to] = [this.j.to, this.j.from]; this.j.via = this.paths()[0]?.junctions ?? []; this.syncStops(); return this.render(); }
      if (d.via !== undefined) { this.j.via = this.paths()[Number(d.via)]?.junctions ?? []; this.syncStops(); return this.render(); }
      if (d.time) { this.j.time = d.time; return this.render(); }
      if (d.wx) { this.j.weather = d.wx as WeatherId; return this.render(); }
      // step 2
      if (d.loco) { this.j.consist.loco = d.loco; return this.render(); }
      if (d.addc) {
        if (b.getAttribute('aria-disabled') === 'true') { toast('This train has its own cars', 'info'); return; }
        if (this.vehicles().length >= MAX_VEHICLES) { toast(`At most ${MAX_VEHICLES} vehicles`, 'warn'); return; }
        this.setVehicles([...this.vehicles(), d.addc]);
        return this.render();
      }
      if (d.subc) { const v = this.vehicles(), i = v.lastIndexOf(d.subc); if (i >= 0) v.splice(i, 1); this.setVehicles(v); return this.render(); }
      if (d.preset) {
        const pr = PRESETS[d.preset];
        this.j.consist = { ...this.j.consist, loco: pr.loco && LOCOS[pr.loco] ? pr.loco : LOCOS[this.j.consist.loco]?.trainset ? 'wap7' : this.j.consist.loco, coaches: clone(pr.coaches).filter(c => COACHES[c.type]), loaded: pr.loaded ?? true };
        return this.render();
      }
      if (d.veh !== undefined && !this.dragged) { const v = this.vehicles(); v.splice(Number(d.veh), 1); this.setVehicles(v); return this.render(); }
      // step 3
      if (d.stop) { this.toggleStop(d.stop); return this.render(); }
      if (d.open) { this.toggleOpen(d.open); return this.render(); }
      // step 4
      if (d.a === 'save') {
        const st = loadStore(), j = clone(this.j);
        j.name = j.name?.trim() || `${this.name(j.from)} → ${this.name(j.to)}`;
        st.saved = [j, ...st.saved.filter(x => x.name !== j.name)].slice(0, 20);
        saveStore(st);
        toast(`Saved "${j.name}"`, 'good');
      }
    });
    el.addEventListener('input', e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.f === 'search') { this.query = t.value; el.querySelector('.rm-list')!.innerHTML = this.stationList(); }
      if (t.dataset.f === 'time') { this.j.time = hhmm(Number(t.value)); t.parentElement!.querySelector('output')!.textContent = this.j.time; el.querySelectorAll<HTMLElement>('[data-time]').forEach(c => c.classList.toggle('on', c.dataset.time === this.j.time)); }
      if (t.dataset.f === 'name') this.j.name = t.value;
    });
    el.addEventListener('change', e => {
      const t = e.target as HTMLInputElement, f = t.dataset.f;
      if (f === 'loaded') { this.j.consist.loaded = t.checked; return this.render(); }
      if (f === 'realistic') { this.j.realistic = t.checked; return this.render(); }
      if (f === 'auto') { this.j.autoShunt = t.checked; return; }
      if (t.dataset.sugg) {
        // a suggested goods stop taken out (the stop too, unless shunting is planned there) or put back
        const p = this.j.stops.find(x => x.code === t.dataset.sugg);
        if (p && !t.checked) { this.dismissed.add(p.code); p.work = []; if (!p.decouple && !p.couple?.length && !p.changeLoco) p.stop = false; }
        if (p && t.checked) { this.dismissed.delete(p.code); p.work = undefined; }
        return this.render();
      }
      if (t.dataset.dwell || t.dataset.work !== undefined || t.dataset.dec || t.dataset.ctype !== undefined || t.dataset.ccount || t.dataset.cloco !== undefined) { this.planInput(t); this.render(); }
    });
    this.bindStripDrag(el);
  }

  /** drag a vehicle along the strip to move it (a tap still takes it off) */
  private dragged = false;
  private bindStripDrag(el: HTMLElement) {
    const strip = el.querySelector<HTMLElement>('[data-strip]');
    if (!strip) return;
    let from = -1, x0 = 0, ghost: HTMLElement | null = null;
    strip.addEventListener('pointerdown', e => {
      const v = (e.target as Element).closest<HTMLElement>('[data-veh]');
      if (!v) return;
      from = Number(v.dataset.veh); x0 = e.clientX; this.dragged = false;
      v.setPointerCapture(e.pointerId);
      ghost = v;
    });
    strip.addEventListener('pointermove', e => {
      if (from < 0 || !ghost) return;
      const dx = e.clientX - x0;
      if (Math.abs(dx) > 8) this.dragged = true;
      if (this.dragged) { ghost.style.transform = `translateX(${dx}px)`; ghost.classList.add('dragging'); }
    });
    strip.addEventListener('pointerup', e => {
      if (from < 0) return;
      if (this.dragged && ghost) {
        ghost.style.visibility = 'hidden';
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-veh]');
        const to = over ? Number(over.dataset.veh) : from;
        const v = this.vehicles(), [m] = v.splice(from, 1);
        v.splice(to, 0, m);
        this.setVehicles(v);
        from = -1;
        setTimeout(() => { this.dragged = false; }, 0);
        this.render();
        return;
      }
      from = -1;
    });
  }
}
