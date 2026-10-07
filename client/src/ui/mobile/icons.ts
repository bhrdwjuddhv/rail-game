// Rail Bharat's own line-art icons (24x24 unless noted), coloured by CSS through currentColor.
const svg = (body: string, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const ICON = {
  /** pause: rounded square outline with two bars */
  pause: svg(`<rect x="3.5" y="3.5" width="17" height="17" rx="4" ${S}/><path d="M10 8.5v7M14 8.5v7" ${S}/>`),
  camera: svg(`<path d="M4 8h3l1.6-2.2h6.8L17 8h3v10.5H4z" ${S}/><circle cx="12" cy="13.2" r="3.2" ${S}/>`),
  chevron: svg(`<path d="M7 10l5 5 5-5" ${S}/>`),
  /** windscreen with a wiper arc */
  wipers: svg(`<path d="M3 17h18" ${S}/><path d="M12 17 6.5 8.5" ${S}/><path d="M5 12.5a9 9 0 0 1 14 0" ${S} stroke-dasharray="2 2.6"/>`),
  /** lamp with beams */
  headlight: svg(`<path d="M10 6.5a5.5 5.5 0 0 0 0 11z" ${S}/><path class="beam b1" d="M14 9h6" ${S}/><path class="beam b2" d="M14 12h7" ${S}/><path class="beam b1" d="M14 15h6" ${S}/>`),
  /** ceiling lamp */
  cabLight: svg(`<path d="M12 3v4M7 13a5 5 0 0 1 10 0z" ${S}/><path d="M9 17l-1 2.5M12 17.5V20M15 17l1 2.5" ${S}/>`),
  /** two marker lamps on a buffer beam */
  markers: svg(`<path d="M3 16h18" ${S}/><circle cx="7" cy="11" r="2.6" ${S}/><circle cx="17" cy="11" r="2.6" ${S}/>`),
  /** circuit breaker: two contacts and a switch blade, with a supply line above (our own symbol) */
  vcb: svg(`<path d="M12 2.5v4.5M12 17v4.5" ${S}/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/><circle cx="12" cy="16.4" r="1.3" fill="currentColor"/><path class="blade" d="M12 16.4 18 9.2" ${S}/><path d="M6 9.5h3.5M6 14.5h3.5" ${S} stroke-width="1.4"/>`),
  /** diesel engine: engine block with a starter key arc */
  engine: svg(`<path d="M4 9h3l2-2h6v3h2l2-2h1v8h-1l-2-2h-2v3H9l-2-2H4z" ${S}/><path d="M9 4.5h5M11.5 4.5V7" ${S}/>`),
  /** fuel pump: fuel drop */
  fuel: svg(`<path d="M12 3.5c3.2 4 5 6.7 5 9.3a5 5 0 0 1-10 0c0-2.6 1.8-5.3 5-9.3z" ${S}/>`),
  /** God Mode: lightning bolt */
  god: svg(`<path d="M13.5 2 5 13.5h6L9.5 22 19 9.5h-6.2z" fill="currentColor"/>`),
  more: svg(`<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>`),
  /** air horn trumpet */
  horn: svg(`<path d="M4 10h3l9-4.5v13L7 14H4z" ${S}/><path d="M7 14l1.2 4.5h2.4L10 14.6" ${S}/><path d="M19 9.5a4 4 0 0 1 0 5" ${S}/>`),
  /** small station: canopy roof, posts, platform edge */
  station: svg(`<path d="M3 9.5 12 5l9 4.5" ${S}/><path d="M6 9.5V16M18 9.5V16M10 12.5h4" ${S}/><path d="M2.5 16.5h19" ${S}/><path d="M4 19.5h16" ${S} stroke-dasharray="1.5 2"/>`),
  /** emergency: octagon (viewBox 0 0 48 48) */
  octagon: svg(`<path d="M16 3h16l13 13v16L32 45H16L3 32V16z" fill="currentColor"/><path d="M16 3h16l13 13v16L32 45H16L3 32V16z" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="2"/>`, '0 0 48 48'),
  /** Rail Bharat roundel: wheel ring with two rails converging (score badge) */
  badge: svg(`<circle cx="12" cy="12" r="9.5" ${S}/><path d="M9.5 18.5 11 6M14.5 18.5 13 6M9.8 16h4.4M10.3 12.5h3.4M10.7 9.3h2.6" ${S} stroke-width="1.6"/>`),
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
