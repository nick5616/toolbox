/**
 * THE SEAM between Paint+'s UI and the modules other packages build
 * (Phase 19, package P5). The UI imports nothing from `@/paint/engine`,
 * `@/paint/lab`, `@/paint/ai` or `@/paint/brushes/library` except types; every
 * runtime dependency goes through `runtime` below.
 *
 * Today `runtime` is wired to fakes (testing/). At integration the architect
 * replaces the marked lines with the real modules:
 *
 *   createEngine      <- createPaintEngine()                 (paint/engine, P1)
 *   attachInput       <- P1's input attach helper (optional: canvasInput.ts is a complete one)
 *   brushLibrary      <- the bundled presets                 (paint/brushes/library, B1)
 *   resolveAsset      <- resolveLibraryAsset                 (paint/brushes/library, B1)
 *   labTools          <- [...ALGORITHMIC_TOOLS, ...PERCEPTION_TOOLS] mapped to LabToolInfo (P2, P6)
 *                        and registerAll(registerLabTool) so the engine can run them
 *   renderBrushStroke <- the engine's stroke-sheet renderer  (P1) or a CPU backend render
 *   createQueue       <- createPerceptionQueue(engine)       (paint/ai, P6)
 *   runPerceptionStroke <- P6's mask/crop building + queue.submit for Fill, Dissolve, Melt, ...
 *   adjustments       <- paint/adjust                        (P1)
 *   applyGuides       <- the engine's guides                 (P1)
 */
import { useCallback, useEffect, useState } from "react";
import { PaintService, type PaintAIModelInfo, type PaintOrigin } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { PerceptionQueue, PendingRegion, GenerationGroup } from "@/paint/ai/types";
import type { BrushPreset } from "@/paint/brushes/schema";
import type { PaintEngine, StrokeResult } from "@/paint/engine/types";
import type { LabParams, LabToolInfo, PerceptionToolInfo } from "@/paint/lab/types";
import { PERCEPTION_TOOLS } from "@/paint/ai/tools";
import { ALGORITHMIC_TOOLS } from "@/paint/lab";
import { attachCanvasInput, type InputController } from "./canvasInput";
import { FAKE_BRUSHES, FAKE_ORIGINS, FAKE_SET_NAMES } from "./testing/fakes";
import { FakeEngine } from "./testing/fakeEngine";
import { renderFakeStroke } from "./testing/fakeStroke";
import { createFakeQueue } from "./testing/fakeQueue";

export interface AdjustmentInfo {
  id: string;
  label: string;
  icon: string;
  available: boolean;
  reason?: string;
}

export interface GuidesState {
  symmetry: "off" | "vertical" | "horizontal" | "quadrant" | "radial";
  radialCount: number;
  grid: boolean;
  perspective: 0 | 1 | 2 | 3;
  isometric: boolean;
}

export const DEFAULT_GUIDES: GuidesState = { symmetry: "off", radialCount: 6, grid: false, perspective: 0, isometric: false };

export interface PerceptionStrokeArgs {
  engine: PaintEngine;
  queue: PerceptionQueue;
  tool: PerceptionToolInfo;
  params: LabParams;
  seed: number;
  result: StrokeResult;
  /** Select object clicks (canvas px). */
  points?: Array<{ x: number; y: number; positive: boolean }>;
}

export interface StrokePreviewOptions {
  /** Pointer samples for the Brush Studio pad; omitted = a built-in S-curve. */
  points?: Array<{ x: number; y: number; pressure: number }>;
  color?: string;
  background?: string;
}

export interface PaintRuntime {
  createEngine(): PaintEngine;
  attachInput(canvas: HTMLCanvasElement, engine: PaintEngine, ctl: InputController): () => void;
  brushLibrary(): BrushPreset[];
  brushSetNames(): Record<string, string>;
  /** Tip and grain image choices for the Brush Studio. */
  assetChoices(kind: "tip" | "grain"): Array<{ value: string; label: string }>;
  labTools(): LabToolInfo[];
  /** Draws a stroke of `brush` into `canvas` (library previews and the Brush Studio pad). */
  renderBrushStroke(brush: BrushPreset, canvas: HTMLCanvasElement, opts?: StrokePreviewOptions): void;
  createQueue(engine: PaintEngine): PerceptionQueue;
  runPerceptionStroke(a: PerceptionStrokeArgs): Promise<void>;
  /** Extend / Upscale canvas (perception, canvas-level). Rejects with a user-facing message when unavailable. */
  extendCanvas(a: { engine: PaintEngine; queue: PerceptionQueue; sides: { left: number; right: number; top: number; bottom: number }; model: "fast" | "best" }): Promise<void>;
  upscaleCanvas(a: { engine: PaintEngine; scale: 2 | 4; inPlace: boolean }): Promise<void>;
  /** One-shot Lab actions with no stroke (Select subject). Rejects with a user-facing message. */
  runLabAction(toolId: string, a: { engine: PaintEngine; queue: PerceptionQueue; points?: Array<{ x: number; y: number; positive: boolean }> }): Promise<void>;
  adjustments(): AdjustmentInfo[];
  applyGuides(engine: PaintEngine, g: GuidesState): void;
  /** Local origin cards used when PaintService.Origins() isn't available (tests, early builds). */
  fallbackOrigins(): PaintOrigin[];
}

