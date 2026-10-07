import { fmtDist, h, setText, show } from './dom';
import { ICON } from './icons';

/** Next (lower) speed limit, shown once it is within 2 km. */
export class SpeedLimitCard {
  readonly el = h('div', 'm-card m-limitcard', `<span class="m-sign"><b></b></span><span class="m-txt"><span class="m-lbl">Next Speed Limit in </span><b class="m-dist"></b></span>`);
  update(r: { kmph: number; dist: number } | null) {
    const on = !!r && r.dist <= 2000;
    show(this.el, on);
    if (!on) return;
    setText(this.el.querySelector('.m-sign b')!, String(r!.kmph));
    setText(this.el.querySelector('.m-dist')!, fmtDist(r!.dist));
  }
}

/** Next station ahead, shown from 3 km out. */
export class StationCard {
  readonly el = h('div', 'm-card m-station', `<span class="m-ico">${ICON.station}</span><span class="m-txt"><b class="m-name"></b><span class="m-lbl"> in</span> <b class="m-dist"></b></span>`);
  update(s: { name: string; dist: number } | null) {
    const on = !!s && s.dist <= 3000;
    show(this.el, on);
    if (!on) return;
    setText(this.el.querySelector('.m-name')!, s!.name);
    setText(this.el.querySelector('.m-dist')!, fmtDist(s!.dist));
  }
}

export interface TimetableInfo {
  clock: string;
  /** booked arrival ahead: minutes until the booked time, and expected lateness */
  arrival: { station: string; minutes: number; lateMin: number } | null;
  /** booked departure not yet made (e.g. waiting at the first station) */
  departure: { station: string; time: string } | null;
  /** next station on the line, for runs without a timetable */
  nextStop: string | null;
}

/** Game clock plus the next booked event (or just the next stop in Free Roam). */
export class TimetableCard {
  readonly el = h('div', 'm-card m-timetable', `<b class="m-clock"></b><span class="m-txt"></span>`);
  private key = '';
  update(t: TimetableInfo) {
    setText(this.el.querySelector('.m-clock')!, t.clock.slice(0, 5));
    let html = '', state = '';
    if (t.arrival) {
      const m = Math.max(0, Math.round(t.arrival.minutes));
      const late = t.arrival.lateMin;
      state = late > 1 ? 'late' : 'ok';
      const note = late > 1 ? `${late} min late` : late < -1 ? `${-late} min early` : 'on time';
      html = `<span class="m-lbl">Reach </span><b>${esc(t.arrival.station)}</b><span class="m-lbl"> in</span> <b>${m} min</b><small>${note}</small>`;
    } else if (t.departure) {
      html = `<span class="m-lbl">Depart </span><b>${esc(t.departure.station)}</b><span class="m-lbl"> at</span> <b>${t.departure.time}</b>`;
    } else if (t.nextStop) {
      html = `<span class="m-lbl">Next stop: </span><b>${esc(t.nextStop)}</b>`;
    }
    const key = html + state;
    if (key === this.key) return;
    this.key = key;
    this.el.querySelector('.m-txt')!.innerHTML = html;
    this.el.classList.toggle('late', state === 'late');
    this.el.classList.toggle('ontime', state === 'ok');
  }
}

/** Score with the Rail Bharat roundel; only for scored runs. */
export class ScoreBadge {
  readonly el = h('div', 'm-card m-score', `<span class="m-ico">${ICON.badge}</span><span class="m-txt"><small>SCORE</small><b></b></span>`);
  update(score: number | null) {
    show(this.el, score !== null);
    if (score !== null) setText(this.el.querySelector('b')!, String(Math.round(score)));
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
