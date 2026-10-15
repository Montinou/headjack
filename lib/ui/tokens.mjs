// Headjack paper and cobalt palette (spec section 5). Light theme only.
export const TOKENS = Object.freeze({
  paper: "#F6F2EA",
  paperRaised: "#FBF9F4",
  rule: "#E3DCCD",
  inkTitle: "#152150",
  ink: "#2B2A26",
  inkMuted: "#6B6457",
  cobalt: "#1E4FD8",
  cobaltHover: "#1A43B8",
  cobaltSoft: "#E8EEFC",
  success: "#256B40",
  warning: "#8F5B0E",
  danger: "#B42318",
});

const TEXT_TOKENS = [
  "inkTitle",
  "ink",
  "inkMuted",
  "cobalt",
  "success",
  "warning",
  "danger",
];
const TEXT_SURFACES = ["paper", "paperRaised", "cobaltSoft"];

// Every foreground/background pair text may use; each must reach 4.5:1.
export const TEXT_PAIRS = Object.freeze([
  ...TEXT_TOKENS.flatMap((fg) => TEXT_SURFACES.map((bg) => [fg, bg])),
  ["white", "cobalt"],
  ["white", "cobaltHover"],
]);

const channel = (value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex) => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new TypeError(`Expected a #RRGGBB colour, got ${hex}`);
  const n = Number.parseInt(match[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// WCAG 2.x contrast ratio between two #RRGGBB colours (order-independent).
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
