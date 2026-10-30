/**
 * Visualizer step 4 (SPEC.md §8.4): size, range, audio and background, a 10 s
 * preview from the playhead, and the full render with its result card.
 *
 * Props: `prefs`/`onPrefs` (the host persists them), `onBack` (to Design).
 * Reads the design, analysis and Song Map selection from the Visualizer store.
 */
import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, IconButton, Meter, Section, SegmentedControl, Select, Slider, toast } from "@/components";
import { MediaPlayer, formatMs, useMediaSource } from "@/components/media";
import { FilesService, JobStatus, VisualizerAction, VisualizerMode, type VisualizerOptions } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { copyText } from "@/lib/copy";
import { FileActions } from "@/tools/_kit/FileActions";
import { chooseEncoder } from "@/viz/worker/encoder";
import { validateShow } from "@/viz/validate";
import { ASPECTS, exportBlocker, exportRules, outputSize, type Aspect, type ExportPrefs, type Height } from "./exportPrefs";
import { useVisualizer } from "./store";
import { liveSpeed, parseVizResult, useVizJob, type VizJob } from "./useVizJob";
import styles from "./ExportStep.module.css";

export interface ExportStepProps {
  prefs: ExportPrefs;
  onPrefs(patch: Partial<ExportPrefs>): void;
  onBack?: () => void;
}

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** What this computer's encoder can do: 2160p and whether rendering falls back to JPEG frames. */
export function useEncoderSupport(fps: number): { can2160: boolean; jpeg: boolean; checked: boolean } {
  const [s, setS] = useState({ can2160: false, jpeg: false, checked: false });
  useEffect(() => {
    let off = false;
    void (async () => {
      const [hd, uhd] = await Promise.all([chooseEncoder(1920, 1080, fps, false), chooseEncoder(3840, 2160, fps, false)]);
      if (!off) setS({ can2160: uhd.kind === "h264", jpeg: hd.kind === "jpeg", checked: true });
    })().catch(() => !off && setS({ can2160: false, jpeg: true, checked: true }));
    return () => {
      off = true;
    };
  }, [fps]);
  return s;
}