const fakeRuntime: PaintRuntime = {
  createEngine: () => new FakeEngine(),
  attachInput: attachCanvasInput,
  brushLibrary: () => FAKE_BRUSHES,
  brushSetNames: () => FAKE_SET_NAMES,
  assetChoices: (kind) => (kind === "tip" ? [{ value: "round", label: "Round" }, { value: "square", label: "Square" }, { value: "lib:leaf-oak.png", label: "Oak leaf" }] : [{ value: "", label: "None" }, { value: "lib:paper.png", label: "Paper" }]),
  // Real P2 + P6 infos (both frozen LabToolInfo); the engine registers the algorithmic ones with registerAll(registerLabTool).
  labTools: () => [...ALGORITHMIC_TOOLS, ...PERCEPTION_TOOLS],
  renderBrushStroke: renderFakeStroke,
  createQueue: createFakeQueue,
  runPerceptionStroke: async ({ queue, tool, result, seed }) => {
    if (!result.history && result.bounds.w === 0) return;
    await queue.submit(tool.id, result.bounds, { op: tool.op as never, model: "fast", passes: 1, ghost: 0, drift: 0, driftDir: "", offset: [0, 0], seed, scale: 2, points: null, source: new ImageData(1, 1) });
  },
  extendCanvas: async () => {
    throw new Error("Extend canvas with fill needs the AI engine to be wired in");
  },
  upscaleCanvas: async () => {
    throw new Error("Upscale canvas needs the AI engine to be wired in");
  },
  runLabAction: async () => {
    throw new Error("This action needs the AI engine to be wired in");
  },
  adjustments: () =>
    ["Hue, saturation, brightness", "Colour balance", "Curves", "Gradient map", "Gaussian blur", "Motion blur", "Sharpen", "Noise", "Liquify"].map((label, i) => ({
      id: ["hsb", "balance", "curves", "gradientmap", "blur", "motionblur", "sharpen", "noise", "liquify"][i] as string,
      label,
      icon: "adjust",
      available: false,
      reason: "Adjustments arrive with the paint engine",
    })),
  applyGuides: () => undefined,
  fallbackOrigins: () => FAKE_ORIGINS,
};

/** The live runtime. The architect swaps fields (or the whole object) at integration; tests call setRuntime. */
export let runtime: PaintRuntime = fakeRuntime;

export function setRuntime(r: Partial<PaintRuntime>): () => void {
  const prev = runtime;
  runtime = { ...runtime, ...r };
  return () => {
    runtime = prev;
  };
}

export type { PendingRegion, GenerationGroup };

// ---- AI status (gates) ----

export interface AIStatus {
  loaded: boolean;
  models: PaintAIModelInfo[];
  error: string;
  refresh(): void;
  /** Why a perception op can't run here ("" = it can). */
  reasonFor(op: string): string;
}

/** One reason per op; an unknown op (status not loaded yet) is not blocked. */
export function reasonFor(models: readonly PaintAIModelInfo[], loaded: boolean, op: string): string {
  if (!loaded) return "";
  const m = models.find((x) => x.tool === op);
  if (!m) return "";
  if (m.ready) return "";
  return m.reason || "The AI engine or its model isn't installed";
}

/**
 * Per-tool readiness from PaintService.AIStatus (the gates). P6 exports its
 * own `useAIStatus`; this one reads the same frozen binding, so the UI doesn't
 * wait for it.
 */
export function useAIStatus(refreshKey: unknown = 0): AIStatus {
  const [models, setModels] = useState<PaintAIModelInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    let cancelled = false;
    PaintService.AIStatus()
      .then((m) => {
        if (cancelled) return;
        setModels(m ?? []);
        setError("");
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(toAppError(e).message);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [n, refreshKey]);
  const refresh = useCallback(() => setN((v) => v + 1), []);
  return { loaded, models, error, refresh, reasonFor: (op) => reasonFor(models, loaded, op) };
}
