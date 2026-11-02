// Framing maths for Post Builder slides. Mirrors modules/posts/frame.go
// (cropWindow, rotateImage): the crop window is the largest window of the
// frame's aspect that fits the (rotated) source, divided by zoom, centred at pan.

export interface CropWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The aspect labels as width / height. Matches posts.FrameSize at 1080 wide. */
export function aspectRatio(aspect: string): number {
  switch (aspect) {
    case "1:1":
      return 1;
    case "3:4":
      return 1080 / 1440;
    case "1.91:1":
      return 1080 / 566;
    case "9:16":
      return 1080 / 1920;
    default:
      return 1080 / 1350; // "4:5"
  }
}

/** Output frame at 1080 wide (posts.FrameSize). */
export function frameSize(aspect: string): { w: number; h: number } {
  switch (aspect) {
    case "1:1":
      return { w: 1080, h: 1080 };
    case "3:4":
      return { w: 1080, h: 1440 };
    case "1.91:1":
      return { w: 1080, h: 566 };
    case "9:16":
      return { w: 1080, h: 1920 };
    default:
      return { w: 1080, h: 1350 };
  }
}

/** Port of cropWindow in frame.go. w/h are the source size, aspect is frame width / height. */
export function cropWindow(w: number, h: number, aspect: number, zoom: number, panX: number, panY: number): CropWindow {
  const z = zoom < 1 ? 1 : zoom;
  let cw: number;
  let ch: number;
  if (w / h > aspect) {
    ch = h;
    cw = h * aspect;
  } else {
    cw = w;
    ch = w / aspect;
  }
  cw /= z;
  ch /= z;
  const px = clamp(panX, -1, 1);
  const py = clamp(panY, -1, 1);
  return { x: (w - cw) / 2 + (px * (w - cw)) / 2, y: (h - ch) / 2 + (py * (h - ch)) / 2, w: cw, h: ch };
}

export type Rotation = 0 | 90 | 180 | 270;

export function normalizeRotation(deg: number): Rotation {
  return ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;
}

export interface FramedLayout {
  /** The rotated source's size. */
  rotW: number;
  rotH: number;
  window: CropWindow;
  /** Percentages of the frame for the box that holds the rotated source. */
  box: { left: number; top: number; width: number; height: number };
  /** Percentages of that box for the unrotated image, centred, before rotating. */
  img: { width: number; height: number };
  rotation: Rotation;
}

/**
 * Where the source goes inside a frame so the crop window fills it. All values
 * are percentages, so it works at any display size.
 */
export function framedLayout(
  srcW: number,
  srcH: number,
  rotation: number,
  aspect: string,
  zoom: number,
  panX: number,
  panY: number,
): FramedLayout {
  const rot = normalizeRotation(rotation);
  const swap = rot === 90 || rot === 270;
  const rotW = swap ? srcH : srcW;
  const rotH = swap ? srcW : srcH;
  const win = cropWindow(rotW, rotH, aspectRatio(aspect), zoom, panX, panY);
  return {
    rotW,
    rotH,
    window: win,
    box: {
      left: (-win.x / win.w) * 100,
      top: (-win.y / win.h) * 100,
      width: (rotW / win.w) * 100,
      height: (rotH / win.h) * 100,
    },
    img: { width: (srcW / rotW) * 100, height: (srcH / rotH) * 100 },
    rotation: rot,
  };
}

/**
 * The new pan after dragging the picture by (dx, dy) screen pixels inside a
 * frame frameW pixels wide. Dragging right moves the window left.
 */
export function panFromDrag(
  start: { panX: number; panY: number },
  layout: FramedLayout,
  dx: number,
  dy: number,
  frameW: number,
): { panX: number; panY: number } {
  const { window: win, rotW, rotH } = layout;
  if (frameW <= 0) return { panX: start.panX, panY: start.panY };
  const scale = frameW / win.w; // screen px per source px
  const slackX = (rotW - win.w) / 2;
  const slackY = (rotH - win.h) / 2;
  const panX = slackX > 0.5 ? start.panX - dx / scale / slackX : start.panX;
  const panY = slackY > 0.5 ? start.panY - dy / scale / slackY : start.panY;
  return { panX: clamp(panX, -1, 1), panY: clamp(panY, -1, 1) };
}

export function clampZoom(z: number): number {
  return clamp(Math.round(z * 100) / 100, 1, 4);
}

/** Width of the crop window in source pixels (a source narrower than 1080 looks soft). */
export function framedWidth(srcW: number, srcH: number, rotation: number, aspect: string, zoom: number): number {
  const rot = normalizeRotation(rotation);
  const swap = rot === 90 || rot === 270;
  return cropWindow(swap ? srcH : srcW, swap ? srcW : srcH, aspectRatio(aspect), zoom, 0, 0).w;
}
