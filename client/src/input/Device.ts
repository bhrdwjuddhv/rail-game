import { safeStorageGet, safeStorageSet } from '../core/storage';

/**
 * Touch-device detection and the phone-specific bits of the page: fullscreen,
 * landscape lock and portrait detection. A device counts as touch if its
 * primary pointer is coarse and it has touch points (phones and tablets, not a
 * laptop with a touch screen used with a mouse). `?touch=1` / `?touch=0` force it.
 */
const forced = new URLSearchParams(location.search).get('touch');

export const isTouch: boolean = forced !== null
  ? forced === '1'
  : matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);

if (isTouch) document.documentElement.classList.add('touch');

/** iPhone / iPod: Safari has no page fullscreen there; "Add to Home Screen" is the way to play full screen. */
export const isIPhone = /iPhone|iPod/.test(navigator.userAgent);

/** Launched from the home screen (installed web app): already full screen. */
export const isStandalone = () =>
  matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isPortrait = () => innerHeight > innerWidth;

export const isFullscreen = () => !!(document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);

/**
 * Inside a user tap (Start, Resume, Tap to continue): go fullscreen and try to
 * lock landscape. Refusals and missing APIs are ignored - the game simply goes
 * on in the browser window (and the rotate screen covers portrait).
 */
export function enterGameScreen() {
  if (!isTouch) return;
  const lock = () => {
    try {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      o?.lock?.('landscape').catch(() => { /* not supported */ });
    } catch { /* not supported */ }
  };
  if (isIPhone || isStandalone() || isFullscreen()) { lock(); return; }
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(lock, lock);
    else if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); lock(); }
  } catch { /* refused: play in the browser window */ }
}

const IOS_TIP = 'railbharat.iosTip.v1';
/** One-time hint on iPhone (not already installed): how to get full screen there. */
export function iosFullscreenTip(parent: HTMLElement) {
  if (!isIPhone || isStandalone() || safeStorageGet(IOS_TIP, { shown: false }).shown) return;
  safeStorageSet(IOS_TIP, { shown: true });
  const tip = document.createElement('div');
  tip.className = 'ios-tip';
  tip.innerHTML = '<span>For full screen, tap <b>Share</b> &rarr; <b>Add to Home Screen</b>.</span><button>OK</button>';
  tip.querySelector('button')!.addEventListener('click', () => tip.remove());
  parent.appendChild(tip);
  setTimeout(() => tip.remove(), 12000);
}

/** Short haptic tick (Android; ignored where unsupported). */
export function buzz(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* not allowed */ }
}
