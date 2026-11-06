/**
 * Paint+'s own icon set (SPEC §1.5): 24 px grid, 1.6 stroke, round caps.
 * Generic actions (close, check, chevrons) live here too, so the editor never
 * depends on the shared icon registry. Unknown names fall back to the flask,
 * so a Lab tool whose icon isn't drawn yet still gets one.
 */
import type { ReactNode } from "react";

const S = (children: ReactNode) => children;

/** Name → SVG children on a 24 × 24 grid (stroke = currentColor, fill none unless stated). */
export const PAINT_ICONS: Record<string, ReactNode> = {
  brush: S(
    <>
      <path d="M14.5 4.5c1.6-1.6 4.2-1.6 5 0s.3 3.4-1.3 5L12 15.7 8.3 12z" />
      <path d="M8.3 12c-2.4.2-3.8 1.7-3.8 3.6 0 1.6-.8 2.9-2 3.9 3.3.9 8.5.7 9.7-3.8" />
    </>,
  ),
  smudge: S(
    <>
      <path d="M9 11.5V6a1.7 1.7 0 0 1 3.4 0v4.2" />
      <path d="M12.4 9.5a1.7 1.7 0 0 1 3.4 0v1.3a1.7 1.7 0 0 1 3.4.2V15a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.7-2.3L4.8 15.6a1.7 1.7 0 0 1 2.6-2.2L9 15" />
    </>,
  ),
  eraser: S(
    <>
      <path d="M8.6 20H19" />
      <path d="M4.3 14.8 13.6 5.5a2 2 0 0 1 2.8 0l3.1 3.1a2 2 0 0 1 0 2.8L11.6 19.3a2 2 0 0 1-1.4.6H8.5a2 2 0 0 1-1.4-.6l-2.8-2.8a2 2 0 0 1 0-1.7z" />
      <path d="m10 9 5 5" />
    </>,
  ),
  layers: S(
    <>
      <path d="m12 3.5 8.5 4.6L12 12.7 3.5 8.1z" />
      <path d="m3.5 12.1 8.5 4.6 8.5-4.6" />
      <path d="m3.5 16.1 8.5 4.6 8.5-4.6" />
    </>,
  ),
  adjust: S(
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 3.8v16.4" />
      <path d="M12 3.8a8.2 8.2 0 0 1 0 16.4" fill="currentColor" stroke="none" />
    </>,
  ),
  select: S(
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M12 9v6M9 12h6" />
    </>,
  ),
  transform: S(
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1" />
      <circle cx="4.5" cy="4.5" r="1.5" />
      <circle cx="19.5" cy="4.5" r="1.5" />
      <circle cx="4.5" cy="19.5" r="1.5" />
      <circle cx="19.5" cy="19.5" r="1.5" />
    </>,
  ),
  wrench: S(
    <path d="M14.7 6.3a4 4 0 0 0 5 5L21 12.6a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0L3 11.4a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0z M8 12.5 12.5 8" />,
  ),
  gallery: S(
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1.8" />
    </>,
  ),
  color: S(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>,
  ),
  flask: S(
    <>
      <path d="M9.5 3.5h5M10.5 3.5v5.3L5 18.4A1.8 1.8 0 0 0 6.6 21h10.8a1.8 1.8 0 0 0 1.6-2.6l-5.5-9.6V3.5" />
      <path d="M7.8 15.2h8.4" />
    </>,
  ),
  symmetry: S(
    <>
      <path d="M12 3v18" strokeDasharray="2 2.4" />
      <path d="M9 7 4 12l5 5z" />
      <path d="m15 7 5 5-5 5z" />
    </>,
  ),
  guides: S(
    <>
      <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
    </>,
  ),
  history: S(
    <>
      <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.6" />
      <path d="M3.8 4.2v4.4h4.4" />
      <path d="M12 7.6V12l3 2" />
    </>,
  ),
  undo: S(
    <>
      <path d="M9 6 4.5 10.5 9 15" />
      <path d="M4.5 10.5H14a5.5 5.5 0 0 1 0 11h-2" />
    </>,
  ),
  redo: S(
    <>
      <path d="M15 6l4.5 4.5L15 15" />
      <path d="M19.5 10.5H10a5.5 5.5 0 0 0 0 11h2" />
    </>,
  ),
  eyedropper: S(
    <>
      <path d="m14 6 4 4M16.6 3.4a2.1 2.1 0 0 1 3 3L17.5 8.5l-4-4z" />
      <path d="m13 6.2-8.2 8.2a2 2 0 0 0-.6 1.4V19.8h4a2 2 0 0 0 1.4-.6L17.8 11" />
    </>,
  ),
  fill: S(
    <>
      <path d="m5 11 6.5-6.5a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L12 18a2 2 0 0 1-2.8 0L5 13.8a2 2 0 0 1 0-2.8z" />
      <path d="M3.5 11.5h14.8" />
      <path d="M20 14.5s1.6 2 1.6 3.2a1.6 1.6 0 0 1-3.2 0c0-1.2 1.6-3.2 1.6-3.2z" />
    </>,
  ),
  wand: S(
    <>
      <path d="m5 19 9.5-9.5" />
      <path d="m13.5 6.5 4 4" />
      <path d="M18 3v3M16.5 4.5h3M6 5v2M5 6h2M19 14v2M18 15h2" />
    </>,
  ),
  lasso: S(
    <>
      <path d="M12 4C7 4 3.5 6.5 3.5 10s3.5 6 8.5 6 8.5-2.5 8.5-6-3.5-6-8.5-6z" />
      <path d="M8 15.6c-.3 2.2-1.2 3.4-3 4.4" />
    </>,
  ),
  rect: S(<rect x="4" y="6" width="16" height="12" rx="1" strokeDasharray="3 2.5" />),
  ellipse: S(<ellipse cx="12" cy="12" rx="8.5" ry="6.5" strokeDasharray="3 2.5" />),
  plus: S(<path d="M12 5v14M5 12h14" />),
  minus: S(<path d="M5 12h14" />),
  close: S(<path d="m6 6 12 12M18 6 6 18" />),
  check: S(<path d="m5 12.5 4.5 4.5L19 7.5" />),
  chevron: S(<path d="m9 6 6 6-6 6" />),
  chevronDown: S(<path d="m6 9 6 6 6-6" />),
  more: S(
    <>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
    </>,
  ),
  expand: S(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />),
  shrink: S(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />),
  import: S(<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14" />),
  export: S(<path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5M5 19.5h14" />),
  copy: S(
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>,
  ),
  eye: S(
    <>
      <path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>,
  ),
  eyeOff: S(
    <>
      <path d="M9.9 6.1A8 8 0 0 1 12 5.8c6 0 9.2 6.2 9.2 6.2a15 15 0 0 1-2.4 3.1M6.3 7.7A14.6 14.6 0 0 0 2.8 12S6 18.2 12 18.2a8.4 8.4 0 0 0 3.8-.9" />
      <path d="m3.5 3.5 17 17" />
    </>,
  ),
  lock: S(
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>,
  ),
  unlock: S(
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
    </>,
  ),
  trash: S(<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v6M14 11v6" />),
  duplicate: S(
    <>
      <rect x="4" y="4" width="11" height="11" rx="2" />
      <rect x="9" y="9" width="11" height="11" rx="2" />
    </>,
  ),
  merge: S(<path d="M6 4v6a4 4 0 0 0 4 4h4M18 4v6a4 4 0 0 1-4 4v6m0 0-2.5-2.5M14 20l2.5-2.5" />),
  flatten: S(
    <>
      <path d="m12 5 8.5 4.5L12 14 3.5 9.5z" />
      <path d="M3.5 17h17" />
    </>,
  ),
  clip: S(
    <>
      <path d="M12 3.5v8" />
      <path d="m8.5 8 3.5 3.5L15.5 8" />
      <rect x="4.5" y="14" width="15" height="6" rx="1.5" />
    </>,
  ),
  alphaLock: S(
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M4 12h16M12 4v16" strokeDasharray="1.6 2.4" />
    </>,
  ),
  reference: S(
    <>
      <path d="M6 20V4.5l12 4-12 4" />
    </>,
  ),
  rename: S(<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z M14.5 7.5l3 3" />),
  size: S(<path d="M5 19 19 5M5 19v-5M5 19h5M19 5v5M19 5h-5" />),
  star: S(<path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4L12 16.2 7.2 18.9l1-5.4-4-3.8 5.4-.7z" />),
  dice: S(
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </>,
  ),
  seedlock: S(
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <circle cx="12" cy="15.3" r="1.3" fill="currentColor" stroke="none" />
    </>,
  ),
  info: S(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.1" />
    </>,
  ),
  warning: S(<path d="M12 4.5 21 19.5H3zM12 10v4.5M12 17v.1" />),
  hand: S(<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6 6 6 0 0 1-5-2.7L4 14.5a1.5 1.5 0 0 1 2.4-1.7L8 15" />),
  image: S(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.7" />
      <path d="m4 18 5.5-5 4 3.5 3-2.5 3.5 3.5" />
    </>,
  ),
  canvas: S(
    <>
      <rect x="3" y="6" width="18" height="12" rx="1.5" />
      <path d="M3 3.5h18M3 20.5h18" strokeDasharray="2 2.4" />
    </>,
  ),
  sparkle: S(<path d="M12 3.5 14 10l6.5 2L14 14l-2 6.5L10 14l-6.5-2L10 10zM19 3v3M17.5 4.5h3" />),
  // Lab tools (algorithmic)
  flow: S(<path d="M3.5 8c3-3 5 3 8.5 0s5 3 8.5 0M3.5 13c3-3 5 3 8.5 0s5 3 8.5 0M3.5 18c3-3 5 3 8.5 0s5 3 8.5 0" />),
  growth: S(
    <>
      <path d="M12 21v-9m0 0c0-3.5-2.5-5-5.5-5.5 0 3.2 2 5.2 5.5 5.5zm0-3c0-3 2-5 5-5.2 0 3-1.8 4.8-5 5.2z" />
      <path d="M12 12c-2 0-3.6.8-4.5 2.2" />
    </>,
  ),
  reaction: S(
    <>
      <circle cx="8" cy="8" r="3" />
      <circle cx="16.5" cy="9" r="2" />
      <circle cx="10" cy="16.5" r="2.2" />
      <circle cx="17" cy="17" r="3" />
    </>,
  ),
  ink: S(<path d="M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.300 6-10.500 6-10.500zM9.500 14.500a2.600 2.600 0 0 0 2.500 2.500" />),
  particles: S(
    <>
      <circle cx="6" cy="7" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="13" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="18" cy="10" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="9" cy="13" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none" />
    </>,
  ),
  sort: S(<path d="M5 6h4M5 10h8M5 14h12M5 18h6M19 5v12m0 0-2.500-2.500M19 17l2.500-2.500" />),
  smear: S(<path d="M4 15c3-6 6-6 9-2s4 .5 7-5M4 19c3-3 6-3 9-1s4 0 7-3" />),
  feedback: S(
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <rect x="7" y="7" width="10" height="10" rx="1.4" />
      <rect x="10" y="10" width="4" height="4" rx=".8" />
    </>,
  ),
  echo: S(
    <>
      <circle cx="8" cy="12" r="4" />
      <circle cx="13" cy="12" r="4" opacity=".6" />
      <circle cx="18" cy="12" r="4" opacity=".3" />
    </>,
  ),
  voronoi: S(<path d="M4 8.500 10 6l5 3 5-2M10 6V3.500M15 9l-1 5-5 2.500L4 15M14 14l5 3.500M9 16.500V21" />),
  kaleido: S(
    <>
      <path d="M12 3.500 19.500 8v8L12 20.500 4.500 16V8z" />
      <path d="M12 3.500v17M4.500 8l15 8M19.500 8l-15 8" />
    </>,
  ),
  glitch: S(<path d="M4 7h10M8 11h12M4 15h7M13 15h7M7 19h9" />),
  pixel: S(
    <>
      <rect x="4" y="4" width="6" height="6" />
      <rect x="14" y="4" width="6" height="6" />
      <rect x="9" y="14" width="6" height="6" />
    </>,
  ),
  halftone: S(
    <>
      <circle cx="7" cy="7" r="2.200" />
      <circle cx="17" cy="7" r="1.200" />
      <circle cx="7" cy="17" r="1.200" />
      <circle cx="17" cy="17" r="2.200" />
      <circle cx="12" cy="12" r="1.700" />
    </>,
  ),
  // Lab tools (perception)
  dissolve: S(
    <>
      <circle cx="10" cy="11" r="5.500" />
      <circle cx="17.500" cy="7" r="1.300" fill="currentColor" stroke="none" />
      <circle cx="19" cy="13" r=".9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="18" r="1.100" fill="currentColor" stroke="none" />
      <circle cx="6" cy="19" r=".8" fill="currentColor" stroke="none" />
    </>,
  ),
  melt: S(<path d="M5 5h14v5c0 2-1.200 2-1.200 4s-1.800 2-1.800 4-2 2-2 0v-3c0-1-1.500-1-1.500 1v3c0 1.800-2 1.800-2 0V14c0-1.200-1.500-1.200-1.500 0V10H5z" />),
  fillEraser: S(
    <>
      <path d="M4 15 13 6a2 2 0 0 1 2.800 0l2.200 2.200a2 2 0 0 1 0 2.800L11 18H6z" />
      <path d="M14 20h6M17 17v6" />
    </>,
  ),
  edge: S(<path d="M5 5h14v14H5zM9 9h6v6H9z" strokeDasharray="2 2" />),
  subject: S(
    <>
      <circle cx="12" cy="8.500" r="3.200" />
      <path d="M5.500 20c.6-4 3-6 6.500-6s5.900 2 6.500 6" />
      <path d="M3.500 3.500h3M20.500 3.500h-3M3.500 20.500h3M20.500 20.500h-3" />
    </>,
  ),
  object: S(
    <>
      <path d="M4 5h10a3 3 0 0 1 3 3v9H7a3 3 0 0 1-3-3z" strokeDasharray="3 2" />
      <path d="m15 14 5.500 3-2.300.8 1.300 2.500-1.300.7-1.300-2.500L15 20z" fill="currentColor" stroke="none" />
    </>,
  ),
  enhance: S(
    <>
      <path d="M4 20 20 4" />
      <path d="M14.500 4H20v5.500" />
      <path d="M4 14v6h6" />
      <path d="M4 9.500V4h5.500" opacity=".35" />
    </>,
  ),
  extend: S(
    <>
      <rect x="3.500" y="6" width="11" height="12" rx="1.500" />
      <path d="M17.500 8.500h3M17.500 12h3M17.500 15.500h3" strokeDasharray="1.600 2" />
    </>,
  ),
  historyBrush: S(
    <>
      <path d="M14 4.500c1.500-1.500 4-1.500 5 0s.2 3.300-1.300 4.800L12 15 9 12z" />
      <path d="M3.500 12.500a6 6 0 1 0 1.800-4.200L3.500 10M3.500 6.500V10h3.500" />
    </>,
  ),
};

PAINT_ICONS.bulge = S(
  <>
    <circle cx="12" cy="12" r="3.500" />
    <circle cx="12" cy="12" r="7" opacity=".6" />
    <circle cx="12" cy="12" r="10" opacity=".3" />
  </>,
);
PAINT_ICONS.twirl = S(<path d="M12 12c0-1.500 2-1.500 2 0s-3 2.500-4 0 1-5 4-5 6 3 6 6-3 7-8 7-8-4-8-8" />);
PAINT_ICONS.wave = S(<path d="M3 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0" />);

/** Lab tools name their icons in kebab-case; these are the ones drawn under a different name. */
const ALIASES: Record<string, string> = {
  "echo-fill": "echo",
  "echo-trail": "echo",
  "edge-erode": "edge",
  "enhance-brush": "enhance",
  "extend-canvas": "extend",
  "upscale-canvas": "enhance",
  "flow-field": "flow",
  "ink-bleed": "ink",
  "pixel-sort": "sort",
  "reaction-diffusion": "reaction",
  "select-object": "object",
  "select-subject": "subject",
  "subject-stamp": "subject",
  "history-brush": "historyBrush",
  chromatic: "glitch",
  vhs: "glitch",
  pixelate: "pixel",
  posterize: "halftone",
  duotone: "adjust",
  mirror: "symmetry",
};

/** The drawn icon a (possibly kebab-case or aliased) name stands for, or "" when there isn't one. */
export function resolveIconName(name: string): string {
  if (hasOwn(name)) return name;
  const alias = ALIASES[name];
  if (alias) return alias;
  const camel = name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return hasOwn(camel) ? camel : "";
}

function hasOwn(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAINT_ICONS, name);
}

export function hasPaintIcon(name: string): boolean {
  return resolveIconName(name) !== "";
}

export interface PaintIconProps {
  name: string;
  size?: number;
  className?: string;
}

export function PaintIcon({ name, size = 20, className }: PaintIconProps) {
  const resolved = resolveIconName(name);
  const known = resolved !== "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-icon={known ? resolved : "flask"}
    >
      {PAINT_ICONS[known ? resolved : "flask"]}
    </svg>
  );
}
