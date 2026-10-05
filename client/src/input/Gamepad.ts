/**
 * Standard-mapping gamepad: RT = throttle notch, LT = train brake position,
 * A horn, B sander, X vigilance, Y headlights, LB/RB loco brake, D-pad up/down reverser,
 * right stick looks around.
 */
export interface PadTarget {
  setThrottleFraction(f: number): void;
  setTrainBrakeFraction(f: number): void;
  button(name: 'horn' | 'sander' | 'vigilance' | 'headlights' | 'locoBrakeApply' | 'locoBrakeRelease' | 'reverserFwd' | 'reverserBack' | 'camera', down: boolean): void;
  look(dx: number, dy: number): void;
}

const MAP: [number, Parameters<PadTarget['button']>[0]][] = [
  [0, 'horn'], [1, 'sander'], [2, 'vigilance'], [3, 'headlights'], [4, 'locoBrakeRelease'], [5, 'locoBrakeApply'], [12, 'reverserFwd'], [13, 'reverserBack'], [8, 'camera'],
];

export class Gamepad {
  private prev: boolean[] = [];
  private lastRT = -1;
  private lastLT = -1;

  poll(t: PadTarget) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).find(Boolean);
    if (!p) return;
    const rt = p.buttons[7]?.value ?? 0, lt = p.buttons[6]?.value ?? 0;
    // only drive the controls when the triggers actually move (so keyboard still works)
    if (Math.abs(rt - this.lastRT) > 0.02) { this.lastRT = rt; t.setThrottleFraction(rt); }
    if (Math.abs(lt - this.lastLT) > 0.02) { this.lastLT = lt; t.setTrainBrakeFraction(lt); }
    for (const [i, name] of MAP) {
      const d = !!p.buttons[i]?.pressed;
      if (d !== !!this.prev[i]) t.button(name, d);
      this.prev[i] = d;
    }
    const rx = p.axes[2] ?? 0, ry = p.axes[3] ?? 0;
    if (Math.abs(rx) > 0.15 || Math.abs(ry) > 0.15) t.look(rx * 12, ry * 12);
  }
}
