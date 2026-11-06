// Perception queue contract (Phase 19, SPEC §1.4.2, §2.5). FROZEN in Wave 0:
// P6 implements it over PaintService.AI/AIResult; P5 renders pending regions
// and the Generations strip from it.

import type { PaintAIRequest } from "@/lib/api";
import type { HistoryId, Rect } from "../engine/types";

export type PendingState = "queued" | "running" | "failed" | "cancelled";

export interface PendingRegion {
  id: string; // local id
  jobId: string; // "" until submitted
  toolId: string;
  bounds: Rect; // canvas px
  state: PendingState;
  progress: number; // 0..1
  message: string;
}

export interface Generation {
  id: string;
  label: string; // "Original", "Pass 3", "Re-roll 2"
  /** Canvas px region it replaces. */
  bounds: Rect;
  /** Small preview (data URL). */
  thumb: string;
  /** The history step that applied it ("" while not applied). */
  history: HistoryId | null;
}

export interface GenerationGroup {
  id: string;
  toolId: string;
  bounds: Rect;
  seed: number;
  generations: Generation[];
  /** Index of the generation currently on the canvas. */
  current: number;
}

export interface PerceptionQueue {
  /** Queues a request over a canvas region; resolves when its result is applied (or rejects). */
  submit(toolId: string, bounds: Rect, req: Omit<PaintAIRequest, "source" | "mask"> & { source: ImageData; mask?: ImageData }): Promise<GenerationGroup>;
  cancel(id: string): void;
  pending(): PendingRegion[];
  groups(): GenerationGroup[]; // newest first, ≤ 8
  choose(groupId: string, index: number): void;
  reroll(groupId: string): Promise<GenerationGroup>;
  on(cb: () => void): () => void;
}
