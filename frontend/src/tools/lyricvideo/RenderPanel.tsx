/**
 * The Export panel (formerly the Render step): a short exact preview from a
 * chosen start, then the whole video. Opened by the header's Export button.
 * It submits jobs, so it only opens inline.
 */
import { useMemo } from "react";
import { Banner, Button, Section, Slider } from "@/components";
import { MediaPlayer, formatMs, useMediaSource } from "@/components/media";
import { JobStatus, LyricAction } from "@/lib/api";
import { usePacks } from "@/state/packs";
import { DepsGate } from "@/tools/_kit";
import { useEngineGate } from "./engine";
import { documentIssues, toLines } from "./logic";
import { buildOptions, parseResult, type RememberedLook } from "./options";
import { RunStatus } from "./RunStatus";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import { useJobRun } from "./useJobRun";
import { STEMS_MODEL, componentInstalled } from "./visuals";
import styles from "./LyricVideoView.module.css";

/** What stops a render: the lyric sheet's blocker, or a look that isn't finished. */
export function renderBlocker(blocker: string, look: Pick<RememberedLook, "background" | "backgroundPath" | "visuals">): string {
  if (blocker) return blocker;
  if ((look.background === "image" || look.background === "video") && !look.backgroundPath) return "Choose a background file in the Look panel, or pick another background.";
  if (look.background === "visualizer" && look.visuals.showJson === "") return "Choose a design in the Visuals panel, or pick a classic background.";
  return "";
}

/** The exact rendered preview clip, played back in a video player. */
function PreviewClip({ path }: { path: string }) {
  const media = useMediaSource(path);
  if (media.status === "error") {
    return (
      <Banner tone="danger" title={media.error?.message ?? "Couldn't open the preview"} action={<Button size="sm" onClick={media.retry} data-tip="Try opening the preview clip again">Try again</Button>}>
        {media.error?.hint}
      </Banner>
    );
  }
  if (media.status !== "ready" || !media.source) return <div className={styles.muted}>Opening the preview…</div>;
  return <MediaPlayer source={media.source} kind="video" className={styles.clip} />;
}

export default function RenderPanel() {
  const prefs = useLyricVideo((s) => s.prefs);
  const rows = useLyricVideo((s) => s.rows);
  const meta = useLyricVideo((s) => s.meta);
  const songPath = useLyricVideo((s) => s.songPath);
  const durationMs = useLyricVideo((s) => s.durationMs);
  const hasCover = useLyricVideo((s) => s.hasCover);
  const previewStartMs = useLyricVideo((s) => s.previewStartMs);
  const packs = usePacks((s) => s.list);
  const preview = useJobRun("preview");
  const render = useJobRun("render");
  const gate = useEngineGate("render");
  const look = prefs.look;
  const blocker = renderBlocker(useMemo(() => documentIssues(rows).blocker, [rows]), look);
  const warning = look.background === "blur-cover" || look.background === "cover" ? (hasCover ? "" : "This song has no cover art, so the background falls back to a gradient.") : "";
  const stemsOn = look.visuals.stems && componentInstalled(packs, STEMS_MODEL);
  const maxStart = Math.max(0, durationMs - 1000);
  const busy = preview.busy || render.busy;
  const gated = !!blocker || gate.blocked;
  const previewPath = preview.job?.status === JobStatus.JobDone ? (parseResult(preview.job.resultJson)?.previewPath ?? "") : "";
  const jobPrefs = { ...prefs, look: { ...prefs.look, visuals: { ...prefs.look.visuals, stems: stemsOn } } };

  const onPreview = () => {
    if (!songPath || blocker) return;
    void preview.start([songPath], buildOptions(LyricAction.ActionPreview, jobPrefs, meta, { lines: toLines(rows), previewStartMs: Math.round(previewStartMs) }));
  };
  const onRender = () => {
    if (!songPath || blocker) return;
    void render.start([songPath], buildOptions(LyricAction.ActionRender, jobPrefs, meta, { lines: toLines(rows) }));
  };
  if (!songPath) return null;

  return (
    <div className={styles.renderBody} style={{ padding: "var(--space-4)" }}>
      {blocker && <Banner tone="danger" title={blocker} />}
      {warning && <Banner tone="warn" title={warning} />}
      {gate.needed && <DepsGate moduleId={LYRIC_VIDEO_ID} />}

      <Section label="Preview" tip="Render a short sample with the exact look before the full render">
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel} data-tip="Where in the song the 10 second preview starts">Starts at {formatMs(previewStartMs)}</span>
            <Slider aria-label="Preview start" min={0} max={maxStart} step={500} value={Math.min(previewStartMs, maxStart)} onChange={(ms) => useLyricVideo.getState().setPreviewStartMs(ms)} format={formatMs} />
          </label>
          <div className={styles.buttonRow}>
            <Button icon="play" variant="secondary" onClick={onPreview} loading={preview.busy} disabled={gated || busy} data-tip={blocker || (gated ? "The AI engine isn't installed yet" : busy ? "Wait for the current render to finish" : "Render 10 seconds from the chosen start so you can check the exact result")}>
              Preview 10 s
            </Button>
          </div>
          <RunStatus run={preview} runningLabel="Rendering the preview…" showResult={false} />
          {previewPath && <PreviewClip key={previewPath} path={previewPath} />}
        </div>
      </Section>

      <Section label="Video" tip="Render the finished lyric video">
        <div className={styles.form}>
          <div className={styles.buttonRow}>
            <Button icon="film" onClick={onRender} loading={render.busy} disabled={gated || busy} data-tip={blocker || (gated ? "The AI engine isn't installed yet" : busy ? "Wait for the current render to finish" : "Render the whole video and save it to your Library")}>
              Export video
            </Button>
            <span className={styles.muted} data-tip="An .lrc file with the line times is saved next to the video">Also saves the timings as a .lrc file.</span>
          </div>
          <RunStatus run={render} runningLabel="Rendering the video…" doneLabel="Your lyric video is ready" />
        </div>
      </Section>
    </div>
  );
}
