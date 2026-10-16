// The touch controls' icons: the registry's (theme/icons.ts), under the names the controls use.
import { icon } from '../theme/icons';
const svg = (body: string, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  pause: icon('pause'),
  camera: icon('camera'),
  chevron: icon('caretDown'),
  wipers: icon('wiper'),
  headlight: icon('headlight'),
  cabLight: icon('cabLight'),
  markers: icon('markerLight'),
  vcb: icon('vcb'),
  engine: icon('engineStart'),
  fuel: icon('fuelPump'),
  god: icon('lightning'),
  more: icon('more'),
  horn: icon('horn'),
  station: icon('platform'),
  /** emergency: the octagon stop sign itself (viewBox 0 0 48 48), not an icon */
  octagon: svg(`<path d="M16 3h16l13 13v16L32 45H16L3 32V16z" fill="currentColor"/><path d="M16 3h16l13 13v16L32 45H16L3 32V16z" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="2"/>`, '0 0 48 48'),
  badge: icon('star'),
};

/**
 * Signal head graphic (Indian 4-aspect colour light: Y, G, R, Y from top), lamps
 * lit by CSS classes set on the parent (.asp-R / .asp-Y / .asp-YY / .asp-G).
 */
export const SIGNAL_HEAD = svg(
  `<rect x="5" y="1" width="14" height="40" rx="4" fill="#0d0d0d" stroke="#e6e6e6" stroke-width="1.4"/>` +
  `<circle class="l ly1" cx="12" cy="8" r="3.6"/><circle class="l lg" cx="12" cy="16.5" r="3.6"/>` +
  `<circle class="l lr" cx="12" cy="25" r="3.6"/><circle class="l ly2" cx="12" cy="33.5" r="3.6"/>`,
  '0 0 24 42');
