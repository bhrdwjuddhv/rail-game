/**
 * Record Mode's video recorders. Loaded only when a recording starts.
 *
 *  - LiveRecorder: the canvas as it is drawn, in real time, with the game's sound (MediaRecorder).
 *  - RenderRecorder: frame by frame at a fixed time step, encoded with WebCodecs and muxed to MP4 / WebM
 *    (smooth at any size, however slowly the frames are drawn; no sound).
 *
 * Both write through a Sink: straight to a file on disk (File System Access API) when the browser has it,
 * else into memory and downloaded at the end (stopped at MEMORY_LIMIT).
 */

/** recordings kept in memory stop here (a browser tab cannot hold much more) */
export const MEMORY_LIMIT = 2 * 1024 ** 3;

/** Where the bytes go. `position`: for a muxer that goes back to patch its header (MP4). */
export interface Sink {
  readonly bytes: number;
  write(data: Blob | Uint8Array, position?: number): Promise<void>;
  /** the finished file (a Blob in memory, or the File on disk) */
  close(type: string): Promise<Blob | File>;
  abort(): Promise<void>;
  readonly onDisk: boolean;
}

/** A sink writing straight into a file on disk (nothing held in memory). */
export async function fileSink(handle: FileSystemFileHandle): Promise<Sink> {
  const w = await handle.createWritable();
  let bytes = 0, end = 0, chain = Promise.resolve();
  return {
    onDisk: true,
    get bytes() { return bytes; },
    write(data, position) {
      const size = data instanceof Blob ? data.size : data.byteLength;
      const at = position ?? end;
      end = Math.max(end, at + size);
      bytes = end;
      // (writes kept in order: the muxer patches earlier bytes later; a copy: the muxer reuses its buffers)
      const copy = data instanceof Blob ? data : data.slice();
      chain = chain.then(() => w.write({ type: 'write', position: at, data: copy as BlobPart }));
      return chain;
    },
    async close() { await chain; await w.close(); return handle.getFile(); },
    async abort() { try { await w.abort(); } catch { /* already closed */ } },
  };
}

/** A sink holding the file in memory (positions honoured: an MP4 header patched at the end). */
export function memorySink(): Sink {
  const parts: { at: number; data: Blob | Uint8Array }[] = [];
  let end = 0;
  return {
    onDisk: false,
    get bytes() { return end; },
    async write(data, position) {
      const size = data instanceof Blob ? data.size : data.byteLength;
      const at = position ?? end;
      // (copied: the muxer reuses its buffers)
      parts.push({ at, data: data instanceof Blob ? data : data.slice() });
      end = Math.max(end, at + size);
    },
    async close(type) {
      // appended chunks only: one Blob as they came; patched ones: laid out by position
      if (parts.every((p, i) => i === 0 ? p.at === 0 : p.at >= parts[i - 1].at)) {
        let pos = 0;
        if (parts.every(p => { const ok = p.at === pos; pos += p.data instanceof Blob ? p.data.size : p.data.byteLength; return ok; })) return new Blob(parts.map(p => p.data as BlobPart), { type });
      }
      const out = new Uint8Array(end);
      for (const p of parts) out.set(p.data instanceof Blob ? new Uint8Array(await p.data.arrayBuffer()) : p.data, p.at);
      return new Blob([out], { type });
    },
    async abort() { parts.length = 0; },
  };
}

/** bits per pixel per frame for the quality presets (Standard / High / Very high) */
export const BPP = { standard: 0.07, high: 0.12, max: 0.2 } as const;
export type Quality = keyof typeof BPP;

// ---------------------------------------------------------------- live recording
/** The best format MediaRecorder offers here: MP4 (H.264 / AAC) first, else WebM (VP9 / Opus). */
export function liveFormat(want: 'mp4' | 'webm' | 'auto') {
  const mp4 = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const order = want === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
  const type = typeof MediaRecorder === 'undefined' ? undefined : order.find(t => MediaRecorder.isTypeSupported(t));
  return type ? { type, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' } : null;
}

export class LiveRecorder {
  private rec: MediaRecorder;
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private done: Promise<void>;
  private failed: unknown = null;
  /** recording time (s), paused time left out */
  seconds = 0;

  constructor(canvas: HTMLCanvasElement, fps: number, private sink: Sink, mime: string, bitsPerSecond: number, audio: { ctx: AudioContext; out: AudioNode } | null, onFull: () => void) {
    const stream = canvas.captureStream(fps);
    if (audio) {
      // the game's final mix, as heard
      this.audioDest = audio.ctx.createMediaStreamDestination();
      audio.out.connect(this.audioDest);
      for (const t of this.audioDest.stream.getAudioTracks()) stream.addTrack(t);
    }
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond, audioBitsPerSecond: 192_000 });
    let writes = Promise.resolve();
    this.rec.ondataavailable = e => {
      if (!e.data.size) return;
      writes = writes.then(() => sink.write(e.data)).catch(err => { this.failed = err; });
      if (!sink.onDisk && sink.bytes > MEMORY_LIMIT) onFull();
    };
    this.done = new Promise(res => { this.rec.onstop = () => { void writes.then(() => res()); }; });
    this.rec.start(1000);
  }

  get bytes() { return this.sink.bytes; }
  get paused() { return this.rec.state === 'paused'; }
  pause(on: boolean) {
    if (on && this.rec.state === 'recording') this.rec.pause();
    if (!on && this.rec.state === 'paused') this.rec.resume();
  }
  tick(dt: number) { if (this.rec.state === 'recording') this.seconds += dt; }

  async stop(type: string) {
    if (this.rec.state !== 'inactive') this.rec.stop();
    await this.done;
    this.release();
    if (this.failed) throw this.failed;
    return this.sink.close(type);
  }

  async cancel() { if (this.rec.state !== 'inactive') this.rec.stop(); await this.done; this.release(); await this.sink.abort(); }

  private release() {
    for (const t of this.rec.stream.getTracks()) t.stop();
    this.audioDest?.disconnect();
  }
}

