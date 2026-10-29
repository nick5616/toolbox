import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, DropZone, Icon, IconButton, Meter, Section, cx, toast } from "@/components";
import { useMediaSource } from "@/components/media";
import { JobStatus, JobsService, PackComponentState, PacksService, RedactAction, RedactService, type RedactOptions, type RedactTrack } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import { isOk, useDeps } from "@/state/deps";
import { isActive, useJob, useJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { DepsGate, useDepsGate, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "../index";
import { Thumb } from "./bits";
import { onRedactAction } from "./commands";
import { ImageReview } from "./ImageReview";
import {
  DEFAULT_SETTINGS,
  baseName,
  baseOptions,
  classify,
  countLabel,
  enabledCount,
  enabledTrackCount,
  imageApplyOptions,
  imageEntries,
  initialVideoState,
  isHeicPath,
  parseResult,
  sanitizeSettings,
  videoApplyOptions,
  type ImageBox,
  type ImageEntry,
  type RedactSettings,
  type VideoState,
} from "./logic";
import { OptionsPanel } from "./OptionsPanel";
import { Results } from "./Results";
import { VideoReview } from "./VideoReview";
import styles from "./RedactView.module.css";

const ENGINE_DEP_ID = "audio-engine";
const FACE_MODEL = "face-detect";
const PLATE_MODEL = "plate-detect";

interface Run {
  id: string;
  action: "detect" | "apply" | "auto";
}

interface VideoDet {
  path: string;
  detectionsPath: string;
  tracks: RedactTrack[];
  state: VideoState;
}

/** True when a model component is missing; unknown components never block. */
function useModelMissing(component: string): boolean {
  return usePacks((s) => {
    for (const p of s.list) {
      const c = p.components.find((x) => x.id === component);
      if (c) return !(c.state === PackComponentState.ComponentInstalled || c.state === PackComponentState.ComponentSystem);
    }
    return false;
  });
}

export default function RedactView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const { files, remove } = inputs;
  const gate = useDepsGate(moduleId);
  const [settings, setSettings] = useModuleOptions(moduleId, DEFAULT_SETTINGS, sanitizeSettings);
  const patch = useCallback((p: Partial<RedactSettings>) => setSettings((s) => ({ ...s, ...p })), [setSettings]);

  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const kinds = useMemo(() => classify(paths), [paths]);
  const mixed = kinds.images.length > 0 && kinds.videos.length > 0;
  const isVideo = kinds.videos.length > 0 && !mixed;
  const video = isVideo ? kinds.videos[kinds.videos.length - 1] : undefined;
  const hasHeic = kinds.images.some(isHeicPath);

  // Only one video at a time: the newest replaces the older ones.
  useEffect(() => {
    if (kinds.videos.length > 1 && kinds.images.length === 0) for (const p of kinds.videos.slice(0, -1)) remove(p);
  }, [kinds, remove]);

  // ---- session state ----
  const [run, setRun] = useState<Run | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; hint?: string } | null>(null);
  const [entries, setEntries] = useState<ImageEntry[]>([]);
  const [edits, setEdits] = useState<Record<string, ImageBox[]>>({});
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [cur, setCur] = useState("");
  const [vdet, setVdet] = useState<VideoDet | null>(null);
  const [installing, setInstalling] = useState(false);
  const job = useJob(run?.id ?? "");
  const handled = useRef("");

  const filesKey = paths.join("\n");
  useEffect(() => {
    setRun(null);
    setEntries([]);
    setEdits({});
    setReviewed(new Set());
    setCur("");
    setVdet(null);
    setSubmitError(null);
    handled.current = "";
  }, [filesKey]);

  // The detect job finished: open the review.
  useEffect(() => {
    if (!run || run.action !== "detect" || !job || job.status !== JobStatus.JobDone || handled.current === job.id) return;
    handled.current = job.id;
    const res = parseResult(job.resultJson);
    if (res?.video) {
      setVdet({ path: video ?? "", detectionsPath: res.video.detectionsPath, tracks: res.video.tracks ?? [], state: initialVideoState(res.video.tracks ?? []) });
      setRun(null);
      return;
    }
    const list = imageEntries(res);
    if (list.length === 0) {
      toast({ title: "The search finished without a result", tone: "danger" });
      setRun(null);
      return;
    }
    setEntries(list);
    setEdits(Object.fromEntries(list.map((e) => [e.path, e.boxes])));
    setReviewed(new Set());
    setCur(list.length === 1 ? (list[0]?.path ?? "") : "");
    setRun(null);
  }, [run, job, video]);

  const running = !!run && (!job || isActive(job));
  const failedJob = run && job && (job.status === JobStatus.JobFailed || job.status === JobStatus.JobCancelled) ? job : undefined;
  const applied = run && run.action !== "detect" && job && job.status === JobStatus.JobDone ? job : undefined;
  const reviewing = !applied && !running && (entries.length > 0 || !!vdet);

  // ---- readiness ----
  const engineOk = useDeps((s) => isOk(s.byId[ENGINE_DEP_ID]));
  const packsLoaded = usePacks((s) => s.loaded);
  const faceMissing = useModelMissing(FACE_MODEL);
  const plateMissing = useModelMissing(PLATE_MODEL);
  const modelsMissing = engineOk && packsLoaded && ((settings.faces && faceMissing) || (settings.plates && plateMissing));
  const nothingToFind = !settings.faces && !settings.plates;
  const blocked = gate.blocked ? gate.reason : modelsMissing ? "Redact needs its detection models first." : mixed ? "Redact images and videos separately." : "";

  const installModels = async () => {
    setInstalling(true);
    try {
      useJobs.getState().upsert(await PacksService.InstallFor(moduleId));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setInstalling(false);
    }
  };

  // ---- submitting ----
  const submit = useCallback(async (action: Run["action"], opts: RedactOptions, inputPaths: string[]) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const jobs = await RedactService.Enqueue(inputPaths, opts);
      const j = jobs?.[0];
      if (j) {
        useJobs.getState().upsert(j);
        setRun({ id: j.id, action });
      }
    } catch (e) {
      const a = toAppError(e);
      setSubmitError({ message: a.message, hint: a.hint });
    } finally {
      setSubmitting(false);
    }
  }, []);

  const canStart = paths.length > 0 && !blocked && !nothingToFind && !running && !submitting && !reviewing && !applied;
  const canDetect = canStart && !hasHeic;
  const detect = () => {
    if (canDetect) void submit("detect", baseOptions(settings, RedactAction.ActionDetect), isVideo && video ? [video] : paths);
  };
  const auto = () => {
    if (canStart) void submit("auto", baseOptions(settings, RedactAction.ActionAuto), isVideo && video ? [video] : paths);
  };

  const imagePaths = useMemo(() => entries.map((e) => e.path), [entries]);
  const totalOn = useMemo(() => imagePaths.reduce((n, p) => n + enabledCount(edits[p] ?? []), 0), [imagePaths, edits]);
  const canApply = reviewing && !submitting && !gate.blocked && (vdet ? enabledTrackCount(vdet.tracks, vdet.state) + vdet.state.manual.filter((b) => b.enabled).length > 0 : totalOn > 0);
  const apply = () => {
    if (!canApply) return;
    if (vdet) void submit("apply", videoApplyOptions(settings, vdet.detectionsPath, vdet.tracks, vdet.state), [vdet.path]);
    else void submit("apply", imageApplyOptions(settings, imagePaths, edits), imagePaths);
  };

  const cancel = () => {
    if (run) void JobsService.Cancel(run.id).catch(() => undefined);
  };
  const startOver = () => {
    setRun(null);
    setEntries([]);
    setEdits({});
    setVdet(null);
    setCur("");
    setSubmitError(null);
  };
  const more = () => {
    inputs.clear();
    startOver();
  };

  const go = useCallback((p: string) => {
    setCur((prev) => {
      if (prev) setReviewed((r) => new Set(r).add(prev));
      return p;
    });
  }, []);

  // Palette entries.
  const live = useRef({ pick: inputs.pick, detect, apply });
  live.current = { pick: inputs.pick, detect, apply };
  useEffect(
    () =>
      onRedactAction((a) => {
        if (a === "choose-file") void live.current.pick();
        else if (a === "detect") live.current.detect();
        else if (a === "redact") live.current.apply();
      }),
    [],
  );
  useShortcut("Enter", apply, { when: canApply });

  // ---- render ----
  const header = (
    <header className={styles.header}>
      <h1 className={styles.title}>Redact</h1>
      {files.length > 0 && (
        <Button size="sm" variant="ghost" onClick={more}>
          Choose different files
        </Button>
      )}
    </header>
  );
  const warning = (
    <Banner tone="warn" title="Detection can miss faces and plates.">
      Check every image or frame before sharing.
    </Banner>
  );

  if (files.length === 0) {
    return (
      <section className={styles.root} aria-label="Redact">
        {header}
        {warning}
        <DepsGate moduleId={moduleId} />
        <div className={styles.empty}>
          <DropZone id="redact-drop" label="Drop photos or one video" hint="Blur, pixelate or black out faces and number plates." icon="scan-face">
            <Button variant="secondary" icon="folder-open" onClick={() => void inputs.pick()}>
              Choose files
            </Button>
          </DropZone>
        </div>
      </section>
    );
  }

  const failedBanner = failedJob && (
    <Banner tone={failedJob.status === JobStatus.JobFailed ? "danger" : "warn"} title={failedJob.status === JobStatus.JobFailed ? failedJob.error || "That didn't work" : "Cancelled"}>
      {failedJob.status === JobStatus.JobFailed ? failedJob.errorHint : reviewing ? "Your boxes are still here." : undefined}
    </Banner>
  );

  const current = entries.find((e) => e.path === cur);
  const reviewedAll = imagePaths.filter((p) => reviewed.has(p) || p === cur).length;

  return (
    <section className={styles.root} aria-label="Redact">
      {header}
      {warning}
      <DepsGate moduleId={moduleId} />
      {modelsMissing && (
        <Banner
          tone="info"
          title="Redact needs its detection models"
          action={
            <Button variant="primary" size="sm" icon="download" loading={installing} onClick={() => void installModels()}>
              Install the models
            </Button>
          }
        >
          The face and number-plate detectors are small downloads that run on your computer.
        </Banner>
      )}
      {mixed && (
        <Banner tone="danger" title="Redact images and videos separately">
          Remove either the photos or the video to continue.
        </Banner>
      )}
      {submitError && (
        <Banner tone="danger" title={submitError.message}>
          {submitError.hint}
        </Banner>
      )}
      {failedBanner}

      {running ? (
        <div className={styles.progress} role="status">
          <Meter value={job?.progress ?? -1} label="Progress" />
          <span className={styles.hint}>{job?.message || (run?.action === "detect" ? "Looking for faces and plates…" : "Starting…")}</span>
          <Button size="sm" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : applied ? (
        <Results job={applied} onEdit={entries.length > 0 || vdet ? () => setRun(null) : undefined} onMore={more} />
      ) : reviewing && vdet ? (
        <VideoStage vdet={vdet} onState={(state) => setVdet((v) => (v ? { ...v, state } : v))} />
      ) : reviewing && entries.length > 0 ? (
        <>
          {current ? (
            <ImageReview
              entry={current}
              boxes={edits[current.path] ?? []}
              onBoxes={(b) => setEdits((m) => ({ ...m, [current.path]: b }))}
              settings={settings}
              strip={entries.length > 1 ? imagePaths : undefined}
              reviewed={reviewed}
              onGo={go}
              onBack={entries.length > 1 ? () => go("") : undefined}
            />
          ) : (
            <Gallery entries={entries} edits={edits} reviewed={reviewed} onOpen={go} />
          )}
          {current && <Section label="Effect"><OptionsPanel settings={settings} onChange={patch} part="effect" /></Section>}
        </>
      ) : (
        <div className={styles.setup}>
          <Section label="Files" action={<Button size="sm" variant="ghost" icon="plus" onClick={() => void inputs.pick()}>Add more</Button>}>
            <ul className={styles.fileList}>
              {paths.map((p) => (
                <li key={p} className={styles.fileRow}>
                  <Thumb path={p} size={96} className={styles.fileThumb} />
                  <span className={styles.fileName} title={p}>
                    {baseName(p)}
                  </span>
                  <IconButton size="sm" icon="x" label={`Remove ${baseName(p)}`} onClick={() => remove(p)} />
                </li>
              ))}
            </ul>
          </Section>
          <Section label="Options">
            <OptionsPanel settings={settings} onChange={patch} part="all" />
          </Section>
          {hasHeic && (
            <p className={styles.hint}>HEIC photos can't be previewed here, so they can only be redacted automatically, with no review step.</p>
          )}
        </div>
      )}

      {!running && !applied && (
        <div className={styles.footer}>
          {reviewing ? (
            <>
              <Button variant="ghost" onClick={startOver}>
                Start over
              </Button>
              <span className={styles.spacer} />
              {entries.length > 1 && (
                <span className={styles.hint}>
                  {reviewedAll} of {entries.length} reviewed · {countLabel(Object.values(edits).flat())}
                </span>
              )}
              {!canApply && !submitting && <span className={styles.hint}>{gate.blocked ? gate.reason : "Nothing is switched on to hide yet."}</span>}
              <Button variant="primary" icon="scan-face" kbd="Enter" loading={submitting} disabled={!canApply} onClick={apply}>
                {vdet ? "Redact video" : entries.length > 1 ? `Redact all ${entries.length}` : "Save redacted"}
              </Button>
            </>
          ) : (
            <>
              <span className={styles.spacer} />
              {blocked && <span className={styles.hint}>{blocked}</span>}
              {nothingToFind && !blocked && <span className={styles.hint}>Turn on faces or number plates.</span>}
              <Button variant="secondary" disabled={!canStart} onClick={auto} title="Find and hide everything, with no review">
                Redact without review
              </Button>
              <Button variant="primary" icon="scan-search" loading={submitting} disabled={!canDetect} onClick={detect}>
                {isVideo ? "Find faces and plates" : paths.length > 1 ? `Find in ${paths.length} images` : "Find faces and plates"}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function VideoStage({ vdet, onState }: { vdet: VideoDet; onState: (s: VideoState) => void }) {
  const media = useMediaSource(vdet.path);
  if (media.status === "ready" && media.source) {
    return <VideoReview path={vdet.path} source={media.source} tracks={vdet.tracks} state={vdet.state} onState={onState} />;
  }
  if (media.status === "error") {
    return (
      <Banner tone="danger" title={media.error?.message ?? "This video can't be opened"} action={<Button size="sm" onClick={media.retry}>Retry</Button>}>
        {media.error?.hint}
      </Banner>
    );
  }
  return (
    <div className={styles.progress} role="status">
      {media.status === "preparing" ? (
        <>
          <span>Preparing a preview copy… {Math.round((media.progress ?? 0) * 100)}%</span>
          <Meter value={media.progress ?? -1} label="Preview copy progress" />
          <span className={styles.hint}>This format can't play in the app directly. The redacted video is made from the original.</span>
        </>
      ) : (
        <span>Loading…</span>
      )}
    </div>
  );
}

function Gallery({ entries, edits, reviewed, onOpen }: { entries: ImageEntry[]; edits: Record<string, ImageBox[]>; reviewed: ReadonlySet<string>; onOpen: (p: string) => void }) {
  return (
    <div className={styles.gallery} role="list" aria-label="Detections per image">
      {entries.map((e) => (
        <button key={e.path} type="button" role="listitem" className={cx(styles.galleryItem, reviewed.has(e.path) && styles.galleryDone)} onClick={() => onOpen(e.path)} aria-label={baseName(e.path)}>
          <Thumb path={e.path} size={320} className={styles.galleryThumb} />
          <span className={styles.galleryName}>{baseName(e.path)}</span>
          <span className={styles.hint}>{countLabel(edits[e.path] ?? [])}</span>
          {reviewed.has(e.path) && <Icon name="check" size={14} className={styles.galleryCheck} />}
        </button>
      ))}
    </div>
  );
}
