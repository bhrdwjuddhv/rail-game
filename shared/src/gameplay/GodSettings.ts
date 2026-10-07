import type { WeatherId } from '../weather';

/**
 * God Mode: one typed settings object. Systems never check the UI; they read
 * `god.eff` (the effective settings), which is NORMAL whenever the master
 * switch is off, so every rule behaves exactly as before unless God Mode is on.
 */
export interface GodSettings {
  // signals & rules
  obeySignals: boolean;
  autoStopAtRed: boolean;
  forceGreen: boolean;
  spadPenalty: boolean;
  speedEnforcement: boolean;
  mustStop: boolean;
  vigilance: boolean;
  /** routes are not set for the player: points ahead are thrown by hand */
  manualPoints: boolean;
  // train
  unlimitedSpeed: boolean;
  instantBrakes: boolean;
  noWheelSlip: boolean;
  infiniteAir: boolean;
  powerMultiplier: number;   // 0.5..5
  massMultiplier: number;    // 0.25..3
  autoDrive: boolean;
  // world
  freezeTime: boolean;
  timeSpeed: number;         // 1..10
  weather: WeatherId | null; // null = keep current
  // camera
  unlockFreeCamera: boolean;
  hideHud: boolean;
}

/** What every system uses when God Mode is off. */
export const NORMAL: Readonly<GodSettings> = Object.freeze({
  obeySignals: true, autoStopAtRed: false, forceGreen: false, spadPenalty: true, speedEnforcement: true, mustStop: true, vigilance: true, manualPoints: false,
  unlimitedSpeed: false, instantBrakes: false, noWheelSlip: false, infiniteAir: false, powerMultiplier: 1, massMultiplier: 1, autoDrive: false,
  freezeTime: false, timeSpeed: 1, weather: null,
  unlockFreeCamera: false, hideHud: false,
});
