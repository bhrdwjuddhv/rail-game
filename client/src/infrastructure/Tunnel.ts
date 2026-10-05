import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { labelTexture } from '../core/Textures';
import { labelMaterial, materials } from '../core/Materials';
import { newFrame, TrackFrame } from '@rail/shared/track/Chainage';
import { Strip } from '../track/TrackMeshBuilder';
import type { Route, StructureData } from '@rail/shared/track/Route';

/**
 * Tunnel lining (horseshoe profile) + stone portals with a cover slab into the
 * hill. On a double line it is one wider double-line bore: the walls move out
 * by half the track spacing and the arch becomes a flatter ellipse.
 */
export function buildTunnel(route: Route, t: StructureData): THREE.Group {
  const H = route.halfSpacing;
  const R = 3.9, rx = R + H, ry2 = R + H * 0.45; // arch half-width and rise
  const sx = rx / R, sy = ry2 / R;
  const f = newFrame();
  const s0 = t.fromKm * 1000, s1 = t.toKm * 1000;
  route.alignment.sample((s0 + s1) / 2, f);
  const ox = f.x, oz = f.z;
  const group = new THREE.Group();
  group.position.set(ox, 0, oz);

  // horseshoe profile (lateral, up), walls + arch
  const prof: [number, number][] = [[-rx, -0.4], [-rx, 3.6]];
  for (let i = 1; i < 12; i++) { const a = Math.PI - (i / 12) * Math.PI; prof.push([Math.cos(a) * rx, 3.6 + Math.sin(a) * ry2]); }
  prof.push([rx, 3.6], [rx, -0.4]);
  const frames: TrackFrame[] = [], ss: number[] = [];
  for (let s = s0; s <= s1 + 0.01; s += 4) { const fr = newFrame(); route.alignment.sample(Math.min(s, s1), fr); fr.cant = 0; frames.push(fr); ss.push(s - s0); }
  const strip = new Strip();
  strip.extrude(frames, ss, prof, ox, oz, 1, 1);
  const M = materials();
  const lining = new THREE.Mesh(strip.geometry(), M.tunnel);
  lining.receiveShadow = true;
  group.add(lining);

  const b = new GeoBatch();
  for (const [s, dir] of [[s0, -1], [s1, 1]] as const) {
    route.alignment.sample(s, f);
    const x = f.x - ox, z = f.z - oz, y = f.y, ry = -f.heading;
    const fw = (d: number, lat: number) => mat(x + Math.cos(f.heading) * d - Math.sin(f.heading) * lat, 0, z + Math.sin(f.heading) * d + Math.cos(f.heading) * lat, ry);
    const place = (d: number, lat: number, yy: number, w: number, h: number, depth: number, color: string) => {
      const m = fw(d, lat);
      m.elements[13] = yy;
      b.box(depth, h, w, m, color, 'stone');
    };
    // portal face: piers either side and a lintel above the arch
    const lift = (sy - 1) * 4.3;
    place(0, -7.9 - H, y + 6.5 + lift / 2, 8, 14 + lift, 1.6, '#8b8478');
    place(0, 7.9 + H, y + 6.5 + lift / 2, 8, 14 + lift, 1.6, '#8b8478');
    place(0, 0, y + 10.5 + lift, 7.8 + 2 * H, 6, 1.6, '#8b8478');
    // arch ring
    const ring = new THREE.TorusGeometry(4.3, 0.45, 6, 16, Math.PI).scale(sx, sy, 1);
    const rm = fw(0, 0); rm.elements[13] = y + 3.6;
    b.add(ring, rm.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), '#6f695f', 'stone');
    // parapet + cover slab into the hill (hides the terrain hole)
    place(-dir * 8, 0, y + 13.6 + lift, 24 + 2 * H, 1.2, 18, '#5f6f45');
    place(0.6 * -dir, 0, y + 13.9 + lift, 24 + 2 * H, 1, 1.4, '#9a9386');
    // wing walls
    for (const s2 of [-1, 1]) place(dir * 4, s2 * (12.5 + H), y + 3.5, 2, 7, 9, '#857e72');
    // name plate
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.8), labelMaterial(labelTexture(t.name, { bg: '#f2efe6', fg: '#222', w: 512, h: 112 })));
    const pm = fw(dir * 0.85, 0);
    plate.position.set(pm.elements[12], y + 8.6 + lift, pm.elements[14]);
    plate.rotation.y = ry + (dir < 0 ? -Math.PI / 2 : Math.PI / 2);
    group.add(plate);
  }
  group.add(b.build(M as unknown as Record<string, THREE.Material>));
  return group;
}
