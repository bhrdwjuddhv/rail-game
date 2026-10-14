import { COACHES, LOCOS } from '../data';
import { readScene, SCENE_FORMAT, SceneFile } from '@rail/shared/record/SceneFile';
import type { Studio } from './host';
import type { RecordTrains } from './RecordTrains';
import type { RecordCameras } from './RecordCameras';
import type { FilmLook } from './FilmLook';
import type { WorldTab } from './WorldTab';
import type { RecordSettings } from './RecordSettings';

const KEY = 'railbharat.record.scenes.v1';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Saved scenes in this browser: name -> scene file (storage blocked or full: says so, never throws). */
function loadAll(): Record<string, unknown> {
  try { const raw = localStorage.getItem(KEY); const v = raw ? JSON.parse(raw) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function saveAll(all: Record<string, unknown>) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); return true; } catch { return false; }
}

interface Parts { trains: RecordTrains; cams: RecordCameras; film: FilmLook; world: WorldTab; settings: RecordSettings }

/**
 * The Scenes tab: everything set up in Record Mode (trains with their paths
 * and settings, bookmarks, camera and film settings, world, record settings)
 * saved by name in this browser, or exported / imported as a .json file.
 */
export class Scenes {
  readonly el = document.createElement('div');

  constructor(private st: Studio, private p: Parts) {
    this.el.className = 'rec-scenes';
    this.render();
  }

  /** The current setup as a scene file. */
  build(name: string): SceneFile {
    const { trains, cams, film, world, settings } = this.p, c = cams.toScene();
    return {
      format: SCENE_FORMAT, version: 1, name, route: this.st.h.route.data.id, savedAt: new Date().toISOString(),
      trains: trains.list.map(s => trains.snapshot(s)), bookmarks: c.bookmarks, camera: c.camera,
      film: film.toScene(), world: world.toScene(), settings: settings.toScene(),
    };
  }

  /** Read and apply a scene (from storage or a file). Trains only on the route they were made on. */
  load(raw: unknown) {
    const h = this.st.h;
    const res = readScene(raw, { locos: new Set(Object.keys(LOCOS)), coaches: new Set(Object.keys(COACHES)), routeLengthKm: h.route.lengthKm, tracks: h.railway.views.map(v => v.running.id) });
    if (!res.scene) { this.st.toast(res.notes[0] ?? 'Not a scene file', true); return; }
    const s = res.scene, { trains, cams, film, world, settings } = this.p;
    for (const t of [...trains.list]) trains.remove(t);
    let placed = 0;
    if (s.route && s.route !== h.route.data.id) this.st.toast(`"${s.name}" was made on another route (${s.route}): its trains are left out, the rest is loaded`, true);
    else for (const t of s.trains) if (trains.restore(t)) placed++;
    settings.fromScene(s.settings);
    world.fromScene(s.world);
    film.fromScene(s.film);
    cams.fromScene(s);
    for (const n of res.notes.slice(0, 4)) this.st.toast(n, true);
    this.st.toast(`Scene "${s.name}" loaded: ${placed} train${placed === 1 ? '' : 's'}`);
    trains.render();
  }

  private save(name: string) {
    name = name.trim().slice(0, 60);
    if (!name) { this.st.toast('Give the scene a name first', true); return; }
    const all = loadAll();
    all[name] = this.build(name);
    if (!saveAll(all)) {
      // no room (thumbnails are the bulk): try without them
      const lean = this.build(name);
      lean.bookmarks = lean.bookmarks.map(b => b && { ...b, thumb: undefined });
      all[name] = lean;
      if (!saveAll(all)) { this.st.toast('Could not save: browser storage is full or blocked. Use Export instead.', true); return; }
      this.st.toast(`Scene "${name}" saved (without bookmark pictures: storage is nearly full)`);
    } else this.st.toast(`Scene "${name}" saved`);
    this.render();
  }

  private download(scene: unknown, name: string) {
    const blob = new Blob([JSON.stringify(scene, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'scene'}.railscene.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  render() {
    const all = loadAll();
    const names = Object.keys(all).sort();
    this.el.innerHTML = `
      <label>Name <input data-k="name" maxlength="60" placeholder="e.g. Ghat sunset chase"></label>
      <div class="buttons left"><button data-a="save" class="primary">Save scene</button><button data-a="export">Export .json</button><button data-a="import">Import .json&hellip;</button></div>
      <input type="file" accept=".json,application/json" data-k="file" hidden>
      <p class="note">A scene keeps the trains (and their paths and settings), bookmarks, camera and film settings, the world and Record Mode's settings.</p>
      ${names.length ? `<table class="rec-list">${names.map(n => {
        const sc = all[n] as Partial<SceneFile>;
        return `<tr><td>${esc(n)}<br><small class="dim">${esc(sc.route ?? '')} &middot; ${Array.isArray(sc.trains) ? sc.trains.length : 0} trains &middot; ${esc((sc.savedAt ?? '').slice(0, 16).replace('T', ' '))}</small></td>
          <td class="acts"><button data-l="${esc(n)}">Load</button><button data-x="${esc(n)}" title="Export this one">&#8681;</button><button data-d="${esc(n)}" title="Delete">&#10005;</button></td></tr>`;
      }).join('')}</table>` : '<p class="note">No saved scenes yet.</p>'}`;
  }

  bind() {
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const d = b.dataset, name = (this.el.querySelector('[data-k="name"]') as HTMLInputElement).value;
      if (d.a === 'save') this.save(name);
      if (d.a === 'export') this.download(this.build(name.trim() || 'Untitled scene'), name || 'scene');
      if (d.a === 'import') (this.el.querySelector('[data-k="file"]') as HTMLInputElement).click();
      if (d.l) this.load(loadAll()[d.l]);
      if (d.x) this.download(loadAll()[d.x], d.x);
      if (d.d) { const all = loadAll(); delete all[d.d]; saveAll(all); this.render(); }
    });
    this.el.addEventListener('change', e => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.k !== 'file' || !t.files?.[0]) return;
      const f = t.files[0];
      if (f.size > 4_000_000) { this.st.toast('That file is too big to be a scene', true); return; }
      void f.text().then(txt => {
        let raw: unknown;
        try { raw = JSON.parse(txt); } catch { this.st.toast('Not a JSON file', true); return; }
        this.load(raw);
      });
      t.value = '';
    });
  }
}
