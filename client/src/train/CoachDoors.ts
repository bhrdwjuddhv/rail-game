import * as THREE from 'three/webgpu';
import type { CoachData, Vehicle } from '@rail/shared/train/Consist';

/**
 * Doors on the platform side of the player's train: passenger coaches have a
 * door near each end, covered wagons one wide sliding door in the middle.
 * Each door is a panel that slides back along the body to open (0..1),
 * uncovering a dark doorway, with a lamp over it that lights while it is
 * open. Instanced: three draws for the whole train.
 */
interface DoorSpec { x: number; w: number; h: number; y: number; half: number }

function doorsOf(c: CoachData | undefined, length: number): DoorSpec[] {
  if (!c) return [];
  const kind = c.kind ?? 'coach';
  if (kind === 'coach') return [-1, 1].map(e => ({ x: e * (length / 2 - 1.05), w: 0.75, h: 1.95, y: 1.3, half: 1.6 }));
  if (kind === 'boxcar') return [{ x: 0, w: 2.4, h: 2.3, y: 1.3, half: 1.525 }];
  return [];
}

export class CoachDoors {
  readonly group = new THREE.Group();
  private panels: THREE.InstancedMesh;
  private holes: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private doors: { v: number; d: DoorSpec }[] = [];
  private m = new THREE.Matrix4();
  private t = new THREE.Matrix4();
  open = 0;

  constructor(vehicles: Vehicle[], coachTypes: Record<string, CoachData>) {
    vehicles.forEach((v, i) => { if (v.kind === 'coach') for (const d of doorsOf(coachTypes[v.typeId], v.length)) this.doors.push({ v: i, d }); });
    const n = Math.max(1, this.doors.length);
    this.panels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.05), new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.6, metalness: 0.4 }), n);
    this.holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x0b0d10 }), n);
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: 0xffd060 }), n);
    for (const im of [this.panels, this.holes, this.lamps]) { im.frustumCulled = false; im.count = 0; this.group.add(im); }
    this.group.visible = false;
  }

  get any() { return this.doors.length > 0; }

  /**
   * Place the doors on `side` (+1: the +lateral side of the track, -1 the other)
   * from the train's vehicle matrices (+x forward, +z = +lateral in the view).
   */
  update(vehicleMatrices: THREE.Matrix4[], side: number) {
    const show = this.open > 0.001 && this.doors.length > 0;
    this.group.visible = show;
    if (!show) return;
    const o = this.open;
    this.doors.forEach(({ v, d }, i) => {
      const base = vehicleMatrices[v], z = side * (d.half + 0.03);
      // doorway (just inside the body side) and the panel sliding back along the body
      this.holes.setMatrixAt(i, this.m.copy(base).multiply(this.t.makeTranslation(d.x, d.y + d.h / 2, side * (d.half + 0.005))).multiply(this.t.makeScale(d.w, d.h, 1)).multiply(this.t.makeRotationY(side > 0 ? 0 : Math.PI)));
      const slide = (d.x >= 0 ? 1 : -1) * o * (d.w + 0.05);
      this.panels.setMatrixAt(i, this.m.copy(base).multiply(this.t.makeTranslation(d.x + slide, d.y + d.h / 2, z)).multiply(this.t.makeScale(d.w, d.h, 1)));
      this.lamps.setMatrixAt(i, this.m.copy(base).multiply(this.t.makeTranslation(d.x, d.y + d.h + 0.18, side * (d.half + 0.04))));
    });
    for (const im of [this.panels, this.holes, this.lamps]) { im.count = this.doors.length; im.instanceMatrix.needsUpdate = true; }
    this.lamps.visible = o > 0.5;
  }
}
