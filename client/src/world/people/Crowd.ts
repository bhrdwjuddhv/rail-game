import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../../core/GeoBatch';
import { materials } from '../../core/Materials';
import { rng } from '@rail/shared/util';

let personGeo: THREE.BufferGeometry | null = null;
function person() {
  if (personGeo) return personGeo;
  const b = new GeoBatch();
  b.cyl(0.17, 0.2, 0.8, 7, mat(0, 0.45, 0), '#3b3f4a');      // legs / lower garment
  b.cyl(0.2, 0.18, 0.65, 7, mat(0, 1.15, 0), '#ffffff');      // torso (instance colour)
  b.add(new THREE.SphereGeometry(0.12, 8, 6), mat(0, 1.6, 0), '#8a5a3c'); // head
  b.add(new THREE.SphereGeometry(0.125, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), mat(0, 1.64, 0), '#1b1714'); // hair
  personGeo = b.geometry('std')!;
  return personGeo;
}

const CLOTHES = [0xd35400, 0xc0392b, 0x2980b9, 0x27ae60, 0xf1c40f, 0x8e44ad, 0xecf0f1, 0x16a085, 0xe84393, 0xfdcb6e, 0x6c5ce7, 0xffffff];

/** Simple animated platform crowd: idle sway plus a few people pacing. */
export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  private base: { x: number; y: number; z: number; ry: number; walk: number; phase: number; range: number; dx: number; dz: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(spots: { x: number; y: number; z: number; heading: number }[], seed: number) {
    const r = rng(seed);
    this.mesh = new THREE.InstancedMesh(person(), materials().std, spots.length);
    const c = new THREE.Color();
    spots.forEach((sp, i) => {
      const walk = r() < 0.2 ? 1 : 0;
      this.base.push({ x: sp.x, y: sp.y, z: sp.z, ry: r() * 6.28, walk, phase: r() * 10, range: 6 + r() * 14, dx: Math.cos(sp.heading), dz: Math.sin(sp.heading) });
      this.mesh.setColorAt(i, c.setHex(CLOTHES[Math.floor(r() * CLOTHES.length)]));
    });
    this.mesh.castShadow = true;
    this.update(0);
    this.mesh.computeBoundingSphere();
  }

  update(t: number) {
    for (let i = 0; i < this.base.length; i++) {
      const b = this.base[i];
      let x = b.x, z = b.z, ry = b.ry, y = b.y;
      if (b.walk) {
        const a = (t * 1.2) / b.range + b.phase;
        const u = Math.sin(a) * b.range;
        x += b.dx * u; z += b.dz * u;
        const fwd = Math.cos(a) > 0 ? 1 : -1;
        ry = Math.atan2(-b.dz * fwd, b.dx * fwd);
        y += Math.abs(Math.sin(t * 7 + b.phase)) * 0.04;
      } else {
        ry += Math.sin(t * 0.3 + b.phase) * 0.4;
      }
      this.q.setFromAxisAngle(this.up, ry);
      this.p.set(x, y, z);
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
