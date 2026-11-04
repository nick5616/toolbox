import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, Section, SegmentedControl, Select, Switch, toast } from "@/components";
import { ABToggle, Waveform, useMediaSource } from "@/components/media";
import {
  AudioCleanupService,
  CleanupDenoise,
  CleanupFormat,
  CleanupHum,
  CleanupLoudness,
  JobStatus,
  MediaService,
  PacksService,
  PackComponentState,
  type AudioCleanupOptions,
  type MediaSource,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isOk, useDeps } from "@/state/deps";
import { isActive, useJob, useJobs, useOrderedJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { FileToolLayout, ResultTable, runLabel, useFileInputs, useModuleOptions, setRequiresOverride } from "@/tools/_kit";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ResultColumn } from "@/tools/_kit";
import type { ToolViewProps } from "../index";
import {
  DEFAULT_CLEANUP_OPTIONS,
  DENOISE_HINT,
  ENGINE_DEP_ID,
  LOUDNESS_INFO,
  PREVIEW_MS,
  VOICE_MODEL_COMPONENT,
  formatLufs,
  isVideoPath,
  parseFiles,
  parsePreview,
  previewKey,
  previewStartFor,
  previewSummary,
  sanitizeCleanupOptions,
  type FileOutcome,
  type PreviewOutcome,
} from "./options";
import styles from "./AudioCleanupView.module.css";

const WAVE_BUCKETS = 800;

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** A MediaSource for a local WAV excerpt (the media route plays it as is). */
async function excerptSource(path: string, durationMs: number): Promise<MediaSource> {
  const url = await MediaService.URLFor(path);
  return {
    url,
    proxy: false,
    proxyJobId: "",
    info: {
      durationMs,
      startMs: 0,
      container: "wav",
      sizeBytes: 0,
      bitRate: 0,
      video: null,
      audio: null,
      subtitles: null,
      hasCover: false,
      tags: null,
    },
  };
}

interface PreviewCardProps {
  paths: string[];
  opts: AudioCleanupOptions;
  blocked: string;
}

