/** Noise buffers and a synthetic reverb impulse response. */
export function makeNoise(ctx: BaseAudioContext, kind: 'white' | 'brown', seconds = 3) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
  }
  return b;
}

export function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // early reflections + diffuse tail
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 400 ? 0.2 : 1);
      if (i % 4410 === 0 && i < ctx.sampleRate * 0.6) d[i] += 0.6 * (1 - t);
    }
  }
  return b;
}