// ---------------------------------------------------------------- frame-by-frame render
export interface RenderCodec { codec: string; muxer: 'avc' | 'vp9' | 'av1'; name: string }

/** The encoders this browser has for the size: H.264 first (plays everywhere), then VP9, AV1. */
export async function renderCodecs(w: number, h: number, fps: number, bitrate: number): Promise<RenderCodec[]> {
  if (typeof VideoEncoder === 'undefined') return [];
  const list: RenderCodec[] = [
    { codec: 'avc1.640034', muxer: 'avc', name: 'H.264' }, { codec: 'avc1.640033', muxer: 'avc', name: 'H.264' },
    { codec: 'vp09.00.51.08', muxer: 'vp9', name: 'VP9' }, { codec: 'av01.0.12M.08', muxer: 'av1', name: 'AV1' },
  ];
  const ok: RenderCodec[] = [];
  for (const c of list) {
    if (ok.some(o => o.muxer === c.muxer)) continue;
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width: w, height: h, bitrate, framerate: fps });
      if (r.supported) ok.push(c);
    } catch { /* not this one */ }
  }
  return ok;
}

export class RenderRecorder {
  private enc: VideoEncoder;
  private mux: { addVideoChunk(c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata): void; finalize(): void };
  private error: unknown = null;
  /** frames encoded so far */
  frames = 0;

  private constructor(enc: VideoEncoder, mux: RenderRecorder['mux'], private sink: Sink, private fps: number) {
    this.enc = enc; this.mux = mux;
  }

  /** An encoder and muxer for `w` x `h` at `fps` (MP4 for H.264 / VP9 / AV1; WebM for VP9 when asked). */
  static async create(c: RenderCodec, container: 'mp4' | 'webm', w: number, h: number, fps: number, bitrate: number, sink: Sink) {
    let mux: RenderRecorder['mux'];
    const onData = (data: Uint8Array, position?: number) => { void sink.write(data, position); };
    if (container === 'webm') {
      const { Muxer, StreamTarget } = await import('webm-muxer');
      mux = new Muxer({ target: new StreamTarget({ onData, chunked: true }), video: { codec: c.muxer === 'av1' ? 'V_AV1' : 'V_VP9', width: w, height: h, frameRate: fps }, firstTimestampBehavior: 'offset' });
    } else {
      const { Muxer, StreamTarget } = await import('mp4-muxer');
      // (on disk the header is patched in place at the end; in memory too, positions honoured by the sink)
      mux = new Muxer({ target: new StreamTarget({ onData, chunked: true }), video: { codec: c.muxer, width: w, height: h, frameRate: fps }, fastStart: false, firstTimestampBehavior: 'offset' });
    }
    let rec: RenderRecorder | null = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => mux.addVideoChunk(chunk, meta),
      error: e => { if (rec) rec.error = e; },
    });
    enc.configure({ codec: c.codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' });
    rec = new RenderRecorder(enc, mux, sink, fps);
    return rec;
  }

  get bytes() { return this.sink.bytes; }
  get failed() { return this.error; }
  /** the encoder has room for another frame (the game waits for it otherwise) */
  ready() { return this.enc.encodeQueueSize < 3; }

  /** The frame just drawn on the canvas (call right after the render). */
  add(canvas: HTMLCanvasElement) {
    const us = 1e6 / this.fps;
    const f = new VideoFrame(canvas, { timestamp: Math.round(this.frames * us), duration: Math.round(us) });
    this.enc.encode(f, { keyFrame: this.frames % (this.fps * 2) === 0 });
    f.close();
    this.frames++;
  }

  async finish(type: string) {
    await this.enc.flush();
    this.enc.close();
    this.mux.finalize();
    if (this.error) throw this.error;
    return this.sink.close(type);
  }

  async cancel() { try { this.enc.close(); } catch { /* closed */ } await this.sink.abort(); }
}
