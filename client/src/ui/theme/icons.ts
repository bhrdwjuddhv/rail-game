// The one icon registry: every button and card takes its icon from here.
//
// Duotone: each icon has a main shape in full colour and a secondary fill (class "dt2") in the same
// colour at lower opacity. Both follow currentColor, the secondary's opacity is the CSS variable
// --icon-duo (theme/tokens.css), so icons change with button states and themes.
//
// General icons: Phosphor Icons, duotone weight (MIT, https://phosphoricons.com), imported as raw SVG
// so only the ones listed here are bundled (no icon font, no CDN). Railway icons are our own, drawn
// on a 24-unit grid in the same style.
import play from '@phosphor-icons/core/duotone/play-duotone.svg?raw';
import pause from '@phosphor-icons/core/duotone/pause-duotone.svg?raw';
import gear from '@phosphor-icons/core/duotone/gear-six-duotone.svg?raw';
import camera from '@phosphor-icons/core/duotone/camera-duotone.svg?raw';
import map from '@phosphor-icons/core/duotone/map-trifold-duotone.svg?raw';
import sun from '@phosphor-icons/core/duotone/sun-duotone.svg?raw';
import sunHorizon from '@phosphor-icons/core/duotone/sun-horizon-duotone.svg?raw';
import moon from '@phosphor-icons/core/duotone/moon-stars-duotone.svg?raw';
import cloud from '@phosphor-icons/core/duotone/cloud-duotone.svg?raw';
import rain from '@phosphor-icons/core/duotone/cloud-rain-duotone.svg?raw';
import storm from '@phosphor-icons/core/duotone/cloud-lightning-duotone.svg?raw';
import snow from '@phosphor-icons/core/duotone/snowflake-duotone.svg?raw';
import fog from '@phosphor-icons/core/duotone/cloud-fog-duotone.svg?raw';
import hazy from '@phosphor-icons/core/duotone/sun-dim-duotone.svg?raw';
import clock from '@phosphor-icons/core/duotone/clock-duotone.svg?raw';
import search from '@phosphor-icons/core/duotone/magnifying-glass-duotone.svg?raw';
import close from '@phosphor-icons/core/duotone/x-duotone.svg?raw';
import check from '@phosphor-icons/core/duotone/check-duotone.svg?raw';
import info from '@phosphor-icons/core/duotone/info-duotone.svg?raw';
import star from '@phosphor-icons/core/duotone/star-duotone.svg?raw';
import caretLeft from '@phosphor-icons/core/duotone/caret-left-duotone.svg?raw';
import caretRight from '@phosphor-icons/core/duotone/caret-right-duotone.svg?raw';
import caretDown from '@phosphor-icons/core/duotone/caret-down-duotone.svg?raw';
import swap from '@phosphor-icons/core/duotone/arrows-left-right-duotone.svg?raw';
import restart from '@phosphor-icons/core/duotone/arrow-counter-clockwise-duotone.svg?raw';
import home from '@phosphor-icons/core/duotone/house-duotone.svg?raw';
import tutorial from '@phosphor-icons/core/duotone/graduation-cap-duotone.svg?raw';
import lightning from '@phosphor-icons/core/duotone/lightning-duotone.svg?raw';
import film from '@phosphor-icons/core/duotone/film-slate-duotone.svg?raw';
import keyboard from '@phosphor-icons/core/duotone/keyboard-duotone.svg?raw';
import help from '@phosphor-icons/core/duotone/question-duotone.svg?raw';
import scenarios from '@phosphor-icons/core/duotone/flag-checkered-duotone.svg?raw';
import compass from '@phosphor-icons/core/duotone/compass-duotone.svg?raw';
import route from '@phosphor-icons/core/duotone/path-duotone.svg?raw';
import globe from '@phosphor-icons/core/duotone/globe-duotone.svg?raw';
import more from '@phosphor-icons/core/duotone/dots-three-duotone.svg?raw';
import fastForward from '@phosphor-icons/core/duotone/fast-forward-duotone.svg?raw';
import menu from '@phosphor-icons/core/duotone/list-duotone.svg?raw';
import select from '@phosphor-icons/core/duotone/crosshair-duotone.svg?raw';
import videoCamera from '@phosphor-icons/core/duotone/video-camera-duotone.svg?raw';
import copy from '@phosphor-icons/core/duotone/copy-duotone.svg?raw';
import download from '@phosphor-icons/core/duotone/download-simple-duotone.svg?raw';
import trash from '@phosphor-icons/core/duotone/trash-duotone.svg?raw';
import plus from '@phosphor-icons/core/duotone/plus-duotone.svg?raw';
import minus from '@phosphor-icons/core/duotone/minus-duotone.svg?raw';
import warning from '@phosphor-icons/core/duotone/warning-duotone.svg?raw';
import megaphone from '@phosphor-icons/core/duotone/megaphone-duotone.svg?raw';
import save from '@phosphor-icons/core/duotone/floppy-disk-duotone.svg?raw';
import recent from '@phosphor-icons/core/duotone/clock-counter-clockwise-duotone.svg?raw';
import pin from '@phosphor-icons/core/duotone/map-pin-duotone.svg?raw';
import train from '@phosphor-icons/core/duotone/train-duotone.svg?raw';
import mountains from '@phosphor-icons/core/duotone/mountains-duotone.svg?raw';
import wind from '@phosphor-icons/core/duotone/wind-duotone.svg?raw';
import sliders from '@phosphor-icons/core/duotone/sliders-duotone.svg?raw';
import arrowLeft from '@phosphor-icons/core/duotone/arrow-left-duotone.svg?raw';
import arrowRight from '@phosphor-icons/core/duotone/arrow-right-duotone.svg?raw';
import eye from '@phosphor-icons/core/duotone/eye-duotone.svg?raw';
import eyeSlash from '@phosphor-icons/core/duotone/eye-slash-duotone.svg?raw';
import sound from '@phosphor-icons/core/duotone/speaker-high-duotone.svg?raw';
import users from '@phosphor-icons/core/duotone/users-duotone.svg?raw';

