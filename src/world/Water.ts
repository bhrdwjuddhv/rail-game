import * as THREE from 'three/webgpu';
import { tex } from '../core/Textures';
import { newFrame } from '../track/Chainage';
import type { Route } from '../track/Route';
import { waterMaterial } from './ChunkManager';
import type { TerrainField } from './TerrainField';

/** River surfaces: one flat ribbon per river at its water level. */
export function buildRivers(route: Route): THREE.Group {
  const g = new THREE.Group();
  for (const r of route.rivers) {
    const P = r.points;
    const pos: number[] = [], idx: number[] = [];
    const ox = P[0].x, oz = P[0].z;
    const half = r.width / 2 + 20;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      pos.push(P[i].x + nx * half - ox, r.water, P[i].z + nz * half - oz, P[i].x - nx * half - ox, r.water, P[i].z - nz * half - oz);
      if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // force normals up regardless of winding
    const n = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, waterMaterial);
    m.material.side = THREE.DoubleSide;
    m.position.set(ox, 0, oz);
    m.receiveShadow = true;
    m.name = r.id;
    g.add(m);
  }
  return g;
}

/** Monsoon waterfalls on the hillside, animated by scrolling their texture. */
export class Waterfalls {
  readonly group = new THREE.Group();
  readonly positions: THREE.Vector3[] = [];
  private tex: THREE.Texture;

  constructor(route: Route, field: TerrainField) {
    this.tex = tex.waterfall().clone();
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: this.tex, transparent: true, opacity: 0.85, roughness: 0.3, side: THREE.DoubleSide, depthWrite: false, emissive: 0x99aab0, emissiveIntensity: 0.15 });
    const f = newFrame();
    for (const feat of route.data.features) {
      if (feat.type !== 'waterfall') continue;
      // pick the uphill side
      let side = 1;
      route.alignment.sampleOffset(feat.km * 1000, 160, f);
      const up = field.height(f.x, f.z);
      route.alignment.sampleOffset(feat.km * 1000, -160, f);
      if (field.height(f.x, f.z) > up) side = -1;
      route.alignment.sampleOffset(feat.km * 1000, side * 150, f);
      const topY = field.height(f.x, f.z);
      route.alignment.sampleOffset(feat.km * 1000, side * 60, f);
      const botY = field.height(f.x, f.z);
      const h = Math.max(12, topY - botY);
      const geo = new THREE.PlaneGeometry(9, h, 1, 8);
      const plane = new THREE.Mesh(geo, mat);
      route.alignment.sampleOffset(feat.km * 1000, side * 95, f);
      plane.position.set(f.x, botY + h / 2 + 1, f.z);
      plane.rotation.y = -f.heading + (side > 0 ? 0 : Math.PI);
      this.tex.repeat.set(1, h / 30);
      this.group.add(plane);
      const foam = new THREE.Mesh(new THREE.CircleGeometry(7, 16).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8f0f2, transparent: true, opacity: 0.7, roughness: 0.5 }));
      foam.position.set(f.x, botY + 0.6, f.z);
      this.group.add(foam);
      this.positions.push(new THREE.Vector3(f.x, botY, f.z));
    }
  }

  update(dt: number, visible: boolean) {
    this.group.visible = visible;
    this.tex.offset.y += dt * 1.6;
  }
}
