import * as THREE from 'three/webgpu';
import { canvasTexture } from '../core/Textures';

const PUFFS = 28;

const puffTexture = () => canvasTexture('smoke-puff', 64, 64, (g, w, h) => {
  const r = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
  r.addColorStop(0, 'rgba(255,255,255,0.9)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.clearRect(0, 0, w, h);
  g.fillStyle = r; g.fillRect(0, 0, w, h);
}, { repeat: false });

interface Puff { sprite: THREE.Sprite; life: number; max: number; vel: THREE.Vector3; grow: number; alpha: number }

/**
 * Diesel exhaust: a small pool of sprite puffs (no allocation while running).
 * `emit` is called every frame with the stack position and how hard the engine
 * is working; dark dense puffs on starting and when notching up, light thin
 * ones at steady power. Puffs rise, grow, drift with the wind and fade.
 */
export class DieselSmoke {
  readonly group = new THREE.Group();
  private puffs: Puff[] = [];
  private next = 0;
  private acc = 0;

  constructor() {
    const tex = puffTexture();
    for (let i = 0; i < PUFFS; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0x777777, fog: true });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.renderOrder = 5;
      this.group.add(s);
      this.puffs.push({ sprite: s, life: 0, max: 1, vel: new THREE.Vector3(), grow: 1, alpha: 0 });
    }
  }

  /**
   * pos: stack top (in the group's parent space); rate: puffs per second;
   * dark 0..1 (0 = light grey haze, 1 = black); wind: drift (m/s).
   */
  update(dt: number, pos: THREE.Vector3 | null, rate: number, dark: number, wind: THREE.Vector3) {
    if (pos && rate > 0) {
      this.acc += dt * rate;
      while (this.acc >= 1) {
        this.acc -= 1;
        const p = this.puffs[this.next];
        this.next = (this.next + 1) % PUFFS;
        p.life = 0; p.max = 2.2 + dark * 1.6;
        p.vel.set((Math.random() - 0.5) * 0.4, 2.2 + dark * 1.8, (Math.random() - 0.5) * 0.4);
        p.grow = 0.9 + dark * 0.8;
        p.alpha = 0.32 + dark * 0.5;
        const c = 0.62 - dark * 0.5;
        (p.sprite.material as THREE.SpriteMaterial).color.setRGB(c, c, c * 1.02);
        p.sprite.position.copy(pos);
        p.sprite.scale.setScalar(0.5);
        p.sprite.visible = true;
      }
    }
    for (const p of this.puffs) {
      if (!p.sprite.visible) continue;
      p.life += dt;
      const k = p.life / p.max;
      if (k >= 1) { p.sprite.visible = false; continue; }
      p.vel.y *= 1 - dt * 0.6;
      p.sprite.position.addScaledVector(p.vel, dt).addScaledVector(wind, dt);
      p.sprite.scale.setScalar(0.5 + k * 3.2 * p.grow);
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.alpha * (1 - k) * Math.min(1, k * 6);
    }
  }
}
