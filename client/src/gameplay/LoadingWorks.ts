import * as THREE from 'three/webgpu';
import { GeoBatch, mat } from '../core/GeoBatch';
import { materials } from '../core/Materials';
import { looseContainer } from '../train/Wagons';

/**
 * What the player sees while a goods train is loaded or unloaded: a gantry
 * crane straddling the wagon being worked lifts a container between the
 * stack beside the line and the wagon (container wagons), or a forklift runs
 * pallets between a stack and the wagon's open door (covered wagons). Only
 * the wagon being worked is animated; the rest of the train changes with the
 * progress (StationWork.onWagon).
 */
export class LoadingWorks {
  readonly group = new THREE.Group();
  private crane: THREE.Group;
  private hoist: THREE.Group;
  private box: THREE.Mesh;
  private forklift: THREE.Group;
  private fork: THREE.Group;
  private m = new THREE.Matrix4();
  private t = new THREE.Matrix4();

  constructor() {
    const M = materials() as unknown as Record<string, THREE.Material>;
    const Y = '#e3b021';
    // gantry: four legs either side of the wagon, two girders across, a trolley
    const b = new GeoBatch();
    for (const z of [-3.2, 3.2]) for (const x of [-4, 4]) b.box(0.5, 10, 0.5, mat(x, 5, z), Y, 'metal');
    for (const z of [-3.2, 3.2]) { b.box(8.6, 0.6, 0.6, mat(0, 10.1, z), Y, 'metal'); b.box(8.4, 0.5, 0.9, mat(0, 0.25, z), '#3a3a3a', 'metal'); }
    for (const x of [-4, 4]) b.box(0.6, 0.7, 7.4, mat(x, 10.3, 0), Y, 'metal');
    this.crane = b.build(M);
    const hb = new GeoBatch();
    hb.box(2.2, 0.8, 2.6, mat(0, 0.4, 0), '#d8d8d0', 'metal');            // trolley (local y 0 = girder top)
    for (const x of [-4, 4]) hb.box(0.04, 1, 0.04, mat(x * 0.7, -0.5, 0), '#222', 'metal');
    this.hoist = hb.build(M);
    const c = looseContainer(1);
    this.box = new THREE.Mesh(c.geo, c.mat);
    this.box.material = (this.box.material as THREE.MeshStandardMaterial).clone();
    (this.box.material as THREE.MeshStandardMaterial).color.set('#2f6fa3');
    this.crane.add(this.hoist, this.box);
    // forklift with a pallet of sacks on its forks
    const f = new GeoBatch();
    f.box(2.2, 1.1, 1.2, mat(-0.4, 0.75, 0), '#d68a1b', 'metal');
    f.box(0.8, 1.0, 1.0, mat(-0.9, 1.75, 0), '#2b2b2b', 'metal');            // cab cage
    for (const z of [-0.5, 0.5]) for (const x of [-1.2, 0.5]) f.cyl(0.3, 0.3, 0.25, 10, mat(x, 0.3, z, 0, Math.PI / 2), '#151515');
    f.box(0.12, 2.4, 1.0, mat(0.85, 1.2, 0), '#3a3a3a', 'metal');             // mast
    this.forklift = f.build(M);
    const fk = new GeoBatch();
    for (const z of [-0.3, 0.3]) fk.box(1.1, 0.06, 0.12, mat(0.5, 0, z), '#222', 'metal');
    fk.box(1.1, 0.12, 1.0, mat(0.5, 0.1, 0), '#9c7a4a');                       // pallet
    fk.box(1.0, 0.7, 0.9, mat(0.5, 0.52, 0), '#c9b48a');                       // sacks
    this.fork = fk.build(M);
    this.fork.position.set(0.9, 0.2, 0);
    this.forklift.add(this.fork);
    this.group.add(this.crane, this.forklift);
    this.group.visible = false;
  }

  /**
   * kind: what is being done; wagon: its world matrix (+x forward, +z = +lateral),
   * container / covered; u: 0..1 through this wagon's turn; side: the yard side.
   */
  update(job: { kind: 'load' | 'unload'; wagon: THREE.Matrix4; containers: boolean; u: number } | null, side: number) {
    this.group.visible = !!job;
    if (!job) return;
    const { u, wagon } = job;
    const loading = job.kind === 'load';
    if (job.containers) {
      this.crane.visible = true; this.forklift.visible = false;
      this.m.copy(wagon).multiply(this.t.makeTranslation(0, -0.6, side * 0.8));
      this.m.decompose(this.crane.position, this.crane.quaternion, this.crane.scale);
      // trolley path: stack (beside the line) <-> wagon; the container rides under it when carried
      const stackZ = side * 2.6, wagonZ = -side * 0.8, high = 7.5, low = { stack: 1.3, wagon: 2.2 };
      const k = loading ? u : 1 - u; // 0 = at the stack, 1 = on the wagon
      const z = stackZ + (wagonZ - stackZ) * smooth((k - 0.25) / 0.5);
      const lift = k < 0.25 ? k / 0.25 : k > 0.75 ? (1 - k) / 0.25 : 1;
      const atWagon = k > 0.5, y = (atWagon ? low.wagon : low.stack) + (high - (atWagon ? low.wagon : low.stack)) * smooth(lift);
      this.hoist.position.set(0, 10.4, z);
      this.box.position.set(0, y, z);
      this.box.visible = true;
    } else {
      this.crane.visible = false; this.forklift.visible = true;
      // forklift: between the stack and the wagon door, a pallet each way
      const k = (u * 3) % 1, out = k < 0.5, a = out ? k / 0.5 : (1 - k) / 0.5;
      const z = side * (6.5 - 4.2 * smooth(a));
      this.m.copy(wagon).multiply(this.t.makeTranslation(0, -1.0, z)).multiply(this.t.makeRotationY(side > 0 ? Math.PI / 2 : -Math.PI / 2));
      this.m.decompose(this.forklift.position, this.forklift.quaternion, this.forklift.scale);
      // carrying when going in (loading) or coming out (unloading)
      this.fork.visible = loading ? out : !out;
    }
  }
}

const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