/** a Phosphor SVG: its inner shapes (the 20 % layer becomes the themable secondary) */
const ph = (raw: string) => ({ vb: '0 0 256 256', body: raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/ opacity="0\.2"/g, ' class="dt2"') });

// our railway icons: main strokes (S) and secondary fills (D) on a 24-unit grid
const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const D = 'class="dt2" fill="currentColor" stroke="none"';
const own = (body: string) => ({ vb: '0 0 24 24', body });

const RAIL = {
  /** pantograph on a loco roof under the contact wire */
  pantograph: own(`<path d="M3 3.5h18" ${S} stroke-dasharray="2 2"/><rect x="5" y="18" width="14" height="3" rx="1" ${D}/><rect x="5" y="18" width="14" height="3" rx="1" ${S}/><path d="M9 18l6.5-5.5L10 7M6.5 7h7" ${S}/>`),
  /** vacuum circuit breaker: housing, contacts, switch blade (class "blade" moves) */
  vcb: own(`<rect x="5" y="5.5" width="14" height="13" rx="2.5" ${D}/><path d="M12 2.5v5M12 16.5v5" ${S}/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/><circle cx="12" cy="16.4" r="1.3" fill="currentColor"/><path class="blade" d="M12 16.4 17 9.6" ${S}/>`),
  /** reverser: a rotary switch between R and F */
  reverser: own(`<circle cx="12" cy="13" r="7.5" ${D}/><circle cx="12" cy="13" r="7.5" ${S}/><path d="M12 13l4-4.5" ${S} stroke-width="2.2"/><path d="M5.5 4.5 3.5 6.5l2 2M18.5 4.5l2 2-2 2" ${S}/>`),
  /** air horn trumpet */
  horn: own(`<path d="M4 10h3l9-4.5v13L7 14H4z" ${D}/><path d="M4 10h3l9-4.5v13L7 14H4z" ${S}/><path d="M7 14l1.2 4.5h2.4L10 14.6M19 9.5a4 4 0 0 1 0 5" ${S}/>`),
  /** windscreen with a wiper */
  wiper: own(`<path d="M3 18 5 7h14l2 11z" ${D}/><path d="M3 18 5 7h14l2 11z" ${S}/><path d="M12 18 7.5 10" ${S}/><path d="M6 13.5a8 8 0 0 1 12 0" ${S} stroke-dasharray="1.6 2.2"/>`),
  /** headlamp with beams (classes beam b1 / b2: the HUD dims them by level) */
  headlight: own(`<path d="M10 6.5a5.5 5.5 0 0 0 0 11z" ${D}/><path d="M10 6.5a5.5 5.5 0 0 0 0 11z" ${S}/><path class="beam b1" d="M14 9h6" ${S}/><path class="beam b2" d="M14 12h7" ${S}/><path class="beam b1" d="M14 15h6" ${S}/>`),
  /** two marker lamps on the buffer beam */
  markerLight: own(`<circle cx="7" cy="11" r="2.8" ${D}/><circle cx="17" cy="11" r="2.8" ${D}/><path d="M3 16.5h18" ${S}/><circle cx="7" cy="11" r="2.8" ${S}/><circle cx="17" cy="11" r="2.8" ${S}/>`),
  /** cab ceiling lamp */
  cabLight: own(`<path d="M7 13a5 5 0 0 1 10 0z" ${D}/><path d="M12 3v4M7 13a5 5 0 0 1 10 0z" ${S}/><path d="M9 16.5l-1 2.5M12 17v2.8M15 16.5l1 2.5" ${S}/>`),
  /** sander: a sand box dropping sand in front of a wheel on the rail */
  sander: own(`<path d="M5 4h8l-2 5H7z" ${D}/><path d="M5 4h8l-2 5H7z" ${S}/><circle cx="15" cy="15" r="4.5" ${D}/><circle cx="15" cy="15" r="4.5" ${S}/><path d="M3 20.5h18" ${S}/><path d="M9 11.5v.1M8.5 14v.1M9.8 16.5v.1M8.8 18.6v.1" ${S} stroke-width="2.2"/>`),
  /** vigilance: the acknowledge button with an alert pulse */
  vigilance: own(`<circle cx="12" cy="12" r="5.5" ${D}/><circle cx="12" cy="12" r="5.5" ${S}/><path d="M12 9.5v3M12 14.6v.1" ${S}/><path d="M4.5 7.5a9 9 0 0 0 0 9M19.5 7.5a9 9 0 0 1 0 9" ${S}/>`),
  /** diesel engine start: engine block with a starter key */
  engineStart: own(`<path d="M4 9h3l2-2h6v3h2l2-2h1v8h-1l-2-2h-2v3H9l-2-2H4z" ${D}/><path d="M4 9h3l2-2h6v3h2l2-2h1v8h-1l-2-2h-2v3H9l-2-2H4z" ${S}/><path d="M9 4.5h5M11.5 4.5V7" ${S}/>`),
  /** fuel pump: pump, hose and nozzle */
  fuelPump: own(`<rect x="4" y="4" width="9" height="16" rx="1.5" ${D}/><rect x="4" y="4" width="9" height="16" rx="1.5" ${S}/><path d="M6.5 7.5h4v3h-4zM13 8h2.5a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V7.5L18 5.5" ${S}/><path d="M3 20.5h11" ${S}/>`),
  /** doors: two leaves sliding apart */
  doors: own(`<rect x="5" y="4" width="6" height="16" rx="1" ${D}/><rect x="13" y="4" width="6" height="16" rx="1" ${D}/><rect x="5" y="4" width="6" height="16" rx="1" ${S}/><rect x="13" y="4" width="6" height="16" rx="1" ${S}/><path d="M3.5 12H1.5M22.5 12h-2M2.8 10.6 1.5 12l1.3 1.4M21.2 10.6l1.3 1.4-1.3 1.4" ${S}/>`),
  /** couple: two vehicle ends pushed together on the coupler */
  couple: own(`<rect x="1.5" y="7" width="8" height="9" rx="1.2" ${D}/><rect x="14.5" y="7" width="8" height="9" rx="1.2" ${D}/><rect x="1.5" y="7" width="8" height="9" rx="1.2" ${S}/><rect x="14.5" y="7" width="8" height="9" rx="1.2" ${S}/><path d="M9.5 12h5" ${S} stroke-width="2.4"/><path d="M12 4.5v3M10.5 6l1.5 1.5L13.5 6" ${S}/>`),
  /** decouple: the same two ends drawn apart */
  decouple: own(`<rect x="1" y="7" width="7" height="9" rx="1.2" ${D}/><rect x="16" y="7" width="7" height="9" rx="1.2" ${D}/><rect x="1" y="7" width="7" height="9" rx="1.2" ${S}/><rect x="16" y="7" width="7" height="9" rx="1.2" ${S}/><path d="M8 12h2.5M13.5 12H16" ${S} stroke-width="2.2"/><path d="M11 9.5l2 5" ${S}/>`),
  /** colour light signal on its post */
  signal: own(`<rect x="8" y="2.5" width="8" height="13" rx="2.5" ${D}/><rect x="8" y="2.5" width="8" height="13" rx="2.5" ${S}/><circle cx="12" cy="6.5" r="1.6" fill="currentColor"/><circle cx="12" cy="11.3" r="1.6" ${S}/><path d="M12 15.5v6M8.5 21.5h7" ${S}/>`),
  /** platform: canopy, posts and platform edge */
  platform: own(`<path d="M2.5 15.5h19v3h-19z" ${D}/><path d="M3 9.5 12 5l9 4.5" ${S}/><path d="M6 9.5v6M18 9.5v6" ${S}/><path d="M2.5 15.5h19v3h-19z" ${S}/>`),
  /** junction: a line dividing in two */
  junction: own(`<circle cx="5" cy="12" r="2.6" ${D}/><circle cx="19" cy="6" r="2.6" ${D}/><circle cx="19" cy="18" r="2.6" ${D}/><path d="M7.6 12H11c2.5 0 3.5-6 5.4-6M11 12c2.5 0 3.5 6 5.4 6" ${S}/><circle cx="5" cy="12" r="2.6" ${S}/><circle cx="19" cy="6" r="2.6" ${S}/><circle cx="19" cy="18" r="2.6" ${S}/>`),
  /** electric loco, side view: cab windows, pantograph, bogies */
  loco: own(`<path d="M2.5 9h17.5l1.5 3v4.5h-19z" ${D}/><path d="M2.5 9h17.5l1.5 3v4.5h-19z" ${S}/><path d="M17 11h3M4.5 11h2.5" ${S}/><path d="M9 9l3.5-3.5L10 4M8 4h4" ${S}/><circle cx="6.5" cy="18.5" r="1.6" ${S}/><circle cx="17.5" cy="18.5" r="1.6" ${S}/>`),
  /** passenger coach: body, window row, bogies */
  coach: own(`<rect x="2" y="7" width="20" height="9.5" rx="2" ${D}/><rect x="2" y="7" width="20" height="9.5" rx="2" ${S}/><path d="M5 10.5h2.5M10.75 10.5h2.5M16.5 10.5H19" ${S}/><circle cx="6.5" cy="18.5" r="1.6" ${S}/><circle cx="17.5" cy="18.5" r="1.6" ${S}/>`),
  /** open goods wagon */
  wagon: own(`<path d="M2.5 8h19l-1.5 8.5h-16z" ${D}/><path d="M2.5 8h19l-1.5 8.5h-16z" ${S}/><path d="M8.5 8v8.5M15.5 8v8.5" ${S}/><circle cx="6.5" cy="18.5" r="1.6" ${S}/><circle cx="17.5" cy="18.5" r="1.6" ${S}/>`),
  /** containers stacked two high on a flat wagon */
  container: own(`<rect x="3" y="4" width="18" height="5.5" rx=".8" ${D}/><rect x="3" y="10.5" width="18" height="5.5" rx=".8" ${D}/><rect x="3" y="4" width="18" height="5.5" rx=".8" ${S}/><rect x="3" y="10.5" width="18" height="5.5" rx=".8" ${S}/><path d="M2 17.5h20" ${S}/><circle cx="6.5" cy="19.6" r="1.4" ${S}/><circle cx="17.5" cy="19.6" r="1.4" ${S}/>`),
  /** freight load: a heap in an open wagon */
  freightLoad: own(`<path d="M4.5 10c2-3.5 4-5 7.5-5s5.5 1.5 7.5 5z" ${D}/><path d="M4.5 10c2-3.5 4-5 7.5-5s5.5 1.5 7.5 5" ${S}/><path d="M2.5 10h19l-1.5 7h-16z" ${S}/><circle cx="6.5" cy="19.5" r="1.4" ${S}/><circle cx="17.5" cy="19.5" r="1.4" ${S}/>`),
};

