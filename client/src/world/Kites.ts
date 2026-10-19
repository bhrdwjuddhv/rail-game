import * as THREE from 'three/webgpu';
import { hash2 } from '@rail/shared/util';
import { newFrame } from '@rail/shared/track/Chainage';
import type { Route } from '@rail/shared/track/Route';
import type { TerrainField } from './TerrainField';
import { textures } from '../core/TextureLibrary';
import { canvasTexture, uvToRect } from '../core/Textures';
import { KITE_SKIP, lifeCells } from './scenery/lifeKit';

/**
 * Festival mode by day: paper kites over the towns, each flown from a rooftop on a string, dipping and swaying
 * in the wind. Spots are seeded along each town (the same every run). The festival pack's kite pictures (never
 * the one in the flag's colours), one instanced draw per picture shown (a few), and one for the strings; plain
 * coloured diamonds if the pack is missing. Only near the camera.
 */
const MAX = 40, PICS = 6;
const COLOURS = [0xe74c3c, 0xf1c40f, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe67e22, 0xff6b9d];

export class Kites {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private strings: THREE.LineSegments;
  private spots: { x: number; y: number; z: number; ph: number; c: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(route: Route, field: TerrainField) {
    const pics = lifeCells('life/festival-pack', 'kites').filter((_, i) => !KITE_SKIP.has(i)).slice(0, PICS);
    if (pics.length) {
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
      textures.bind(mat as unknown as THREE.MeshStandardMaterial, 'festive-sprite', () => canvasTexture('plain-white', 4, 4, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }, { repeat: false }), 1, { resident: true });
      for (const c of pics) this.meshes.push(new THREE.InstancedMesh(uvToRect(new THREE.PlaneGeometry(1.0 * c.aspect, 1.0), { u0: c.uv[0], v0: c.uv[1], u1: c.uv[2], v1: c.uv[3] }), mat, MAX));
    } else {
      // a diamond with a tail, coloured per kite
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.6, 0, -0.45, 0, 0, 0, -0.75, 0, 0, 0.6, 0, 0, -0.75, 0, 0.45, 0, 0, 0, -0.75, 0, -0.06, -1.3, 0, 0.06, -1.3, 0], 3));
      g.computeVertexNormals();
      this.meshes.push(new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), MAX));
    }
    for (const k of this.meshes) { k.frustumCulled = false; k.count = 0; }
    this.strings = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MAX * 6), 3)), new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 }));
    this.strings.frustumCulled = false;
    this.group.add(...this.meshes, this.strings);
    this.group.visible = false;
    const f = newFrame();
    for (const z of route.data.scenery) {
      if (z.zone !== 'town' && z.zone !== 'south-town' && z.zone !== 'village') continue;
      for (let km = z.fromKm + 0.04; km < z.toKm; km += 0.07) {
        const h = hash2(Math.round(km * 1000), 13, 709), lat = (h < 0.5 ? -1 : 1) * (35 + hash2(Math.round(km * 1000), 14, 709) * 220);
        route.alignment.sampleOffset(km * 1000, lat, f);
        this.spots.push({ x: f.x, y: field.height(f.x, f.z) + 8, z: f.z, ph: h * 40, c: Math.floor(hash2(Math.round(km * 1000), 15, 709) * 997) });
      }
    }
  }

  update(t: number, cam: THREE.Vector3, on: boolean) {
    this.group.visible = on;
    if (!on) return;
    const near = this.spots.filter(p => Math.hypot(p.x - cam.x, p.z - cam.z) < 1100).slice(0, MAX);
    const pos = this.strings.geometry.attributes.position as THREE.BufferAttribute, col = new THREE.Color();
    for (const k of this.meshes) k.count = 0;
    near.forEach((p, i) => {
      // flown downwind from its roof, 40-60 m up, dipping and swinging
      const sway = Math.sin(t * 0.7 + p.ph), dip = Math.sin(t * 1.9 + p.ph * 1.7);
      this.v.set(p.x + 22 + sway * 6, p.y + 45 + dip * 4 + (p.ph % 10), p.z + 14 + Math.cos(t * 0.5 + p.ph) * 5);
      this.e.set(0.3 * dip, Math.PI / 4 + sway * 0.4, 0.5 * sway);
      this.q.setFromEuler(this.e);
      this.s.setScalar(1.2);
      const mesh = this.meshes[p.c % this.meshes.length], n = mesh.count++;
      mesh.setMatrixAt(n, this.m.compose(this.v, this.q, this.s));
      if (this.meshes.length === 1) mesh.setColorAt(n, col.setHex(COLOURS[p.c % COLOURS.length]));
      pos.setXYZ(i * 2, p.x, p.y, p.z);
      pos.setXYZ(i * 2 + 1, this.v.x, this.v.y - 0.6, this.v.z);
    });
    for (const k of this.meshes) { k.instanceMatrix.needsUpdate = true; if (k.instanceColor) k.instanceColor.needsUpdate = true; }
    this.strings.geometry.setDrawRange(0, near.length * 2);
    pos.needsUpdate = true;
  }
}
