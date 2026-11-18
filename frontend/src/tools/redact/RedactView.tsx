import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolHeader } from "@/components/ToolHeader";
import { Banner, Button, ClickInHost, DropZone, Icon, IconButton, Meter, Section, cx, toast } from "@/components";
import { useMediaSource } from "@/components/media";
import { JobStatus, JobsService, OutputKind, PackComponentState, PacksService, RedactAction, RedactService, type RedactOptions, type RedactTrack } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import { isOk, useDeps } from "@/state/deps";
import { isActive, useJob, useJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { DepsGate, RecentResults, useDepsGate, useFileInputs, useModuleOptions } from "@/tools/_kit";
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
import { CompactOptions } from "./CompactOptions";
import { ResultCards, Results } from "./Results";
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
  // Review works on one video; several videos can only be redacted automatically (one job each).
  const video = isVideo && kinds.videos.length === 1 ? kinds.videos[0] : undefined;
  const manyVideos = isVideo && kinds.videos.length > 1;
  const hasHeic = kinds.images.some(isHeicPath);

  // ---- session state ----
  const [run, setRun] = useState<Run | null>(null);
  // Several videos redacted without review: one job each, followed together.
  const [batch, setBatch] = useState<string[] | null>(null);
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
    setBatch(null);
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

  const submitEach = useCallback(async (opts: RedactOptions, each: string[]) => {
    setSubmitting(true);
    setSubmitError(null);
    const ids: string[] = [];
    let failure: { message: string; hint?: string } | null = null;
    for (const p of each) {
      try {
        const jobs = await RedactService.Enqueue([p], opts);
        const j = jobs?.[0];
        if (j) {
          useJobs.getState().upsert(j);
          ids.push(j.id);
        }
      } catch (e) {
        const a = toAppError(e);
        failure ??= { message: `${baseName(p)}: ${a.message}`, hint: a.hint };
      }
    }
    if (ids.length > 0) setBatch(ids);
    setSubmitError(failure);
    setSubmitting(false);
  }, []);

  const canStart = paths.length > 0 && !blocked && !nothingToFind && !running && !submitting && !reviewing && !applied && !batch;
  const canDetect = canStart && !hasHeic && !manyVideos;
  const detect = () => {
    if (canDetect) void submit("detect", baseOptions(settings, RedactAction.ActionDetect), isVideo && video ? [video] : paths);
  };
  const auto = () => {
    if (!canStart) return;
    const opts = baseOptions(settings, RedactAction.ActionAuto);
    if (manyVideos) void submitEach(opts, kinds.videos);
    else void submit("auto", opts, isVideo && video ? [video] : paths);
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
    setBatch(null);
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
  const live = useRef({ pick: inputs.pick, pickLibrary: inputs.pickLibrary, detect, apply });
  live.current = { pick: inputs.pick, pickLibrary: inputs.pickLibrary, detect, apply };
  useEffect(
    () =>
      onRedactAction((a) => {
        if (a === "choose-file") void live.current.pick();
        else if (a === "choose-library") void live.current.pickLibrary();
        else if (a === "detect") live.current.detect();
        else if (a === "redact") live.current.apply();
      }),
    [],
  );
  useShortcut("Enter", apply, { when: canApply });

  // ---- render ----
  const header =
    files.length > 0 ? (
      <ToolHeader aria-label="Redact">
        <Button size="sm" variant="ghost" data-tip="Drop this session and pick other files" onClick={more}>
          Choose different files
        </Button>
      </ToolHeader>
    ) : null;
  const warning = (
    <Banner tone="warn" title="Detection can miss faces and plates.">
      Check every image or frame before sharing.
    </Banner>
  );

  const recent = (
    <RecentResults
      moduleId={moduleId}
      kinds={[OutputKind.KindImage, OutputKind.KindVideo]}
      label="Recent"
      tip="Files this tool redacted before; Show in folder, Open and Save a copy are on each row"
    />
  );

  if (files.length === 0) {
    return (
      <ClickInHost>
        <section className={cx(styles.root, styles.rootEmpty)} aria-label="Redact">
          {warning}
          <DepsGate moduleId={moduleId} />
          <div className={styles.empty}>
            <DropZone id="redact-drop" className={styles.fullDrop} label="Drop photos or one video" hint="Blur, pixelate or black out faces and number plates." icon="scan-face">
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", justifyContent: "center" }}>
                <Button variant="secondary" icon="folder-open" data-tip="Pick photos, or a single video, to hide faces and plates in" onClick={() => void inputs.pick()}>
                  Choose files
                </Button>
                <Button variant="secondary" icon="history" data-tip="Pick photos or a video Toolbox already made (the Library)" onClick={() => void inputs.pickLibrary()}>
                  From Library…
                </Button>
              </div>
            </DropZone>
            {recent}
          </div>
        </section>
      </ClickInHost>
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
    <ClickInHost>
    <section className={styles.root} aria-label="Redact">
      {header}
      {warning}
      <DepsGate moduleId={moduleId} />
      {modelsMissing && (
        <Banner
          tone="info"
          title="Redact needs its detection models"
          action={
            <Button
              variant="primary"
              size="sm"
              icon="download"
              loading={installing}
              data-tip="Download the face and number-plate detectors once; they run offline afterwards"
              onClick={() => void installModels()}
            >
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
          <Button size="sm" variant="secondary" data-tip="Stop the search or the redaction" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : batch ? (
        <BatchStage ids={batch} onMore={more} />
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
          {current && <CompactOptions settings={settings} onChange={patch} part="effect" />}
        </>
      ) : (
        <div className={styles.setup}>
          <Section label="Files" tip="The photos or the single video that will be searched" action={<span style={{ display: "inline-flex", gap: "var(--space-1)" }}><Button size="sm" variant="ghost" icon="plus" data-tip="Add more photos to this batch" onClick={() => void inputs.pick()}>Add more</Button><Button size="sm" variant="ghost" icon="history" data-tip="Add more from files Toolbox already made (the Library)" onClick={() => void inputs.pickLibrary()}>From Library…</Button></span>}>
            <ul className={styles.fileList}>
              {paths.map((p) => (
                <li key={p} className={styles.fileRow}>
                  <Thumb path={p} size={96} className={styles.fileThumb} />
                  <span className={styles.fileName} data-tip={p}>
                    {baseName(p)}
                  </span>
                  <IconButton size="sm" icon="x" label={`Remove ${baseName(p)}`} data-tip="Take this file out of the batch (the file on disk is untouched)" onClick={() => remove(p)} />
                </li>
              ))}
            </ul>
          </Section>
          <Section label="Find" tip="What to look for; how it is hidden is under Effect">
            <CompactOptions settings={settings} onChange={patch} part="all" />
          </Section>
          {hasHeic && (
            <p className={styles.hint}>HEIC photos can't be previewed here, so they can only be redacted automatically, with no review step.</p>
          )}
          {manyVideos && (
            <p className={styles.hint}>Reviewing works on one video at a time. “Redact without review” makes one redacted copy per video.</p>
          )}
          {recent}
        </div>
      )}

      {!running && !applied && !batch && (
        <div className={styles.footer}>
          {reviewing ? (
            <>
              <Button variant="ghost" data-tip="Throw away the boxes and search again" onClick={startOver}>
                Start over
              </Button>
              <span className={styles.spacer} />
              {entries.length > 1 && (
                <span className={styles.hint}>
                  {reviewedAll} of {entries.length} reviewed · {countLabel(Object.values(edits).flat())}
                </span>
              )}
              {!canApply && !submitting && <span className={styles.hint}>{gate.blocked ? gate.reason : "Nothing is switched on to hide yet."}</span>}
              <Button
                variant="primary"
                icon="scan-face"
                kbd="Enter"
                loading={submitting}
                disabled={!canApply}
                data-tip={canApply ? "Hide everything that is switched on and save a new copy; the original stays as it is" : gate.blocked ? gate.reason : "Switch on at least one box or track first"}
                onClick={apply}
              >
                {vdet ? "Redact video" : entries.length > 1 ? `Redact all ${entries.length}` : "Save redacted"}
              </Button>
            </>
          ) : (
            <>
              <span className={styles.spacer} />
              {blocked && <span className={styles.hint}>{blocked}</span>}
              {nothingToFind && !blocked && <span className={styles.hint}>Turn on faces or number plates.</span>}
              <Button
                variant="secondary"
                disabled={!canStart}
                data-tip={canStart ? "Find and hide everything in one go, with no chance to review the boxes" : blocked || (nothingToFind ? "Turn on faces or number plates first" : "Add files first")}
                onClick={auto}
              >
                Redact without review
              </Button>
              <Button
                variant="primary"
                icon="scan-search"
                loading={submitting}
                disabled={!canDetect}
                data-tip={canDetect ? "Search for faces and plates, then review the boxes before anything is hidden" : manyVideos ? "Review works on one video at a time; use Redact without review, or remove the other videos" : hasHeic ? "HEIC photos cannot be reviewed; use Redact without review" : blocked || (nothingToFind ? "Turn on faces or number plates first" : "Add files first")}
                onClick={detect}
              >
                {isVideo ? "Find faces and plates" : paths.length > 1 ? `Find in ${paths.length} images` : "Find faces and plates"}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
    </ClickInHost>
  );
}

function BatchJob({ id }: { id: string }) {
  const job = useJob(id);
  if (!job) return <span className={styles.hint}>Starting…</span>;
  if (isActive(job)) {
    return (
      <div className={styles.progress} role="status">
        <span>{job.title || baseName(job.inputs[0] ?? "")}</span>
        <Meter value={job.progress} label={`Progress of ${job.title || "video"}`} />
        <span className={styles.hint}>{job.message || "Waiting…"}</span>
        <Button size="sm" variant="secondary" data-tip="Stop this video's redaction" onClick={() => void JobsService.Cancel(id).catch(() => undefined)}>
          Cancel
        </Button>
      </div>
    );
  }
  if (job.status === JobStatus.JobDone) return <ResultCards outputs={job.outputs} />;
  return (
    <Banner tone={job.status === JobStatus.JobFailed ? "danger" : "warn"} title={`${job.title || baseName(job.inputs[0] ?? "")}: ${job.status === JobStatus.JobFailed ? job.error || "That didn't work" : "Cancelled"}`}>
      {job.status === JobStatus.JobFailed ? job.errorHint : undefined}
    </Banner>
  );
}

/** One automatic job per video, followed together; the originals are untouched. */
function BatchStage({ ids, onMore }: { ids: string[]; onMore: () => void }) {
  return (
    <div className={styles.results} aria-label="Redacted videos">
      <Banner tone="info" title={`Redacting ${ids.length} videos, one copy each`}>
        The originals are untouched. Look over each result before sharing it.
      </Banner>
      {ids.map((id) => (
        <BatchJob key={id} id={id} />
      ))}
      <div className={styles.footer}>
        <span className={styles.spacer} />
        <Button variant="primary" icon="scan-face" data-tip="Clear this session and pick new files to redact" onClick={onMore}>
          Redact more
        </Button>
      </div>
    </div>
  );
}

function VideoStage({ vdet, onState }: { vdet: VideoDet; onState: (s: VideoState) => void }) {
  const media = useMediaSource(vdet.path);
  if (media.status === "ready" && media.source) {
    return <VideoReview path={vdet.path} source={media.source} tracks={vdet.tracks} state={vdet.state} onState={onState} />;
  }
  if (media.status === "error") {
    return (
      <Banner tone="danger" title={media.error?.message ?? "This video can't be opened"} action={<Button size="sm" data-tip="Try opening the video again" onClick={media.retry}>Retry</Button>}>
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
        <button key={e.path} type="button" role="listitem" className={cx(styles.galleryItem, reviewed.has(e.path) && styles.galleryDone)} onClick={() => onOpen(e.path)} aria-label={baseName(e.path)} data-tip="Open this image to review its boxes">
          <Thumb path={e.path} size={320} className={styles.galleryThumb} />
          <span className={styles.galleryName}>{baseName(e.path)}</span>
          <span className={styles.hint} data-tip="Boxes found in this image">{countLabel(edits[e.path] ?? [])}</span>
          {reviewed.has(e.path) && <Icon name="check" size={14} className={styles.galleryCheck} />}
        </button>
      ))}
    </div>
  );
}
