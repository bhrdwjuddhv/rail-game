import { icon } from '../ui/theme/icons';
import type { Studio } from './host';
import type { RecordSettings } from './RecordSettings';
import type { FilmLook } from './FilmLook';
import type { LiveRecorder, Quality, RenderRecorder, Sink } from './Recorders';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** video sizes (16:9) and their names in file names */
const SIZES: Record<string, { w: number; h: number; tag: string }> = {
  '1080': { w: 1920, h: 1080, tag: '1080p' }, '1440': { w: 2560, h: 1440, tag: '1440p' }, '2160': { w: 3840, h: 2160, tag: '4K' }, '4320': { w: 7680, h: 4320, tag: '8K' },
};
const DURATIONS = [10, 30, 60, 0, -1]; // 0: until Stop; -1: custom
type Shape = '16:9' | '9:16' | '1:1';

/** A 16:9 size turned to the shape: 9:16 stands it on end (1080 x 1920), 1:1 keeps its height. */
function shaped(z: { w: number; h: number; tag: string }, shape: Shape) {
  if (shape === '9:16') return { w: z.h, h: z.w, tag: `${z.tag}_9x16` };
  if (shape === '1:1') return { w: z.h, h: z.h, tag: `${z.tag}_1x1` };
  return z;
}

const DEFAULTS = {
  mode: 'live' as 'live' | 'render',
  /** the picture's shape: auto follows the Film tab's frame guide (9:16, 1:1), else 16:9 */
  shape: 'auto' as 'auto' | Shape,
  liveSize: '1080',
  liveFormat: 'auto' as 'auto' | 'mp4' | 'webm', quality: 'high' as Quality, countdown: true,
  renderSize: '2160', renderFps: 60, renderFormat: 'mp4' as 'mp4' | 'webm', duration: 10, customS: 20,
  shotSize: 'screen', shotFormat: 'png' as 'png' | 'jpeg', jpegQ: 0.92, burst: false,
};
type CaptureSettings = typeof DEFAULTS;

interface Captured { name: string; bytes: number; file: Blob | File; url?: string }

