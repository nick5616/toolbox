/**
 * What the editor's part windows render (Phase 10, SPEC 5.5 WP-E4): the live
 * preview with a mini transport, and the hooks every replica runs. The parts
 * themselves (`<moduleId>.preview`, `<moduleId>.panel`) are defined by the
 * editor workspace (`workspace.tsx`); a part window holds replicas of the
 * editor and focus stores and everything it changes runs on the host.
 */
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary, IconButton } from "@/components";
import { formatMs } from "@/components/media";
import { useShortcut } from "@/lib/shortcuts";
import { EditCanvas } from "@/viz/edit/EditCanvas";
import { editLength, previewSize } from "@/viz/edit/types";
import { PreviewOverlays } from "./overlays/PreviewOverlays";
import { useEditInputs, useEditStudio, useProject } from "./store";
import { frameMs } from "./transport/logic";
import { useEditData } from "./useEditData";
import styles from "./editorParts.module.css";

/**
 * The local playback clock of a replica: the host's playhead patches arrive at
 * most ~60 per second, so while playing the time between them is extrapolated
 * from the arrival. Never steps backwards by patch latency; snaps on seeks.
 */
export function estimateTime(host: { ms: number; elapsedMs: number }, last: number, lengthMs: number): number {
  let t = host.ms + host.elapsedMs;
  if (Math.abs(t - last) < 250) t = Math.max(t, last);
  return lengthMs > 0 ? Math.min(t, lengthMs) : t;
}

/** The time to render: the store's playhead, extrapolated by a local clock while playing. */
export function useLocalClock(): number {
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const playing = useEditStudio((s) => s.playing);
  const length = useEditStudio((s) => (s.history ? editLength(s.history.present) : 0));
  const [t, setT] = useState(playheadMs);
  const last = useRef(playheadMs);
  useEffect(() => {
    if (!playing) {
      last.current = playheadMs;
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const next = estimateTime({ ms: playheadMs, elapsedMs: performance.now() - t0 }, last.current, length);
      last.current = next;
      setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // a new patch restarts the extrapolation from its own time
  }, [playheadMs, playing, length]);
  return playing ? t : playheadMs;
}

const onButton = (e: KeyboardEvent): boolean => e.target instanceof HTMLElement && !!e.target.closest("button, [role=button], a, [role=switch]");

/** Space, arrows and undo/redo in a part window forward to the host (through the bridged actions). */
export function usePartShortcuts(): void {
  useShortcut(
    " ",
    (e) => {
      if (onButton(e)) return;
      e.preventDefault();
      const st = useEditStudio.getState();
      st.setPlaying(!st.playing);
    },
    { preventDefault: false },
  );
  const step = (dir: 1 | -1) => {
    const st = useEditStudio.getState();
    const f = frameMs(st.history?.present.fps ?? 30);
    const frame = Math.round(st.playheadMs / f) + dir;
    st.setPlayhead(Math.max(0, frame * f));
  };
  useShortcut("ArrowLeft", () => step(-1));
  useShortcut("ArrowRight", () => step(1));
  useShortcut("Mod+Z", () => useEditStudio.getState().undo());
  useShortcut(["Mod+Shift+Z", "Mod+Y"], () => useEditStudio.getState().redo());
}

/** Runs in every part window once connected: loads what a replica needs locally (analyses, sources) and forwards keys to the host. */
export function useEditorReplica(): void {
  useEditData();
  usePartShortcuts();
}

/** The live preview of a replica: the canvas and a mini transport that forwards to the host. */
export function PreviewPart() {
  const project = useProject();
  const inputs = useEditInputs();
  const playing = useEditStudio((s) => s.playing);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const timeMs = useLocalClock();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  if (!project) return null;
  const size = previewSize(project.aspect);
  const D = editLength(project);
  return (
    <div className={styles.preview}>
      <section className={styles.stage}>
        <EditCanvas inputs={inputs} width={size.width} height={size.height} timeMs={timeMs} playing={playing} quality="draft" onCanvas={setCanvas} />
        <ErrorBoundary label="The preview overlays" compact>
          <PreviewOverlays canvas={canvas} width={size.width} height={size.height} />
        </ErrorBoundary>
      </section>
      <div className={styles.bar} role="toolbar" aria-label="Transport">
        <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} data-tip="Play or pause the edit in the main window" kbd="Space" onClick={() => useEditStudio.getState().setPlaying(!playing)} />
        <span className={styles.time} aria-label="Time">
          {formatMs(playing ? timeMs : playheadMs)} / {formatMs(D)}
        </span>
      </div>
    </div>
  );
}
