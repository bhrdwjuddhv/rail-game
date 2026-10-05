import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { canvasTexture, labelTexture } from '../core/Textures';
import { labelMaterial, materials } from '../core/Materials';
import { approach } from '@rail/shared/util';
import { newFrame, RAIL_TOP } from '@rail/shared/track/Chainage';
import type { RoadDef, Route } from '@rail/shared/track/Route';
import type { TerrainField } from '../world/TerrainField';

const roadMat = new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.95 });
function stripes() {
  return canvasTexture('barrier', 128, 16, (g, w, h) => {
    for (let x = 0; x < w; x += 32) { g.fillStyle = '#d61f1f'; g.fillRect(x, 0, 16, h); g.fillStyle = '#f7f7f7'; g.fillRect(x + 16, 0, 16, h); }
  });
}

/** Road ribbon along an LC road, following the shared road profile. */
export function buildLcRoad(field: TerrainField, r: RoadDef): THREE.Mesh {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const half = 3.6;
  let n = 0;
  for (let t = -r.halfLength; t <= r.halfLength; t += 8) {
    const y = field.lcRoadElevation(r, t) + 0.04;
    for (const s of [-1, 1]) {
      pos.push(r.dx * t + -r.dz * s * half, y, r.dz * t + r.dx * s * half);
      uv.push(s * 0.5, t / 8);
    }
    if (n > 0) { const a = (n - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    n++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, roadMat);
  m.position.set(r.ax, 0, r.az);
  m.receiveShadow = true;
  return m;
}

/** Town/colony road running parallel to the track. */
export function buildParallelRoad(route: Route, r: RoadDef): THREE.Mesh {
  const f = newFrame();
  const pos: number[] = [], idx: number[] = [];
  route.alignment.sample(r.fromKm! * 1000, f);
  const ox = f.x, oz = f.z;
  let n = 0;
  for (let s = r.fromKm! * 1000; s <= r.toKm! * 1000; s += 10) {
    for (const d of [-3.5, 3.5]) {
      route.alignment.sampleOffset(s, r.offset! + d, f);
      pos.push(f.x - ox, f.y - 0.12 + 0.05, f.z - oz);
    }
    if (n > 0) { const a = (n - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    n++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, roadMat);
  m.position.set(ox, 0, oz);
  m.receiveShadow = true;
  return m;
}

/**
 * Level crossing: lifting barriers on both road approaches (manned) or warning
 * signs only (unmanned), gate lodge, crossing deck. Barriers close when a
 * train is within ~1.6 km and reopen once it has cleared.
 */
export class LevelCrossingView {
  readonly group = new THREE.Group();
  private arms: THREE.Object3D[] = [];
  /** 0 = open (raised), 1 = closed */
  closed = 0;
  closing = false;
  readonly position = new THREE.Vector3();
  readonly gateT: number;

  constructor(route: Route, field: TerrainField, readonly road: RoadDef, readonly manned: boolean) {
    const f = newFrame();
    route.alignment.sample(road.km * 1000, f);
    this.position.set(f.x, f.y + RAIL_TOP, f.z);
    this.group.position.copy(this.position);
    const ry = Math.atan2(-road.dz, road.dx); // local +X along the road
    this.group.rotation.y = ry;
    const b = new GeoBatch();
    this.gateT = route.formationHalfWidth(road.km) + 3.5;
    // crossing deck between and beside the rails
    b.box(7.2, 0.08, 3.6, mat(0, -0.05, 0), '#5d5852', 'concrete');
    // gate lodge
    const lodgeY = field.lcRoadElevation(road, 14) - this.position.y;
    b.box(3, 2.8, 3, mat(14, lodgeY + 1.4, -7.5), '#e7dcc2', 'brick');
    b.box(3.6, 0.2, 3.6, mat(14, lodgeY + 2.9, -7.5), '#7d3b2c');
    if (manned) {
      for (const side of [-1, 1]) {
        const t = side * this.gateT;
        const y = field.lcRoadElevation(road, t) - this.position.y;
        b.box(0.35, 1.3, 0.35, mat(t, y + 0.65, -4.2 * side), '#e9e9e9', 'concrete');
        b.box(0.3, 1.0, 0.3, mat(t, y + 0.5, 4.2 * side), '#e9e9e9', 'concrete'); // rest post
        const pivot = new THREE.Object3D();
        pivot.position.set(t, y + 1.2, -4.2 * side);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 8.4), new THREE.MeshStandardMaterial({ map: stripes(), roughness: 0.6 }));
        arm.position.z = 4.2 * side;
        arm.castShadow = true;
        pivot.add(arm);
        // red lamp at the tip
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), materials().lamp);
        lamp.position.z = 8.2 * side;
        pivot.add(lamp);
        (pivot as any).side = side;
        this.arms.push(pivot);
        this.group.add(pivot);
      }
    } else {
      for (const side of [-1, 1]) {
        const t = side * (this.gateT + 6);
        const y = field.lcRoadElevation(road, t) - this.position.y;
        b.box(0.08, 2.2, 0.08, mat(t, y + 1.1, 4.4), '#444');
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), labelMaterial(labelTexture('UNMANNED LC', { bg: '#ffffff', fg: '#c00', border: '#c00', w: 256, h: 160, lines: ['STOP', 'LOOK - LISTEN'] })));
        sign.position.set(t, y + 2.5, 4.4);
        sign.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.group.add(sign);
      }
    }
    this.group.add(b.build(materials() as unknown as Record<string, THREE.Material>));
    this.update(0);
  }

  /** Called every frame with whether a train is approaching/occupying. */
  update(dt: number, trainNear = false) {
    if (!this.manned) { this.closing = trainNear; return; }
    this.closing = trainNear;
    this.closed = approach(this.closed, trainNear ? 1 : 0, 1 / 7, dt);
    for (const p of this.arms) {
      const side = (p as any).side as number;
      p.rotation.x = side * (1 - this.closed) * (Math.PI / 2 - 0.08) * -1;
    }
  }
}
