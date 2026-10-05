import { G } from '../../core/util';
import type { Vehicle } from '../Consist';

/** Davis rolling + aerodynamic resistance for the whole train, N (magnitude). */
export function davisResistance(vehicles: Vehicle[], speed: number) {
  const v = Math.abs(speed);
  let a = 0, b = 0, c = 0;
  for (const veh of vehicles) { a += veh.davis.a; b += veh.davis.b; c += veh.davis.c; }
  return a + b * v + c * v * v;
}

/** Rolling-only part, used as static friction when the train is standing. */
export function startingResistance(vehicles: Vehicle[]) {
  let a = 0;
  for (const veh of vehicles) a += veh.davis.a;
  return a * 1.8; // starting resistance is higher than running
}

/** Gradient force along the track for one vehicle (+ pushes toward increasing km). */
export const gradeForce = (massKg: number, grade: number) => -massKg * G * grade / Math.sqrt(1 + grade * grade);

/** Curve resistance (magnitude), empirical 0.6/R specific resistance. */
export const curveResistance = (massKg: number, curvature: number) => massKg * G * 0.6 * Math.abs(curvature);
