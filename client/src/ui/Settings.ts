import { ACTIONS, Action, applyPreset, DEFAULT_KEYS, PRESETS, Quality, settings } from '../core/Settings';

/** Settings panel: graphics, audio, controls (rebinding), units, clock speed. */
export function settingsPanel(onClose: () => void, captureKey: (cb: (code: string) => void) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'menu settings';
  const render = () => {
    const s = settings.get();
    const v = s.volumes;
    el.innerHTML = `
      <h2>Settings</h2>
      <div class="cols">
      <section><h3>Graphics</h3>
        <label>Preset <select data-s="quality">${(Object.keys(PRESETS) as Quality[]).map(q => `<option ${q === s.quality ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
        <label>Render scale <input type="range" min="0.5" max="1.25" step="0.05" value="${s.renderScale}" data-s="renderScale"><output>${s.renderScale}</output></label>
        <label>Shadows <select data-s="shadows">${['off', 'low', 'high'].map(o => `<option ${o === s.shadows ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <label>Draw distance <input type="range" min="1200" max="5000" step="100" value="${s.drawDistance}" data-s="drawDistance"><output>${s.drawDistance} m</output></label>
        <label>Fog density <input type="range" min="0.3" max="2" step="0.1" value="${s.fogMultiplier}" data-s="fogMultiplier"><output>${s.fogMultiplier}x</output></label>
        <label>Bloom <input type="checkbox" ${s.bloom ? 'checked' : ''} data-s="bloom"></label>
        <p class="note">Antialiasing and quality preset changes to terrain detail apply fully after restarting the run.</p>
      </section>
      <section><h3>Audio</h3>
        ${(['master', 'train', 'horn', 'env', 'ui'] as const).map(k => `<label>${k === 'env' ? 'Environment' : k === 'ui' ? 'Cab / UI' : k[0].toUpperCase() + k.slice(1)} <input type="range" min="0" max="1" step="0.05" value="${v[k]}" data-v="${k}"><output>${Math.round(v[k] * 100)}%</output></label>`).join('')}
        <h3>General</h3>
        <label>Units <select data-s="units"><option value="kmh" ${s.units === 'kmh' ? 'selected' : ''}>km/h</option><option value="mph" ${s.units === 'mph' ? 'selected' : ''}>mph</option></select></label>
        <label>Free-roam clock speed <input type="range" min="1" max="120" step="1" value="${s.dayNightSpeed}" data-s="dayNightSpeed"><output>${s.dayNightSpeed}x</output></label>
        <label>Mouse sensitivity <input type="range" min="0.3" max="3" step="0.1" value="${s.mouseSensitivity}" data-s="mouseSensitivity"><output>${s.mouseSensitivity}</output></label>
      </section>
      <section class="keys"><h3>Controls <button data-a="resetKeys">Reset</button></h3>
        ${(Object.keys(ACTIONS) as Action[]).map(a => `<div class="key"><span>${ACTIONS[a]}</span><button data-key="${a}">${pretty(s.keys[a])}</button></div>`).join('')}
        <p class="note">Cameras: 1-7. Mouse: drag to look, click cab controls (right-click = decrease), wheel to zoom/adjust.</p>
      </section>
      </div>
      <div class="buttons"><button data-a="close">Done</button></div>`;
  };
  render();
  el.addEventListener('input', e => {
    const t = e.target as HTMLInputElement;
    const out = t.nextElementSibling as HTMLOutputElement | null;
    if (t.dataset.v) {
      const vol = { ...settings.get().volumes, [t.dataset.v]: Number(t.value) };
      settings.set({ volumes: vol });
      if (out) out.textContent = `${Math.round(Number(t.value) * 100)}%`;
    } else if (t.dataset.s && t.type === 'range') {
      settings.set({ [t.dataset.s]: Number(t.value) } as any);
      if (out) out.textContent = t.value;
    }
  });
  el.addEventListener('change', e => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = (t as HTMLElement).dataset.s;
    if (!k) return;
    if (k === 'quality') { applyPreset(t.value as Quality); render(); return; }
    if ((t as HTMLInputElement).type === 'checkbox') settings.set({ [k]: (t as HTMLInputElement).checked } as any);
    else if (t.tagName === 'SELECT') settings.set({ [k]: t.value } as any);
  });
  el.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.a === 'close') onClose();
    if (b.dataset.a === 'resetKeys') { settings.set({ keys: { ...DEFAULT_KEYS } }); render(); }
    const a = b.dataset.key as Action | undefined;
    if (a) {
      b.textContent = 'press a key...';
      captureKey(code => {
        if (code !== 'Escape') settings.set({ keys: { ...settings.get().keys, [a]: code } });
        render();
      });
    }
  });
  return el;
}

const pretty = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '').replace('Semicolon', ';').replace('Quote', "'").replace('BracketLeft', '[').replace('BracketRight', ']').replace('Comma', ',').replace('Period', '.');