function PreviewClip({ path }: { path: string }) {
  const media = useMediaSource(path);
  if (media.status === "error") {
    return (
      <Banner tone="danger" title={media.error?.message ?? "Couldn't open the preview"} action={<Button size="sm" onClick={media.retry}>Try again</Button>}>
        {media.error?.hint}
      </Banner>
    );
  }
  if (media.status !== "ready" || !media.source) return <div className={styles.muted}>Opening the preview…</div>;
  return <MediaPlayer source={media.source} kind="video" className={styles.clip} />;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Progress({ run, label, rangeSec, outFps }: { run: VizJob; label: string; rangeSec: number; outFps: number }) {
  const { job, error } = run;
  const running = !!job && (job.status === JobStatus.JobRunning || job.status === JobStatus.JobQueued);
  const now = useNow(running);
  if (error) {
    return (
      <Banner tone="danger" title={error.message}>
        {error.hint}
      </Banner>
    );
  }
  if (!job) return null;
  if (running) {
    const queued = job.status === JobStatus.JobQueued;
    const speed = queued ? null : liveSpeed(job.progress, job.startedAt, now, rangeSec, outFps);
    return (
      <div className={styles.run} role="status" aria-live="polite">
        <div className={styles.runHead}>
          <span>{queued ? "Waiting to start…" : label}</span>
          <Button size="sm" variant="ghost" onClick={run.cancel}>
            Cancel
          </Button>
        </div>
        <Meter value={queued ? 0 : job.progress} status={queued ? "queued" : "running"} label={label} />
        <div className={styles.runMsg}>
          {job.message}
          {speed && <span className={styles.speed}> {Math.round(speed.fps)} fps · ×{speed.times.toFixed(1)} real time</span>}
        </div>
      </div>
    );
  }
  if (job.status === JobStatus.JobFailed) {
    return (
      <Banner tone="danger" title={job.error || "That didn't work"}>
        {job.errorHint}
      </Banner>
    );
  }
  if (job.status === JobStatus.JobCancelled) return <Banner tone="info" title="Cancelled" />;
  return null;
}

function ResultCard({ job }: { job: NonNullable<VizJob["job"]> }) {
  const result = parseVizResult(job.resultJson);
  const outputs = result?.outputs?.length ? result.outputs : job.outputs.map((o) => o.path);
  return (
    <div className={styles.result} aria-label="Result">
      <div className={styles.resultHead}>
        <Icon name="check" size={14} />
        <span>Your video is ready</span>
        {result && result.speed > 0 && <span className={styles.muted}>rendered ×{result.speed.toFixed(1)} real time</span>}
      </div>
      <ul className={styles.resultList}>
        {outputs.map((path) => {
          const out = job.outputs.find((o) => o.path === path);
          return (
            <li key={path} className={styles.resultRow}>
              <Icon name="film" size={14} />
              <span className={styles.resultName} title={path}>
                {base(path)}
              </span>
              <FileActions outputId={out?.id} path={path} disabled={out?.missing} />
              <IconButton size="sm" icon="copy" label="Copy path" onClick={() => void copyText(path, { what: "path" })} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function ExportStep({ prefs, onPrefs, onBack }: ExportStepProps) {
  const input = useVisualizer((s) => s.input);
  const mode = useVisualizer((s) => s.mode);
  const show = useVisualizer((s) => s.show);
  const ref = useVisualizer((s) => s.ref);
  const analysis = useVisualizer((s) => s.analysis);
  const analyze = useVisualizer((s) => s.analyze);
  const selection = useVisualizer((s) => s.selection);
  const playheadMs = useVisualizer((s) => s.playheadMs);
  const renderSeed = useVisualizer((s) => s.renderSeed);

  const enc = useEncoderSupport(prefs.fps);
  const hasStems = !!ref?.summary.hasStems;
  const rules = exportRules(mode, hasStems, enc.can2160);
  const durationMs = analysis?.durationMs ?? ref?.summary.durationMs ?? 0;

  const [range, setRange] = useState<"whole" | "selection">(selection ? "selection" : "whole");
  const useSel = range === "selection" && !!selection;
  const startMs = useSel ? selection.startMs : 0;
  const endMs = useSel ? selection.endMs : 0;
  const rangeSec = ((useSel ? endMs : durationMs) - startMs) / 1000;
  const [previewStart, setPreviewStart] = useState(Math.max(0, Math.min(playheadMs, Math.max(0, durationMs - 1000))));
  const [previewPath, setPreviewPath] = useState("");

  // A 2160p choice that this computer can't encode falls back.
  useEffect(() => {
    if (enc.checked && prefs.height === 2160 && !enc.can2160) onPrefs({ height: 1440 });
  }, [enc.checked, enc.can2160, prefs.height, onPrefs]);
  // Instrumental needs stems.
  useEffect(() => {
    if (prefs.audio === "instrumental" && !hasStems) onPrefs({ audio: "original" });
  }, [hasStems, prefs.audio, onPrefs]);

  const preview = useVizJob((job) => {
    const r = parseVizResult(job.resultJson);
    if (r?.previewPath) setPreviewPath(r.previewPath);
  });
  const render = useVizJob();
  const busy = preview.busy || render.busy;

  const problem = useMemo(() => {
    if (!show) return "There is no design yet.";
    const v = validateShow(show);
    return v.ok ? "" : `This design couldn't be read: ${v.problem}`;
  }, [show]);
  const blocker = problem || (!input || !ref ? "Analyze a song first." : "") || exportBlocker(prefs, mode);
  const size = outputSize(prefs.aspect, prefs.height);

  const options = (action: VisualizerAction): VisualizerOptions => ({
    action,
    analyze,
    analysisKey: ref?.key ?? "",
    showJson: JSON.stringify(show),
    mode: mode === "overlay" ? VisualizerMode.ModeOverlay : VisualizerMode.ModeFull,
    aspect: prefs.aspect,
    height: prefs.height,
    fps: prefs.fps,
    startMs: action === VisualizerAction.ActionRender ? startMs : 0,
    endMs: action === VisualizerAction.ActionRender ? endMs : 0,
    audio: prefs.audio,
    background: mode === "full" ? prefs.background : "none",
    backgroundPath: mode === "full" && (prefs.background === "image" || prefs.background === "video") ? prefs.backgroundPath : "",
    previewStartMs: action === VisualizerAction.ActionPreview ? Math.round(previewStart) : 0,
    seed: renderSeed,
  });

  const go = (run: VizJob, action: VisualizerAction) => {
    if (!input || blocker) return;
    setPreviewPath("");
    void run.start([input], options(action));
  };

  const pickBackground = async (kind: "image" | "video") => {
    try {
      const paths = (await FilesService.PickWith(kind === "image" ? "Choose a background image" : "Choose a background video", kind === "image" ? IMAGE_EXTS : VIDEO_EXTS, false)) ?? [];
      if (paths[0]) onPrefs({ background: kind, backgroundPath: paths[0] });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const maxStart = Math.max(0, durationMs - 1000);

  return (
    <div className={styles.root}>
      {blocker && <Banner tone="warn" title={blocker} />}
      {enc.checked && enc.jpeg && <Banner tone="info" title="This computer can't encode video in the window, so rendering will be slower." />}

      <Section label="Size">
        <div className={styles.form}>
          {rules.showAspect ? (
            <div className={styles.field}>
              <span className={styles.label}>Shape</span>
              <SegmentedControl size="sm" aria-label="Aspect" value={prefs.aspect} onChange={(aspect: Aspect) => onPrefs({ aspect })} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
            </div>
          ) : (
            <p className={styles.muted}>The picture keeps the video's shape.</p>
          )}
          <div className={styles.field}>
            <span className={styles.label}>Quality</span>
            <SegmentedControl
              size="sm"
              aria-label="Quality"
              value={String(prefs.height)}
              onChange={(h) => onPrefs({ height: Number(h) as Height })}
              options={[720, 1080, 1440, 2160].map((h) => ({ value: String(h), label: `${h}p`, disabled: h === 2160 && !rules.heights.includes(2160) }))}
            />
            {rules.showAspect && (
              <span className={styles.muted}>
                {size.w}×{size.h}
              </span>
            )}
          </div>
          {rules.showFps ? (
            <div className={styles.field}>
              <span className={styles.label}>Frame rate</span>
              <SegmentedControl size="sm" aria-label="Frame rate" value={String(prefs.fps)} onChange={(f) => onPrefs({ fps: Number(f) as 30 | 60 })} options={[{ value: "30", label: "30 fps" }, { value: "60", label: "60 fps" }]} />
            </div>
          ) : (
            <p className={styles.muted}>The frame rate follows the video.</p>
          )}
        </div>
      </Section>

      <Section label="Range">
        <div className={styles.form}>
          <SegmentedControl
            size="sm"
            aria-label="Range"
            value={useSel ? "selection" : "whole"}
            onChange={setRange}
            options={[
              { value: "whole", label: "Whole song" },
              { value: "selection", label: selection ? `Selection ${formatMs(selection.startMs)}–${formatMs(selection.endMs)}` : "Selection", disabled: !selection },
            ]}
          />
          {!selection && <p className={styles.muted}>Shift-drag on the Song Map in Design to pick a part.</p>}
        </div>
      </Section>

      <Section label="Sound and background">
        <div className={styles.form}>
          <div className={styles.field}>
            <span className={styles.label}>Audio</span>
            <SegmentedControl size="sm" aria-label="Audio" value={prefs.audio} onChange={(audio) => onPrefs({ audio })} options={[{ value: "original", label: "Original" }, { value: "instrumental", label: "Instrumental", disabled: !rules.instrumentalAllowed }]} />
            {!rules.instrumentalAllowed && <span className={styles.muted}>Needs the instruments separated.</span>}
          </div>
          {rules.showBackground && (
            <div className={styles.field}>
              <span className={styles.label}>Background</span>
              <Select
                size="sm"
                aria-label="Background"
                value={prefs.background}
                onChange={(b) => {
                  if (b === "image" || b === "video") void pickBackground(b);
                  else onPrefs({ background: b, backgroundPath: "" });
                }}
                options={[
                  { value: "none", label: "None" },
                  { value: "cover", label: "Cover art" },
                  { value: "image", label: "Image…" },
                  { value: "video", label: "Video…" },
                ]}
              />
              {(prefs.background === "image" || prefs.background === "video") && prefs.backgroundPath && (
                <button type="button" className={styles.linkBtn} title={prefs.backgroundPath} onClick={() => void pickBackground(prefs.background as "image" | "video")}>
                  {base(prefs.backgroundPath)}
                </button>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section label="Preview">
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>Starts at {formatMs(previewStart)}</span>
            <Slider aria-label="Preview start" min={0} max={maxStart} step={500} value={Math.min(previewStart, maxStart)} onChange={setPreviewStart} format={formatMs} />
          </label>
          <div className={styles.row}>
            <Button icon="play" variant="secondary" loading={preview.busy} disabled={!!blocker || busy} onClick={() => go(preview, VisualizerAction.ActionPreview)}>
              Render 10 s preview
            </Button>
          </div>
          <Progress run={preview} label="Rendering the preview…" rangeSec={10} outFps={prefs.fps} />
          {previewPath && preview.job?.status === JobStatus.JobDone && <PreviewClip key={previewPath} path={previewPath} />}
        </div>
      </Section>

      <Section label="Video">
        <div className={styles.form}>
          <div className={styles.row}>
            <Button icon="film" variant="primary" loading={render.busy} disabled={!!blocker || busy} onClick={() => go(render, VisualizerAction.ActionRender)}>
              Render video
            </Button>
            {onBack && (
              <Button variant="ghost" icon="chevron-left" onClick={onBack}>
                Back to design
              </Button>
            )}
          </div>
          <Progress run={render} label="Rendering the video…" rangeSec={rangeSec} outFps={prefs.fps} />
          {render.job?.status === JobStatus.JobDone && <ResultCard job={render.job} />}
        </div>
      </Section>
    </div>
  );
}