function PreviewCard({ paths, opts, blocked }: PreviewCardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const path = selected && paths.includes(selected) ? selected : (paths[0] ?? null);
  const [startMs, setStartMs] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [jobId, setJobId] = useState("");
  const [shown, setShown] = useState<{ key: string; outcome: PreviewOutcome } | null>(null);
  const [sources, setSources] = useState<{ a: MediaSource; b: MediaSource } | null>(null);
  const [starting, setStarting] = useState(false);
  const media = useMediaSource(path);
  const durationMs = media.source?.info.durationMs ?? 0;
  const job = useJob(jobId);

  // A different file starts a fresh preview.
  useEffect(() => {
    setStartMs(0);
    setJobId("");
    setShown(null);
    setSources(null);
  }, [path]);

  useEffect(() => {
    setPeaks([]);
    if (!path) return;
    let cancelled = false;
    MediaService.Waveform(path, WAVE_BUCKETS)
      .then((p) => !cancelled && setPeaks(p ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Pick up the finished preview job.
  const keyAtStart = useRef("");
  const resultJson = job?.status === JobStatus.JobDone ? job.resultJson : "";
  useEffect(() => {
    const outcome = parsePreview(resultJson);
    if (!outcome) return;
    let cancelled = false;
    const len = Math.min(PREVIEW_MS, durationMs || PREVIEW_MS);
    void Promise.all([excerptSource(outcome.previewOriginal, len), excerptSource(outcome.previewCleaned, len)])
      .then(([a, b]) => {
        if (cancelled) return;
        setSources({ a, b });
        setShown({ key: keyAtStart.current, outcome });
      })
      .catch((e) => toast({ title: toAppError(e).message, tone: "danger" }));
    return () => {
      cancelled = true;
    };
  }, [resultJson, durationMs]);

  if (!path) return null;

  const key = previewKey(opts, path, startMs);
  const stale = shown !== null && shown.key !== key;
  const running = !!job && isActive(job);
  const failed = job?.status === JobStatus.JobFailed ? (job.error || "The preview failed") : "";

  const run = async () => {
    setStarting(true);
    keyAtStart.current = key;
    try {
      const jobs = await AudioCleanupService.Enqueue([path], { ...opts, preview: true, previewStartMs: startMs });
      const j = jobs?.[0];
      if (j) {
        useJobs.getState().upsert(j);
        setJobId(j.id);
      }
    } catch (e) {
      const err = toAppError(e);
      toast({ title: err.message, description: err.hint, tone: "danger" });
    } finally {
      setStarting(false);
    }
  };

  const band =
    durationMs > 0 ? { start: startMs / durationMs, end: Math.min(1, (startMs + PREVIEW_MS) / durationMs) } : undefined;

  return (
    <Section label="Preview" tip="Try the cleanup on 10 seconds and switch between original and cleaned audio">
      <div className={styles.preview} data-testid="cleanup-preview">
        <div className={styles.previewHead}>
          {paths.length > 1 ? (
            <Select
              aria-label="Preview file"
              data-tip="Choose which queued file to preview"
              size="sm"
              value={path}
              onChange={setSelected}
              options={paths.map((p) => ({ value: p, label: basename(p) }))}
            />
          ) : (
            <span className={styles.fileName} data-tip="The file the preview is made from">
              {basename(path)}
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon="play"
            loading={running || starting}
            disabled={!!blocked || running || starting || durationMs === 0}
            data-tip={blocked || (durationMs === 0 ? "Waiting for the file to be read" : "Clean a 10-second excerpt with these options so you can compare it with the original")}
            onClick={() => void run()}
          >
            Preview 10 s
          </Button>
        </div>

        <div className={styles.wave}>
          <Waveform
            peaks={peaks}
            band={band}
            height={64}
            onSeek={(f) => setStartMs(previewStartFor(f, durationMs))}
          />
          <span className={styles.waveHelp} data-tip="The shaded band is the 10 seconds that will be previewed">
            {media.status === "preparing"
              ? "Preparing a preview copy…"
              : "Click the waveform to choose where the 10 s preview starts"}
          </span>
        </div>

        {running && <p className={styles.progress} data-tip="The preview is being made">{job?.message || "Making the preview…"}</p>}
        {failed && (
          <p className={styles.error} role="alert">
            {failed}
          </p>
        )}
        {blocked && !running && <p className={styles.hint}>{blocked}</p>}

        {sources && shown && (
          <div className={styles.outcome}>
            <ABToggle a={sources.a} b={sources.b} labels={["Original", "Cleaned"]} />
            <p className={styles.summary} data-tip="Loudness and hum found in the excerpt before and after cleaning">
              {previewSummary(shown.outcome)}
            </p>
            {stale && <p className={styles.stale} data-tip="The options or start point changed since this preview was made">Options changed — preview again</p>}
          </div>
        )}
      </div>
    </Section>
  );
}

export default function AudioCleanupView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts, optsLoaded] = useModuleOptions(moduleId, DEFAULT_CLEANUP_OPTIONS, sanitizeCleanupOptions);
  const [running, setRunning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useOrderedJobs(moduleId);

  const depsLoaded = useDeps((s) => s.list.length > 0);
  const engineOk = useDeps((s) => isOk(s.byId[ENGINE_DEP_ID]));
  const packsLoaded = usePacks((s) => s.loaded);
  const modelPresent = usePacks((s) => {
    for (const p of s.list) {
      const c = p.components.find((x) => x.id === VOICE_MODEL_COMPONENT);
      if (c) return c.state === PackComponentState.ComponentInstalled || c.state === PackComponentState.ComponentSystem;
    }
    return true; // unknown component: don't block
  });

  // Voice isolation needs the AI engine: let the layout's gate offer it.
  const voice = opts.denoise === CleanupDenoise.DenoiseVoice;
  useEffect(() => {
    setRequiresOverride(moduleId, voice ? ["ffmpeg", "ffprobe", ENGINE_DEP_ID] : null);
    return () => setRequiresOverride(moduleId, null);
  }, [moduleId, voice]);

  // Default to Strong when there is no AI engine (once; the user can pick Voice again).
  const switched = useRef(false);
  useEffect(() => {
    if (switched.current || !optsLoaded || !depsLoaded) return;
    switched.current = true;
    if (!engineOk && opts.denoise === CleanupDenoise.DenoiseVoice) {
      setOpts((o) => ({ ...o, denoise: CleanupDenoise.DenoiseStrong }));
    }
  }, [optsLoaded, depsLoaded, engineOk, opts.denoise, setOpts]);

  // Discard the excerpts when the view goes away.
  useEffect(
    () => () => {
      AudioCleanupService.DiscardPreviews().catch(() => undefined);
    },
    [],
  );

  const modelMissing = voice && engineOk && packsLoaded && !modelPresent;
  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const allVideo = paths.length > 0 && paths.every(isVideoPath);

  const installModel = async () => {
    setInstalling(true);
    try {
      useJobs.getState().upsert(await PacksService.InstallFor(moduleId));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setInstalling(false);
    }
  };

  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(
      () => AudioCleanupService.Enqueue(paths, { ...opts, preview: false, previewStartMs: 0 }),
      paths,
      ["file", "files"],
    );
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const rows = useMemo(() => {
    const out: Array<FileOutcome & { id: string; outputId?: string; missing?: boolean }> = [];
    for (const j of jobs) {
      if (j.status !== JobStatus.JobDone) continue;
      for (const f of parseFiles(j.resultJson)) {
        const o = j.outputs.find((x) => x.path === f.output);
        out.push({ ...f, id: `${j.id}:${f.output}`, outputId: o?.id, missing: o?.missing });
      }
    }
    return out.slice(0, 50);
  }, [jobs]);

  const columns: ResultColumn<(typeof rows)[number]>[] = [
    { key: "file", header: "File", render: (r) => <span data-tip={r.output}>{basename(r.output)}</span>, text: (r) => basename(r.output) },
    {
      key: "before",
      header: "Before",
      align: "right",
      mono: true,
      render: (r) => <span data-tip="Loudness of the original, in LUFS (closer to 0 is louder)">{formatLufs(r.lufsBefore)} LUFS</span>,
      text: (r) => r.lufsBefore.toFixed(1),
    },
    {
      key: "after",
      header: "After",
      align: "right",
      mono: true,
      render: (r) => <span data-tip="Loudness of the cleaned file, in LUFS">{formatLufs(r.lufsAfter)} LUFS</span>,
      text: (r) => r.lufsAfter.toFixed(1),
    },
    {
      key: "hum",
      header: "Hum",
      render: (r) => <span data-tip="Mains hum frequency that was filtered out, if any">{r.humHz > 0 ? `${r.humHz} Hz removed` : "None"}</span>,
      text: (r) => (r.humHz > 0 ? String(r.humHz) : ""),
    },
    {
      key: "actions",
      header: "",
      render: (r) => <FileActions outputId={r.outputId} path={r.output} disabled={r.missing} />,
      text: (r) => r.output,
    },
  ];

  const blockedReason = modelMissing ? "Voice isolation needs its model. Install it or pick another noise reduction." : "";
  const loud = LOUDNESS_INFO[opts.loudness];

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Clean", paths.length, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      runDisabledReason={blockedReason || undefined}
      options={
        <>
          {modelMissing && (
            <Banner
              tone="info"
              title="Voice isolation needs its model"
              action={
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="download"
                    loading={installing}
                    data-tip="Download the DeepFilterNet3 voice model (8 MB, one time); it runs offline afterwards"
                    onClick={() => void installModel()}
                  >
                    Install voice isolation (8 MB)
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-tip="Skip the AI model and use the built-in strong noise filter instead"
                    onClick={() => setOpts((o) => ({ ...o, denoise: CleanupDenoise.DenoiseStrong }))}
                  >
                    Use Strong instead
                  </Button>
                </>
              }
            >
              DeepFilterNet3 is a small download that runs on your computer.
            </Banner>
          )}
          <Section label="Options" tip="Pick which problems to fix; they are applied in this order">
            <div className={styles.options}>
              <div className={styles.row}>
                <span className={styles.label} data-tip="Removes very low frequencies such as desk thumps and wind">Rumble filter</span>
                <div className={styles.control}>
                  <Switch
                    checked={opts.highPass}
                    onChange={(highPass) => setOpts((o) => ({ ...o, highPass }))}
                    label="Cut below 80 Hz"
                    tip="Applies a high-pass filter at 80 Hz; voices and most music are unaffected"
                  />
                </div>
              </div>

              <div className={styles.row}>
                <span className={styles.label} data-tip="Electrical buzz from mains power">Hum</span>
                <div className={styles.control}>
                  <SegmentedControl
                    aria-label="Hum"
                    value={opts.hum}
                    onChange={(hum) => setOpts((o) => ({ ...o, hum }))}
                    options={[
                      { value: CleanupHum.HumAuto, label: "Auto", tip: "Detect whether the buzz is 50 or 60 Hz from the file itself" },
                      { value: CleanupHum.Hum50, label: "50 Hz", tip: "Remove 50 Hz buzz and harmonics (Europe, Asia, Africa)" },
                      { value: CleanupHum.Hum60, label: "60 Hz", tip: "Remove 60 Hz buzz and harmonics (Americas, parts of Asia)" },
                      { value: CleanupHum.HumOff, label: "Off", tip: "Do not remove any hum" },
                    ]}
                  />
                  <p className={styles.hint}>Mains buzz and its harmonics. Auto listens to the file and picks 50 or 60 Hz.</p>
                </div>
              </div>

              <div className={styles.row}>
                <span className={styles.label} data-tip="Reduces steady background noise such as hiss, fans and room tone">Noise reduction</span>
                <div className={styles.control}>
                  <SegmentedControl
                    aria-label="Noise reduction"
                    value={opts.denoise}
                    onChange={(denoise) => setOpts((o) => ({ ...o, denoise }))}
                    options={[
                      { value: CleanupDenoise.DenoiseOff, label: "Off", tip: "Leave background noise untouched" },
                      { value: CleanupDenoise.DenoiseLight, label: "Light", tip: "Gentle filter that keeps the sound natural; fast" },
                      { value: CleanupDenoise.DenoiseStrong, label: "Strong", tip: "Heavier filter that removes more noise but can sound slightly processed; fast" },
                      { value: CleanupDenoise.DenoiseVoice, label: "Voice isolation (AI)", tip: "AI model keeps the speech and removes everything else; best quality, slower, needs the AI engine and an 8 MB model" },
                    ]}
                  />
                  <p className={styles.hint}>{DENOISE_HINT[opts.denoise]}</p>
                </div>
              </div>

              <div className={styles.row}>
                <span className={styles.label} data-tip="Normalise the overall volume to a standard level so tracks sound equally loud">Loudness</span>
                <div className={styles.control}>
                  <SegmentedControl
                    aria-label="Loudness"
                    value={opts.loudness}
                    onChange={(loudness) => setOpts((o) => ({ ...o, loudness }))}
                    options={[
                      { value: CleanupLoudness.LoudnessOff, label: "Off", tip: "Keep the original volume" },
                      { value: CleanupLoudness.LoudnessPodcast, label: "Podcast", tip: "Target about -16 LUFS, the usual level for podcasts and spoken word" },
                      { value: CleanupLoudness.LoudnessStreaming, label: "Streaming", tip: "Target about -14 LUFS, what Spotify and YouTube normalise to" },
                      { value: CleanupLoudness.LoudnessBroadcast, label: "Broadcast", tip: "Target about -23 LUFS, the EBU R128 standard for TV and radio" },
                    ]}
                  />
                  <p className={styles.hint}>{loud?.detail}</p>
                </div>
              </div>

              {!allVideo && (
                <div className={styles.row}>
                  <span className={styles.label} data-tip="File type of the cleaned audio">Output format</span>
                  <div className={styles.control}>
                    <Select
                      aria-label="Output format"
                      data-tip="File type of the cleaned audio; WAV and FLAC are lossless, MP3 and M4A are smaller"
                      size="sm"
                      value={opts.format}
                      onChange={(format) => setOpts((o) => ({ ...o, format }))}
                      options={[
                        { value: CleanupFormat.FormatSame, label: "Same as input" },
                        { value: CleanupFormat.FormatWAV, label: "WAV" },
                        { value: CleanupFormat.FormatFLAC, label: "FLAC" },
                        { value: CleanupFormat.FormatMP3, label: "MP3" },
                        { value: CleanupFormat.FormatM4A, label: "M4A (AAC)" },
                      ]}
                    />
                    <p className={styles.hint}>Videos keep their picture and container; only the audio is re-encoded.</p>
                  </div>
                </div>
              )}
            </div>
          </Section>
          {paths.length > 0 && <PreviewCard paths={paths} opts={opts} blocked={blockedReason} />}
        </>
      }
      results={
        <Section label="Results" tip="Cleaned files with loudness before and after">
          <ResultTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            label="cleaned files"
            empty="No cleaned files yet. Cleaned audio appears here with its loudness before and after."
          />
        </Section>
      }
    />
  );
}