const REGISTRY = {
  play: ph(play), pause: ph(pause), gear: ph(gear), camera: ph(camera), map: ph(map),
  sun: ph(sun), sunHorizon: ph(sunHorizon), moon: ph(moon), cloud: ph(cloud), rain: ph(rain), storm: ph(storm),
  snow: ph(snow), fog: ph(fog), hazy: ph(hazy), clock: ph(clock), search: ph(search), close: ph(close), check: ph(check),
  info: ph(info), star: ph(star), caretLeft: ph(caretLeft), caretRight: ph(caretRight), caretDown: ph(caretDown),
  swap: ph(swap), restart: ph(restart), home: ph(home), tutorial: ph(tutorial), lightning: ph(lightning), film: ph(film),
  keyboard: ph(keyboard), help: ph(help), scenarios: ph(scenarios), compass: ph(compass), route: ph(route), globe: ph(globe),
  more: ph(more), fastForward: ph(fastForward), menu: ph(menu), select: ph(select), videoCamera: ph(videoCamera), copy: ph(copy),
  download: ph(download), trash: ph(trash), plus: ph(plus), minus: ph(minus), warning: ph(warning), megaphone: ph(megaphone),
  save: ph(save), recent: ph(recent), pin: ph(pin), train: ph(train), mountains: ph(mountains), wind: ph(wind),
  sliders: ph(sliders), arrowLeft: ph(arrowLeft), arrowRight: ph(arrowRight), eye: ph(eye), eyeSlash: ph(eyeSlash),
  sound: ph(sound), users: ph(users),
  ...RAIL,
};

export type IconName = keyof typeof REGISTRY;
export const ICON_NAMES = Object.keys(REGISTRY) as IconName[];
/** the railway icons drawn for the game (the rest are Phosphor) */
export const RAIL_ICONS = Object.keys(RAIL) as IconName[];

/** An icon as inline SVG (class "ic" plus `cls`), coloured by currentColor. */
export function icon(name: IconName, cls = '') {
  const i = REGISTRY[name];
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="${i.vb}" fill="currentColor" aria-hidden="true" focusable="false">${i.body}</svg>`;
}
