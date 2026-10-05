import * as THREE from 'three/webgpu';
import { hash2 } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import { lookAtQuat, type CameraContext, type CameraMode, type Pose } from '../CameraManager';

interface Poi { km: number; kind: string }

/** 6: Auto-placed trackside cameras at bridges, curves, stations and crossings; cuts as the train passes. */
export class CinematicCamera implements CameraMode {
  readonly name = 'Cinematic';
  readonly near = 0.3;
  private pois: Poi[] | null = null;
  private current: Poi | null = null;
  private spot = new THREE.Vector3();
  private target = new THREE.Vector3();
  private f = newFrame();

  private build(ctx: CameraContext) {
    const r = ctx.route, p: Poi[] = [];
    for (const b of r.bridges) p.push({ km: (b.fromKm + b.toKm) / 2, kind: 'bridge' });
    for (const t of r.tunnels) p.push({ km: t.fromKm - 0.12, kind: 'tunnel' });
    for (const s of r.stations) p.push({ km: s.km, kind: 'station' });
    for (const l of r.data.levelCrossings) p.push({ km: l.km, kind: 'lc' });
    for (let km = 0.5; km < r.lengthKm; km += 0.25) if (r.alignment.radiusAt(km) < 800) { p.push({ km, kind: 'curve' }); km += 1; }
    for (let km = 1; km < r.lengthKm; km += 2.2) p.push({ km, kind: 'line' });
    this.pois = p.sort((a, b) => a.km - b.km);
  }

  private pick(ctx: CameraContext) {
    if (!this.pois) this.build(ctx);
    const dir = ctx.speed >= 0 ? 1 : -1;
    const cands = this.pois!.filter(p => (p.km - ctx.headKm) * dir > 0.18 && (p.km - ctx.headKm) * dir < 3);
    this.current = cands.sort((a, b) => Math.abs(a.km - ctx.headKm) - Math.abs(b.km - ctx.headKm))[0] ?? { km: ctx.headKm + dir * 0.35, kind: 'line' };
    const h = hash2(Math.round(this.current.km * 100), 3);
    const side = h < 0.5 ? -1 : 1;
    const kind = this.current.kind;
    const lat = kind === 'bridge' ? side * 70 : kind === 'station' ? side * 22 : side * (14 + h * 18);
    ctx.route.alignment.sampleOffset(this.current.km * 1000 + (kind === 'bridge' ? 0 : 30), lat, this.f);
    const g = ctx.field.height(this.f.x, this.f.z);
    const up = kind === 'bridge' ? 4 : 1.6 + h * 6;
    this.spot.set(this.f.x, Math.max(g, kind === 'bridge' ? g : this.f.y) + up, this.f.z);
  }

  enter(ctx: CameraContext, _f: Pose) { this.pick(ctx); }

  update(ctx: CameraContext, out: Pose) {
    this.target.set(0, 2.5, 0).applyMatrix4(ctx.train.vehicleMatrices[0]);
    const c = this.current;
    const passed = c && ((ctx.speed >= 0 && ctx.headKm > c.km + 0.25) || (ctx.speed < 0 && ctx.headKm < c.km - 0.25));
    if (!c || passed || this.spot.distanceTo(this.target) > 1500) this.pick(ctx);
    out.pos.copy(this.spot);
    lookAtQuat(out.pos, this.target, out.quat);
    const d = this.spot.distanceTo(this.target);
    out.fov = Math.max(14, Math.min(60, 2400 / Math.max(10, d)));
  }
}
