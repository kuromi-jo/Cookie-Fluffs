/**
 * @file brand-icons.ts
 * @description Custom Cookie Fluffs SVG icons, drawn in the same outline style as Ionicons
 * (512 × 512 canvas, 32px rounded strokes, currentColor) so they sit naturally beside them.
 * Registered through addIcons() and used like any other icon: <ion-icon name='cf-cookie'>.
 */

// Same data-URL format Ionicons uses for its own icons: raw SVG markup with single-quoted attributes.
const svg = (body: string): string =>
  `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' class='ionicon' viewBox='0 0 512 512'><g fill='none' stroke='currentColor' stroke-width='32' stroke-linecap='round' stroke-linejoin='round'>${body}</g></svg>`;

const dot = (cx: number, cy: number, r = 18): string => `<circle cx='${cx}' cy='${cy}' r='${r}' fill='currentColor' stroke='none'/>`;

/** A chocolate-chip cookie with a bite taken out of the top right. */
export const cfCookie = svg(
  `<path d='M447 198A200 200 0 1 1 318 66A52 52 0 0 0 380 130A52 52 0 0 0 447 198Z'/>` +
    dot(190, 196) +
    dot(312, 228, 16) +
    dot(196, 330, 20) +
    dot(320, 350, 16) +
    dot(130, 262, 13),
);

/** A chocolate bar, half unwrapped from its foil. */
export const cfChocolate = svg(
  `<rect x='144' y='48' width='224' height='416' rx='36'/>` +
    `<path d='M256 48v264M144 160h224M144 272h224'/>` +
    `<path d='M144 352l224-48v124a36 36 0 0 1-36 36H180a36 36 0 0 1-36-36Z' fill='currentColor' fill-opacity='.3'/>`,
);

/** A strawberry with its leafy top. */
export const cfStrawberry = svg(
  `<path d='M256 464c-92-44-160-140-148-236 8-60 64-84 148-60 84-24 140 0 148 60 12 96-56 192-148 236Z'/>` +
    `<path d='M256 168c-20-36-60-56-104-52M256 168c20-36 60-56 104-52M256 168V64'/>` +
    dot(200, 260, 12) +
    dot(312, 260, 12) +
    dot(256, 316, 12) +
    dot(208, 364, 12) +
    dot(304, 364, 12),
);

/** An acorn, standing in for all our nutty cookies. */
export const cfNut = svg(
  `<path d='M112 208c0-72 64-112 144-112s144 40 144 112Z'/>` +
    `<path d='M256 96V56'/>` +
    `<path d='M144 208c0 112 48 200 112 248 64-48 112-136 112-248'/>` +
    `<path d='M176 160h160' stroke-width='24'/>`,
);

/** A carved jack-o'-lantern (face cut out, so the badge colour shows through), for Halloween bakes. */
export const cfPumpkin = svg(
  `<path d='M256 140c0-40 18-66 54-76'/>` +
    `<path fill='currentColor' stroke='none' fill-rule='evenodd' d='M56 300a200 158 0 1 0 400 0a200 158 0 1 0-400 0Z` +
    `M166 262l42-56 42 56ZM262 262l42-56 42 56Z` +
    `M150 318q106 84 212 0l-34 10-20 28-24-22-24 24-24-24-24 22-20-28Z'/>`,
);