const two = (n: number) => String(n).padStart(2, '0');
/** railbharat_2026-10-17_21-30-05_4K60.mp4 */
function fileName(label: string, ext: string) {
  const d = new Date();
  return `railbharat_${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}_${label}.${ext}`;
}
const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.max(0, b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`);
const clock = (s: number) => `${two(Math.floor(s / 60))}:${two(Math.floor(s % 60))}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type FsWindow = Window & {
  showSaveFilePicker?: (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o?: { mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

/**
 * Record Mode's Capture tab: live recording (canvas + game sound, MediaRecorder), High-Quality Render
 * (frame by frame at a fixed time step, WebCodecs, any size, smooth), and high-resolution screenshots.
 * Only the canvas is captured: the menus, badges and guides are HTML and never in the picture; the film
 * look (colour, letterbox, grain) is drawn into the canvas, so it is. F9 records, F10 (or Ctrl + Shift + S)
 * takes a screenshot.
 */
export class Capture {
  s: CaptureSettings = { ...DEFAULTS };
  readonly el = document.createElement('div');
  private badge = document.createElement('div');
  private flash = document.createElement('div');
  private count = document.createElement('div');
  /** the folder chosen for this session (File System Access), or null: ask / download */
  private dir: FileSystemDirectoryHandle | null = null;
  private list: Captured[] = [];
  private live: { rec: LiveRecorder; type: string; name: string; poll: number; slowFor: number; warned: boolean } | null = null;
  private render: { rec: RenderRecorder; type: string; name: string; total: number; skip: number; t0: number; fps: number } | null = null;
  private starting = false;
  private shooting = false;
  private rendered: (() => void)[] = [];
  private fpsAvg = 60;
  private uiT = 0;

  constructor(private st: Studio, private settings: RecordSettings, private film: FilmLook) {
    this.el.className = 'rec-capture';
    this.badge.className = 'rec-badge';
    this.badge.hidden = true;
    this.flash.className = 'rec-flash';
    this.count.className = 'rec-count';
    this.count.hidden = true;
    document.body.append(this.badge, this.flash, this.count);
    this.render_();
  }

  /** WebCodecs here at all (High-Quality Render needs it) */
  private get canRender() { return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'; }
  get recording() { return !!this.live || !!this.render; }
  /** recording, rendering or taking a still: nothing but the picture in the canvas (no selection outline) */
  get busy() { return this.recording || this.shooting || this.starting; }

  /** the shape captures come out in */
  private shape(): Shape {
    if (this.s.shape !== 'auto') return this.s.shape;
    return this.film.s.v916 ? '9:16' : this.film.s.square ? '1:1' : '16:9';
  }

  /** The canvas at a capture's size and shape (shown scaled to the window, black round it), or back to Settings'. */
  private setOutput(o: { w: number; h: number } | null) {
    if (o) this.st.h.rec.output = o; else this.settings.apply();
    dispatchEvent(new Event('resize'));
  }

  // ------------------------------------------------------------------ saving
  /** A sink for a new file: in the chosen folder, or where the user picks, else memory (downloaded at the end). */
  private async sinkFor(name: string, type: string, ext: string): Promise<Sink | null> {
    const R = await import('./Recorders');
    const w = window as FsWindow;
    try {
      if (this.dir) return R.fileSink(await this.dir.getFileHandle(name, { create: true }));
      if (w.showSaveFilePicker) return R.fileSink(await w.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [type.split(';')[0]]: [`.${ext}`] } }] }));
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return null; // the save dialog was cancelled
      this.st.toast(`Could not open the file (${(e as Error).message}): keeping it in memory`, true);
    }
    return R.memorySink();
  }

  private async chooseFolder() {
    const w = window as FsWindow;
    if (!w.showDirectoryPicker) { this.st.toast('This browser cannot pick a folder: files are downloaded', true); return; }
    try { this.dir = await w.showDirectoryPicker({ mode: 'readwrite' }); this.st.toast(`Saving to ${this.dir.name}`); } catch { /* cancelled */ }
    this.render_();
  }

  /** A finished file: in the list, and downloaded when it was only in memory. */
  private done(name: string, file: Blob | File, inMemory: boolean) {
    const c: Captured = { name, bytes: file.size, file };
    this.list.unshift(c);
    if (this.list.length > 12) { const old = this.list.pop()!; if (old.url) URL.revokeObjectURL(old.url); }
    if (inMemory) {
      const a = document.createElement('a');
      c.url = URL.createObjectURL(file);
      a.href = c.url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    this.st.toast(`Saved ${name} (${mb(file.size)})`);
    this.render_();
  }

  private async saveImage(name: string, blob: Blob) {
    if (this.dir) {
      try {
        const w = await (await this.dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(blob); await w.close();
        this.done(name, blob, false);
        return;
      } catch (e) { this.st.toast(`Could not write to the folder (${(e as Error).message}): downloading`, true); }
    }
    this.done(name, blob, true);
  }

  // ------------------------------------------------------------------ video
  /** F9 / the Record button: start (after the countdown) or stop. */
  async toggle() {
    if (this.render) { await this.finishRender(); return; }
    if (this.live) { await this.stopLive(); return; }
    if (this.starting || this.shooting) return;
    this.starting = true;
    try {
      if (this.s.countdown) for (const n of [3, 2, 1]) { this.count.textContent = String(n); this.count.hidden = false; await sleep(1000); }
      this.count.hidden = true;
      if (this.s.mode === 'render') await this.startRender(); else await this.startLive();
    } finally { this.count.hidden = true; this.starting = false; this.render_(); }
  }

  private async startLive() {
    const h = this.st.h, R = await import('./Recorders');
    const fmt = R.liveFormat(this.s.liveFormat);
    if (!fmt) { this.st.toast('This browser cannot record video (no MediaRecorder format)', true); return; }
    const c = h.canvas, fps = this.settings.s.fps || 60, shape = this.shape();
    const base = SIZES[this.s.liveSize] ?? { w: Math.round(c.height * 16 / 9), h: c.height, tag: `${c.height}p` };
    const z = shaped(base, shape);
    const name = fileName(`${z.tag.replace(/(_\d+x\d+)?$/, `${fps}$1`)}`, fmt.ext);
    const sink = await this.sinkFor(name, fmt.type, fmt.ext);
    if (!sink) return;
    this.setOutput({ w: z.w, h: z.h });
    const bits = Math.round(c.width * c.height * fps * R.BPP[this.s.quality]);
    const audio = h.audio ? { ctx: h.audio.ctx, out: h.audio.out } : null;
    const rec = new R.LiveRecorder(c, fps, sink, fmt.type, bits, audio, () => { this.st.toast('Recording stopped at 2 GB (choose a folder to record longer)', true); void this.stopLive(); });
    // the game paused (its menu) or the tab hidden: the recording pauses with it
    const poll = window.setInterval(() => rec.pause(h.paused() || document.hidden), 250);
    this.live = { rec, type: fmt.type, name, poll, slowFor: 0, warned: false };
    this.st.toast(`Recording ${fmt.ext.toUpperCase()}${audio ? ' with sound' : ''}${sink.onDisk ? ' straight to disk' : ' (in memory: up to 2 GB)'} - F9 stops`);
  }

  private async stopLive() {
    const l = this.live;
    if (!l) return;
    this.live = null;
    clearInterval(l.poll);
    this.badge.hidden = true;
    this.setOutput(null);
    try { const f = await l.rec.stop(l.type); this.done(l.name, f, !(f instanceof File)); } catch (e) { this.st.toast(`Recording failed: ${(e as Error).message}`, true); }
    this.render_();
  }

  private renderSize() { return shaped(SIZES[this.s.renderSize] ?? SIZES['2160'], this.shape()); }
  private renderBits() { const z = this.renderSize(); return Math.round(z.w * z.h * this.s.renderFps * { standard: 0.1, high: 0.16, max: 0.26 }[this.s.quality]); }
  private renderSeconds() { return this.s.duration === -1 ? Math.max(1, this.s.customS) : this.s.duration; }

  private async startRender() {
    const h = this.st.h, R = await import('./Recorders'), z = this.renderSize(), fps = this.s.renderFps;
    if (!this.canRender) { this.st.toast('High-Quality Render needs WebCodecs (Chrome or Edge)', true); return; }
    const codecs = await R.renderCodecs(z.w, z.h, fps, this.renderBits());
    const pick = this.s.renderFormat === 'webm' ? codecs.find(c => c.muxer !== 'avc') : codecs[0];
    if (!pick) { this.st.toast(`No ${this.s.renderFormat.toUpperCase()} encoder for ${z.tag} here: try a smaller size or the other format`, true); return; }
    const ext = this.s.renderFormat, type = ext === 'webm' ? 'video/webm' : 'video/mp4';
    const name = fileName(z.tag.replace(/(_\d+x\d+)?$/, `${fps}$1`), ext);
    const sink = await this.sinkFor(name, type, ext);
    if (!sink) return;
    const rec = await R.RenderRecorder.create(pick, ext, z.w, z.h, fps, this.renderBits(), sink);
    // the canvas at the render size (shown scaled to the window), every frame exactly 1 / fps of world time,
    // the next frame held while the encoder is busy
    this.setOutput({ w: z.w, h: z.h });
    h.setFpsCap(0);
    h.setFrameClock(1 / fps, () => rec.ready());
    const secs = this.renderSeconds();
    this.render = { rec, type, name, total: secs > 0 ? Math.round(secs * fps) : Infinity, skip: 2, t0: performance.now(), fps };
    this.st.toast(`Rendering ${z.tag} ${fps} FPS ${pick.name}${secs > 0 ? `, ${secs} s` : ' until Stop'} - no sound in this mode`);
  }

  /** The render ends (its length reached, Stop, or Cancel): the game back to real time and its own size. */
  private restoreClock() {
    const h = this.st.h;
    h.setFrameClock(null, null);
    this.setOutput(null);
  }

  private async finishRender() {
    const r = this.render;
    if (!r) return;
    this.render = null;
    this.restoreClock();
    this.badge.hidden = true;
    try { const f = await r.rec.finish(r.type); this.done(r.name, f, !(f instanceof File)); } catch (e) { this.st.toast(`Render failed: ${(e as Error).message}`, true); }
    this.render_();
  }

  private async cancelRender() {
    const r = this.render;
    if (!r) return;
    this.render = null;
    this.restoreClock();
    this.badge.hidden = true;
    await r.rec.cancel();
    this.st.toast('Render cancelled');
    this.render_();
  }

  // ------------------------------------------------------------------ screenshots
  /** The largest picture the GPU draws in one go. */
  private maxSize() {
    const r = this.st.h.rs.renderer as unknown as { getContext?: () => WebGL2RenderingContext; backend?: { device?: GPUDevice } };
    try {
      const gl = r.getContext?.();
      if (gl && 'MAX_RENDERBUFFER_SIZE' in gl) { const v = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array; return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, v[0], v[1]); }
    } catch { /* not WebGL */ }
    return r.backend?.device?.limits.maxTextureDimension2D ?? 8192;
  }

  /** the screenshot's size: a preset or the screen's height, in the shape */
  private shotSize() {
    const c = this.st.h.canvas, z = SIZES[this.s.shotSize];
    return shaped(z ?? { w: Math.round(c.height * 16 / 9), h: c.height, tag: `${c.height}p` }, this.shape());
  }

  /** The next frame drawn (resolved right after it, while the canvas still holds it). */
  private nextFrame() { return new Promise<void>(res => { this.rendered.push(res); this.st.h.requestRender(); }); }

  /** F10: a still (or a burst of 5) at the chosen size; frozen or not. */
  async screenshot() {
    if (this.shooting || this.render) return;
    this.shooting = true;
    try {
      const n = this.s.burst ? 5 : 1;
      for (let i = 0; i < n; i++) {
        const blob = await this.still();
        if (!blob) break;
        this.flash.classList.remove('on'); void this.flash.offsetWidth; this.flash.classList.add('on');
        await this.saveImage(fileName(`${this.shotSize().tag}${n > 1 ? `_${i + 1}` : ''}`, this.s.shotFormat === 'png' ? 'png' : 'jpg'), blob);
        if (i < n - 1) await sleep(200);
      }
    } catch (e) { this.st.toast(`Screenshot failed: ${(e as Error).message}`, true); } finally { this.shooting = false; }
  }

  /**
   * One picture at the chosen size, drawn off the screen's own size (the canvas's pixels change for a frame,
   * its place on screen does not): in one go up to the GPU's limit, in tiles beyond it (the world held still).
   */
  private async still(): Promise<Blob | null> {
    const h = this.st.h, c = h.canvas;
    const { w: W, h: H } = this.shotSize();
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g = out.getContext('2d')!;
    const before = h.rec.output, max = this.maxSize();
    const cols = Math.ceil(W / max), rows = Math.ceil(H / max), tw = Math.ceil(W / cols), th = Math.ceil(H / rows);
    const scale = h.rec.scale;
    try {
      if (cols * rows > 1) h.rec.scale = 0; // tiles of one moment
      h.rec.output = { w: tw, h: th };
      h.resize();
      const cam = h.cameras.camera;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (cols * rows > 1) { cam.aspect = W / H; h.rcam.setViewOffset(W, H, x * tw, y * th, tw, th); }
        await this.nextFrame();
        g.drawImage(c, 0, 0, c.width, c.height, x * tw, y * th, tw, th);
      }
    } finally {
      h.rcam.clearViewOffset();
      h.rec.scale = scale;
      h.rec.output = before;
      h.resize();
    }
    return new Promise(res => out.toBlob(b => res(b), this.s.shotFormat === 'png' ? 'image/png' : 'image/jpeg', this.s.jpegQ));
  }

  // ------------------------------------------------------------------ the game's calls
  /** Right after a frame is drawn: the render's frame, a still waiting for it. */
  afterRender() {
    const r = this.render, c = this.st.h.canvas;
    if (r) {
      // (the first frames after the resize are skipped: the canvas settles at the render size)
      if (r.skip > 0) r.skip--;
      else if (c.width === this.renderSize().w) r.rec.add(c);
    }
    const w = this.rendered;
    this.rendered = [];
    for (const f of w) f();
  }

  frame(dt: number) {
    if (dt > 0) this.fpsAvg += (1 / dt - this.fpsAvg) * Math.min(1, dt * 2);
    const l = this.live, r = this.render;
    if (l) {
      l.rec.tick(dt);
      // the PC not keeping up at this size: say so once
      const want = this.settings.s.fps || 60;
      l.slowFor = this.fpsAvg < want * 0.85 ? l.slowFor + dt : 0;
      if (l.slowFor > 3 && !l.warned) { l.warned = true; this.st.toast('Live recording may stutter at this size - use High-Quality Render for smooth 4K', true); }
    }
    if (r) {
      if (r.rec.failed) { this.st.toast(`Render failed: ${(r.rec.failed as Error).message}`, true); void this.cancelRender(); return; }
      if (r.rec.frames >= r.total) { void this.finishRender(); return; }
      if (r.rec.bytes > 2 * 1024 ** 3 && !this.dir) { this.st.toast('Render stopped at 2 GB (choose a folder to render longer)', true); void this.finishRender(); return; }
    }
    // the badge: on screen only (HTML), hidden in clean view; the tab's progress
    const show = !!(l || r) && this.st.uiVisible();
    this.badge.hidden = !show;
    if (show && (this.uiT -= dt) <= 0) {
      this.uiT = 0.25;
      if (l) this.badge.textContent = `● REC ${clock(l.rec.seconds)} · ${mb(l.rec.bytes)}${l.rec.paused ? ' · paused' : ''}`;
      if (r) {
        const left = r.total === Infinity ? null : ((performance.now() - r.t0) / Math.max(1, r.rec.frames)) * (r.total - r.rec.frames) / 1000;
        this.badge.textContent = `● RENDER ${r.rec.frames}${r.total === Infinity ? '' : ` / ${r.total}`} frames · ${clock(r.rec.frames / r.fps)}${left !== null ? ` · ${clock(left)} left` : ''} · ${mb(r.rec.bytes)}`;
        const bar = this.el.querySelector<HTMLProgressElement>('progress');
        if (bar && r.total !== Infinity) bar.value = r.rec.frames / r.total;
      }
    }
  }

  dispose() {
    if (this.live) { clearInterval(this.live.poll); void this.live.rec.cancel(); this.live = null; }
    if (this.render) { this.restoreClock(); void this.render.rec.cancel(); this.render = null; }
    for (const c of this.list) if (c.url) URL.revokeObjectURL(c.url);
    this.badge.remove(); this.flash.remove(); this.count.remove();
  }

  // ------------------------------------------------------------------ the tab
  render_() {
    const s = this.s, rs = this.settings.s, recording = this.recording;
    const sel = (k: keyof CaptureSettings, label: string, opts: [string | number, string][], dis = false) => `<label>${label} <select data-c="${k}" ${dis ? 'disabled' : ''}>${opts.map(([v, n]) => `<option value="${v}" ${String(s[k]) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
    const tog = (k: keyof CaptureSettings, label: string) => `<label class="tog"><input type="checkbox" data-c="${k}" ${s[k] ? 'checked' : ''}><span>${label}</span></label>`;
    const quality = sel('quality', 'Quality', [['standard', 'Standard'], ['high', 'High'], ['max', 'Very high']], recording);
    const z = this.renderSize(), est = (this.renderBits() * Math.max(1, this.renderSeconds() || 60)) / 8;
    const live = `
      ${sel('liveFormat', 'Format', [['auto', 'Best (MP4 if possible)'], ['mp4', 'MP4 (H.264 / AAC)'], ['webm', 'WebM (VP9 / Opus)']], recording)}
      ${quality}
      ${sel('liveSize', 'Size', [['window', 'The window\'s height'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K (2160p)']], recording)}
      <label>FPS <select data-s="fps" ${recording ? 'disabled' : ''}>${[[60, '60'], [30, '30']].map(([v, n]) => `<option value="${v}" ${(rs.fps || 60) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <p class="note">Records what you see, in real time, with the game's sound (the Settings tab's mixer).</p>`;
    const render = this.canRender ? `
      ${sel('renderSize', 'Size', [['1080', '1080p'], ['1440', '1440p'], ['2160', '4K (2160p)']], recording)}
      ${sel('renderFps', 'FPS', [[60, '60'], [30, '30']], recording)}
      ${sel('renderFormat', 'Format', [['mp4', 'MP4'], ['webm', 'WebM (VP9)']], recording)}
      ${quality}
      ${sel('duration', 'Length', DURATIONS.map(d => [d, d === 0 ? 'Until I press Stop' : d === -1 ? 'Custom' : `${d} s`]), recording)}
      ${s.duration === -1 ? `<label>Seconds <input type="number" min="1" max="3600" value="${s.customS}" data-c="customS" ${recording ? 'disabled' : ''}></label>` : ''}
      <p class="note">${z.tag} ${s.renderFps} FPS, about ${mb(est)}${s.duration === 0 ? ' a minute' : ''}. Frame by frame: perfectly smooth however slow the PC; the screen updates slowly meanwhile.
        No sound in this mode: add it in your video editor, or use Live recording for sound.</p>`
      : '<p class="note warn">High-Quality Render needs WebCodecs (Chrome or Edge). Live recording works here.</p>';
    const r = this.render;
    const fs = window as FsWindow;
    this.el.innerHTML = `
      <details open><summary>Shape</summary>
        ${sel('shape', 'Picture', [['auto', `Auto: as the Film frame guide (now ${this.shape()})`], ['16:9', '16:9 (landscape)'], ['9:16', '9:16 (vertical: Shorts, Reels)'], ['1:1', '1:1 (square)']], recording)}
        <p class="note">Video and screenshots come out in this shape: 9:16 at 1080p is 1080 × 1920, at 4K 2160 × 3840.</p></details>
      <details open><summary>Video</summary>
        <div class="rec-modes"><button data-ca="mode:live" class="${s.mode === 'live' ? 'on' : ''}" ${recording ? 'disabled' : ''}>Live</button><button data-ca="mode:render" class="${s.mode === 'render' ? 'on' : ''}" ${recording ? 'disabled' : ''}>High-Quality</button></div>
        ${s.mode === 'live' ? live : render}
        ${tog('countdown', '3-2-1 countdown')}
        <div class="buttons left"><button data-ca="rec" class="rec-btn ${recording ? 'on' : ''}">${icon(recording ? 'stop' : 'record')} ${recording ? 'Stop' : s.mode === 'render' ? 'Render' : 'Record'} (F9)</button>
          ${r ? '<button data-ca="cancel">Cancel</button>' : ''}</div>
        ${r && r.total !== Infinity ? '<progress max="1" value="0"></progress>' : ''}</details>
      <details open><summary>Screenshot</summary>
        ${sel('shotSize', 'Size', [['screen', 'The screen\'s height'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K (2160p)'], ['4320', '8K (4320p)']])}
        ${sel('shotFormat', 'Format', [['png', 'PNG (best)'], ['jpeg', 'JPEG (smaller)']])}
        ${s.shotFormat === 'jpeg' ? `<label>JPEG quality <input type="range" min="0.5" max="1" step="0.01" value="${s.jpegQ}" data-c="jpegQ"><output>${Math.round(s.jpegQ * 100)}%</output></label>` : ''}
        ${tog('burst', 'Burst (5 shots, 0.2 s apart)')}
        <p class="note">Only the picture (no menus), with the film settings. Freeze first (Space) for a perfect still. A transparent sky is not available.</p>
        <div class="buttons left"><button data-ca="shot">${icon('camera')} Screenshot (F10)</button></div></details>
      <details open><summary>Saving</summary>
        <p class="note">${this.dir ? `Saving to the folder <b>${esc(this.dir.name)}</b> (this session).` : fs.showSaveFilePicker ? 'Videos: you pick the file when recording starts (written to disk as it records). Screenshots: downloaded.' : 'Downloaded when done (videos kept in memory: up to 2 GB).'}</p>
        <div class="buttons left">${fs.showDirectoryPicker ? `<button data-ca="folder">${icon('folder')} ${this.dir ? 'Change folder…' : 'Choose folder…'}</button>` : ''}${this.dir ? '<button data-ca="nofolder">Stop using it</button>' : ''}</div></details>
      <details open><summary>Last captures</summary>
        ${this.list.length ? `<ul class="rec-caps">${this.list.map((c, i) => `<li><span title="${esc(c.name)}">${esc(c.name)}</span><small>${mb(c.bytes)}</small><button data-ca="show:${i}">Show</button><button data-ca="drop:${i}">Delete from list</button></li>`).join('')}</ul>` : '<p class="note">Nothing yet.</p>'}</details>`;
  }

  bind() {
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button');
      const a = b?.dataset.ca;
      if (!a) return;
      b!.blur();
      if (a.startsWith('mode:')) { this.s.mode = a.slice(5) as 'live'; this.render_(); }
      if (a === 'rec') void this.toggle();
      if (a === 'cancel') void this.cancelRender();
      if (a === 'shot') void this.screenshot();
      if (a === 'folder') void this.chooseFolder();
      if (a === 'nofolder') { this.dir = null; this.render_(); }
      if (a.startsWith('show:')) {
        const c = this.list[Number(a.slice(5))];
        if (c) { c.url ??= URL.createObjectURL(c.file); open(c.url, '_blank'); }
      }
      if (a.startsWith('drop:')) { const [c] = this.list.splice(Number(a.slice(5)), 1); if (c?.url) URL.revokeObjectURL(c.url); this.render_(); }
    });
    const set = (t: HTMLInputElement, done: boolean) => {
      if (t.dataset.s) {
        // the live recording's size and frame rate are Record Mode's output settings
        (this.settings.s as Record<string, unknown>)[t.dataset.s] = t.dataset.s === 'fps' ? Number(t.value) : t.value;
        this.settings.apply(); this.settings.render();
        return;
      }
      const k = t.dataset.c as keyof CaptureSettings | undefined;
      if (!k) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' || t.type === 'number' || ['renderFps', 'duration'].includes(k) ? Number(t.value) : t.value;
      (this.s as Record<string, unknown>)[k] = v;
      if (t.type === 'range') { const o = t.nextElementSibling as HTMLOutputElement | null; if (o) o.textContent = `${Math.round(Number(v) * 100)}%`; }
      if (done && t.type !== 'range') this.render_();
    };
    this.el.addEventListener('input', e => set(e.target as HTMLInputElement, false));
    this.el.addEventListener('change', e => set(e.target as HTMLInputElement, true));
  }
}
