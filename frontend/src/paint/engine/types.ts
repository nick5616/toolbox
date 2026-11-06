// Paint+ engine contract (Phase 19, SPEC §2.3). FROZEN in Wave 0: P1
// implements it, P5/P6/P2 consume it. src/paint/** never imports src/tools/**
// (architecture.test.ts) and holds no React.
//
// Determinism: a stroke replayed with the same points, brush and seed gives
// the same pixels. No Math.random, Date or performance.now in brush, Lab or
// compositor math; time comes in through InputPoint.t.

import type { BrushPreset } from "../brushes/schema";
import type { PaintDoc, PaintLayer } from "@/lib/api";

export type { PaintDoc, PaintLayer };

export const TILE = 512;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PointerKind = "pen" | "mouse" | "touch";

/** One input sample in canvas pixels (the view transform already applied). */
export interface InputPoint {
  x: number;
  y: number;
  /** 0..1; mice report simulated pressure (velocity) unless turned off. */
  pressure: number;
  /** Degrees, -90..90. */
  tiltX: number;
  tiltY: number;
  /** Degrees, 0..359. */
  twist: number;
  /** Milliseconds from the stroke's first point. */
  t: number;
  pointer: PointerKind;
}

export type BlendMode = PaintLayer["blend"];

export interface LayerProps {
  name: string;
  hidden: boolean;
  locked: boolean;
  alphaLock: boolean;
  clip: boolean;
  reference: boolean;
  opacity: number;
  blend: BlendMode;
}

/** What the current tool is; the engine routes input by it. */
export type ToolState =
  | { kind: "brush"; brush: BrushPreset; color: RGBA; secondary: RGBA; seed: number }
  | { kind: "eraser"; brush: BrushPreset; seed: number }
  | { kind: "smudge"; brush: BrushPreset; seed: number }
  | { kind: "lab"; toolId: string; brush: BrushPreset; color: RGBA; params: Record<string, number | string | boolean>; seed: number }
  | { kind: "history"; brush: BrushPreset; source: HistoryId; seed: number }
  | { kind: "mask"; brush: BrushPreset; seed: number }; // perception tools paint a mask first

/** Linear 0..1 straight (non-premultiplied) colour. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type HistoryId = number;

export interface HistoryEntry {
  id: HistoryId;
  label: string;
  /** Tiles touched, for thumbnails and the History brush. */
  bounds: Rect;
  /** False once the memory budget dropped its pixels (shown greyed). */
  available: boolean;
}

export interface StrokeResult {
  history: HistoryId | null; // null when the stroke changed nothing
  bounds: Rect;
  /** The stroke's mask (mask/perception tools): alpha in the stroke's bounds. */
  mask?: ImageData;
}

/** Loads tile PNGs on demand (Go: PaintService.Tiles). */
export interface TileSource {
  load(layerId: string, keys: string[]): Promise<Map<string, ImageBitmap>>;
}

export interface SelectionAPI {
  readonly active: boolean;
  bounds(): Rect | null;
  rect(r: Rect, mode?: SelectMode): void;
  ellipse(r: Rect, mode?: SelectMode): void;
  lasso(points: Point[], mode?: SelectMode): void;
  wand(at: Point, opts: { tolerance: number; contiguous: boolean; sampleAll: boolean }, mode?: SelectMode): void;
  fromMask(mask: ImageData, at: Point, mode?: SelectMode): void;
  invert(): void;
  feather(px: number): void;
  grow(px: number): void; // negative shrinks
  clear(): void;
  /** The selection as an alpha mask over the canvas (null = none). */
  mask(): ImageData | null;
}

export type SelectMode = "replace" | "add" | "subtract" | "intersect";

export type TransformMode = "free" | "uniform" | "distort" | "warp";

export interface TransformAPI {
  readonly active: boolean;
  begin(mode: TransformMode): void;
  /** 2×3 affine for free/uniform; 4 corners for distort; 4×4 mesh for warp. */
  set(t: { matrix?: number[]; corners?: Point[]; mesh?: Point[] }): void;
  flip(axis: "h" | "v"): void;
  rotate90(dir: 1 | -1): void;
  commit(resample: "bilinear" | "bicubic"): HistoryId;
  cancel(): void;
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number; // degrees
  flipped: boolean;
}

export interface ViewAPI {
  get(): ViewState;
  set(v: Partial<ViewState>): void;
  fit(): void;
  actual(): void;
  screenToCanvas(p: Point): Point;
  canvasToScreen(p: Point): Point;
}

export type EngineEvent = "change" | "history" | "layers" | "selection" | "view";

export interface PaintEngine {
  readonly doc: Readonly<PaintDoc>;
  /** WebGL2; throws PaintGLError when it isn't available. */
  attach(canvas: HTMLCanvasElement): void;
  detach(): void;
  load(doc: PaintDoc, tiles: TileSource): Promise<void>;
  // input
  beginStroke(tool: ToolState, p: InputPoint): void;
  extendStroke(points: InputPoint[], predicted: InputPoint[]): void;
  endStroke(): StrokeResult;
  cancelStroke(): void;
  // layers
  addLayer(opts?: Partial<LayerProps>, index?: number): string;
  removeLayer(id: string): void;
  moveLayer(id: string, toIndex: number): void;
  setLayer(id: string, p: Partial<LayerProps>): void;
  duplicateLayer(id: string): string;
  mergeDown(id: string): void;
  flatten(): void;
  setActive(id: string): void;
  // selection & transform
  readonly selection: SelectionAPI;
  readonly transform: TransformAPI;
  // pixels in and out (Lab, adjustments, export)
  readRegion(r: Rect, src: "layer" | "merged"): Promise<ImageData>;
  writeRegion(layerId: string, r: Rect, img: ImageBitmap | ImageData, mask?: ImageData, feather?: number, label?: string): HistoryId;
  fill(at: Point, opts: { tolerance: number; sampleAll: boolean; color: RGBA }): HistoryId | null;
  // canvas
  resizeCanvas(w: number, h: number, anchor: Point, background?: RGBA): HistoryId;
  resample(w: number, h: number): HistoryId;
  // history
  undo(): boolean;
  redo(): boolean;
  history(): HistoryEntry[];
  jumpTo(id: HistoryId): void;
  snapshotAt(id: HistoryId, r: Rect): Promise<ImageData>;
  memoryBytes(): number;
  // view
  readonly view: ViewAPI;
  render(): void;
  // saving
  dirtyTiles(): Map<string, Set<string>>;
  markSaved(layerId: string, keys: string[]): void;
  encodeTile(layerId: string, key: string): Promise<Blob | null>; // null = empty (delete it)
  flattenToBitmap(scale: number): Promise<ImageBitmap>;
  on(ev: EngineEvent, cb: () => void): () => void;
}

export class PaintGLError extends Error {
  constructor(message = "Paint+ needs WebGL 2, which this window doesn't have") {
    super(message);
    this.name = "PaintGLError";
  }
}
