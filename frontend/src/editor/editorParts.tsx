/**
 * The editor's part windows (Phase 10, SPEC 5.5 WP-E4): the live preview and
 * any panel, popped out of a tool. A part window holds replicas of the editor
 * and focus stores (editor/bridge.ts); everything it changes runs on the host.
 */
import { useEffect, useRef, useState } from "react";
import { EmptyState, ErrorBoundary, IconButton } from "@/components";
import { formatMs } from "@/components/media";
import { useShortcut } from "@/lib/shortcuts";
import { currentWindow } from "@/lib/windows";
import { definePart } from "@/parts/registry";
import type { PartProps } from "@/parts/types";
import { useBridgesStatus } from "@/state/bridge";
import { EditCanvas } from "@/viz/edit/EditCanvas";
import { editLength, previewSize } from "@/viz/edit/types";
import { startEditorReplica } from "./bridge";
import { PreviewOverlays } from "./overlays/PreviewOverlays";
import { getEditorPanel, panelPartId, previewPartId } from "./panels";
import type { EditorProfile } from "./profile";
import { EditorProfileProvider } from "./profileContext";
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

function Waiting() {
  return <div className={styles.waiting}>Connecting…</div>;
}

/** Whether the replica has the project (the shell only renders parts once the bridge is live). */
function useReplicaReady(): boolean {
  const status = useBridgesStatus();
  const open = useEditStudio((s) => s.history !== null);
  return status === "live" && open;
}

export function PreviewPart({ profile }: { profile: EditorProfile }) {
  useEditData();
  usePartShortcuts();
  const ready = useReplicaReady();
  const project = useProject();
  const inputs = useEditInputs();
  const playing = useEditStudio((s) => s.playing);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const timeMs = useLocalClock();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  if (!ready || !project) return <Waiting />;
  const size = previewSize(project.aspect);
  const D = editLength(project);
  return (
    <EditorProfileProvider profile={profile}>
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
    </EditorProfileProvider>
  );
}

export function PanelPart({ profile }: { profile: EditorProfile }) {
  useEditData();
  usePartShortcuts();
  const ready = useReplicaReady();
  const id = currentWindow().params.get("panel") ?? "";
  const panel = getEditorPanel(id);
  if (!panel) return <EmptyState icon="circle-alert" title="Nothing to show here" body="This panel doesn't exist." />;
  if (!ready) return <Waiting />;
  const Panel = panel.component;
  return (
    <EditorProfileProvider profile={profile}>
      <div className={styles.panel}>
        <ErrorBoundary label={panel.title} resetKey={id}>
          <Panel />
        </ErrorBoundary>
      </div>
    </EditorProfileProvider>
  );
}

/** Defines `<moduleId>.preview` and `<moduleId>.panel` for a tool's profile. */
export function makeEditorParts(moduleId: string, profile: EditorProfile): void {
  const connect = (): Promise<() => void> => Promise.resolve(startEditorReplica(moduleId));
  definePart({
    id: previewPartId(moduleId),
    host: moduleId,
    title: "Preview",
    icon: "monitor-play",
    tip: "The live preview of the open project",
    width: 960,
    height: 600,
    component: function Preview(_p: PartProps) {
      return <PreviewPart profile={profile} />;
    },
    connect,
  });
  definePart({
    id: panelPartId(moduleId),
    host: moduleId,
    title: "Panel",
    icon: "panel-right",
    headingFor: (params) => {
      const panel = getEditorPanel(params.get("panel") ?? "");
      return panel ? { title: panel.title, icon: panel.icon } : null;
    },
    tip: "A panel of the open project",
    width: 380,
    height: 720,
    component: function Panel(_p: PartProps) {
      return <PanelPart profile={profile} />;
    },
    connect,
  });
}
