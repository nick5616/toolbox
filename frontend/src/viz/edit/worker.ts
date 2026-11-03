/**
 * Edit Studio export renders inside the export worker (Phase 9 SPEC §12.2).
 * WP-ES3 implements it with encodeFrames (../worker/loop.ts): load the
 * analysis and project, deriveMarkers, compileEdit, an exact FrameProvider on
 * the export URLs, then per frame i: t = i·1000/fps, await prepare(needs(t)),
 * render(t).
 */
import type { PlanForWorker } from "../types";
import type { LoopIO } from "../worker/loop";
import { RenderError } from "../worker/transport";

export async function runEdit(plan: PlanForWorker, forceJpeg: boolean, io: LoopIO): Promise<void> {
  void plan;
  void forceJpeg;
  void io;
  throw new RenderError("Edit Studio exports aren't built yet");
}
