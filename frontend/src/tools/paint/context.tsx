import { createContext, useContext, useEffect, useState } from "react";
import type { PerceptionQueue } from "@/paint/ai/types";
import type { EngineEvent, PaintEngine } from "@/paint/engine/types";
import type { Saver } from "./save";

export interface EditorContextValue {
  engine: PaintEngine;
  queue: PerceptionQueue;
  projectId: string;
  saver: Saver;
  /** Window width class, for docking decisions. */
  docked: boolean;
  compact: boolean;
  /** Opens the export dialog / other editor-level dialogs. */
  openDialog(d: EditorDialog): void;
  /** Opens another painting (Upscale canvas into a new project). */
  openProject(id: string): void;
}

export type EditorDialog = "export" | "canvasSize" | "imageSize" | "extend" | "upscale" | "newBrush";

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const c = useContext(EditorContext);
  if (!c) throw new Error("useEditor outside the Paint+ editor");
  return c;
}

/** Re-renders when the engine emits any of `events`; returns a version number. */
export function useEngineEvents(engine: PaintEngine, events: EngineEvent[]): number {
  const [v, setV] = useState(0);
  const key = events.join(",");
  useEffect(() => {
    const offs = key.split(",").filter(Boolean).map((e) => engine.on(e as EngineEvent, () => setV((n) => n + 1)));
    return () => offs.forEach((o) => o());
  }, [engine, key]);
  return v;
}

/** Re-renders when the perception queue changes. */
export function useQueueVersion(queue: PerceptionQueue): number {
  const [v, setV] = useState(0);
  useEffect(() => queue.on(() => setV((n) => n + 1)), [queue]);
  return v;
}
