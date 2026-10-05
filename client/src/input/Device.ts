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

export const isPortrait = () => innerHeight > innerWidth;

/**
 * On a Start tap (must run inside the user gesture): go fullscreen and try to
 * lock landscape. Where lock is unsupported (iPhone Safari) the rotate screen
 * covers portrait instead.
 */
export function enterGameScreen() {
  if (!isTouch) return;
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  const lock = () => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    o?.lock?.('landscape').catch(() => { /* not supported: rotate screen handles portrait */ });
  };
  try {
    if (document.fullscreenElement) lock();
    else if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(lock, lock);
    else el.webkitRequestFullscreen?.();
  } catch { /* fullscreen refused: play in the browser window */ }
}

/** Short haptic tick (Android; ignored where unsupported). */
export function buzz(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* not allowed */ }
}
