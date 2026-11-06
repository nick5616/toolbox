/**
 * "Select a subject" (Phase 9 SPEC §10.7): scrub the clip's source range, click the subject (Alt-click or the
 * "Not this" toggle for the background), Try on one frame, then make the cut-out (or rebuild it after corrections).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Banner, Button, SegmentedControl, Slider, Spinner } from "@/components";
import { EditStudioService, JobStatus, MediaService, type EditMatteClick, type EditMatteRequest } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { formatTimecode } from "@/lib/format";
import { useJob } from "@/state/jobs";
import { clipSourceSpan, findClip, newId } from "@/editor/doc";
import { useEditStudio, useProject } from "@/editor/store";
import { resultOf } from "./matteJobs";
import {
  MAX_CLICKS,
  MAX_SELECT_MS,
  clicksFor,
  describeEstimate,
  estimateSeconds,
  frameOfMs,
  hasPositive,
  sameClicks,
  snapMs,
} from "./matteUtil";
import { PACK_HINT, useMatteModels } from "./useMatteModels";
import styles from "./MatteDialog.module.css";

export interface MatteDialogProps {
  clipId: string;
  onClose: () => void;
  /** Make (or rebuild) the cut-out with these clicks; the dialog closes afterwards. */
  onMake: (clicks: EditMatteClick[]) => void;
}

const DOT_REMOVE_LABEL = "Remove this point";

export function MatteDialog({ clipId, onClose, onMake }: MatteDialogProps) {
  const project = useProject();
  const projectId = useEditStudio((s) => s.projectId);
  const ref = project ? findClip(project, clipId) : null;
  const clip = ref?.clip ?? null;
  const fps = project?.fps ?? 30;
  const span = useMemo(() => (clip ? clipSourceSpan(clip, fps) : { fromMs: 0, toMs: 0 }), [clip, fps]);
  const existing = clip?.matte?.mode === "select" ? clip.matte : null;
  const models = useMatteModels();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const tryId = useRef(newId("m"));

  const [clicks, setClicks] = useState<EditMatteClick[]>(() => (existing?.clicks ?? []).slice());
  const [ms, setMs] = useState(() => snapMs(existing?.clicks?.[0]?.ms ?? span.fromMs, fps));
  const [negative, setNegative] = useState<"yes" | "no">("no");
  const [frameUrl, setFrameUrl] = useState("");
  const [frameFailed, setFrameFailed] = useState(false);
  const [tryJobId, setTryJobId] = useState("");
  const [tryError, setTryError] = useState<AppErrorShape | null>(null);
  const [tryUrl, setTryUrl] = useState("");
  const [tryFor, setTryFor] = useState<{ frame: number; clicks: EditMatteClick[] } | null>(null);
  const job = useJob(tryJobId);

  useEffect(() => panelRef.current?.focus(), []);

  // The frame under the picker (debounced while scrubbing).
  const path = clip?.path ?? "";
  useEffect(() => {
    if (!path) return;
    let live = true;
    const t = setTimeout(() => {
      MediaService.Frame(path, ms, 960).then(
        (u) => {
          if (!live) return;
          setFrameUrl(u);
          setFrameFailed(false);
        },
        () => live && setFrameFailed(true),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [path, ms]);

  // The try job's result: the mask PNG.
  useEffect(() => {
    if (!job || job.id !== tryJobId) return;
    if (job.status === JobStatus.JobFailed) {
      setTryError({ code: job.errorCode, message: job.error, hint: job.errorHint || undefined });
      return;
    }
    if (job.status !== JobStatus.JobDone) return;
    const r = resultOf(job);
    if (!r?.tryPath) return;
    let live = true;
    MediaService.URLFor(r.tryPath).then(
      (u) => live && setTryUrl(u),
      (e) => live && setTryError(toAppError(e)),
    );
    return () => {
      live = false;
    };
  }, [job, tryJobId]);

  if (!clip || !project) return null;

  const frame = frameOfMs(ms, fps);
  const here = clicks.filter((c) => frameOfMs(c.ms, fps) === frame);
  const elsewhere = clicks.length - here.length;
  const tooLong = span.toMs - span.fromMs > MAX_SELECT_MS;
  const trying = !!job && job.id === tryJobId && (job.status === JobStatus.JobQueued || job.status === JobStatus.JobRunning);
  const showTry = !!tryUrl && !trying && tryFor !== null && tryFor.frame === frame && sameClicks(tryFor.clicks, clicks);
  const missingModel = models !== null && (!models.select || !models.selectAvailable);
  const rebuild = !!existing && existing.clicks !== null && existing.clicks.length > 0;
  const seconds = estimateSeconds(span.toMs - span.fromMs, fps);

  const onFrameClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0 || clicks.length >= MAX_CLICKS) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setClicks([...clicks, { ms, x, y, positive: !(e.altKey || negative === "yes") }]);
  };

  const removeClick = (c: EditMatteClick) => setClicks(clicks.filter((k) => k !== c));

  const tryIt = async () => {
    if (!projectId || here.length === 0) return;
    setTryError(null);
    setTryUrl("");
    const sent = clicks.slice();
    const req: EditMatteRequest = {
      clipId,
      matteId: tryId.current,
      mode: "select",
      path,
      fromMs: span.fromMs,
      toMs: span.toMs,
      clicks: clicksFor(sent, ms, fps),
      preview: true,
    };
    try {
      const j = await EditStudioService.Matte(projectId, req);
      setTryFor({ frame, clicks: sent });
      setTryJobId(j.id);
    } catch (e) {
      setTryError(toAppError(e));
    }
  };

  const make = () => {
    onMake(clicks);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          Select a subject
        </h2>
        <p className={styles.help}>
          Click the person or thing to keep. Alt-click (or pick &ldquo;Not this&rdquo;) to mark what to leave out. Scrub to another frame to correct it.
        </p>

        {missingModel && (
          <Banner tone="warn" title="Subject select isn't ready">
            {models && !models.selectAvailable ? "Subject select isn't available on this computer." : PACK_HINT.select}
          </Banner>
        )}
        {tooLong && (
          <Banner tone="warn" title="This clip is too long">
            Subject select covers up to 60 seconds of a clip. Trim it first.
          </Banner>
        )}

        <div ref={frameRef} className={styles.frame} onClick={onFrameClick} data-testid="matte-frame" aria-label="Frame. Click the subject." data-tip="Click the subject to keep it; Alt-click marks what to leave out">
          {frameUrl && !frameFailed ? <img className={styles.img} src={frameUrl} alt="" draggable={false} /> : <div className={styles.placeholder}>{frameFailed ? "Couldn't load this frame" : "Loading the frame…"}</div>}
          {showTry && <img key={tryJobId} className={styles.mask} src={tryUrl} alt="Selection preview" draggable={false} />}
          {here.map((c, i) => (
            <button
              key={`${c.ms}-${c.x}-${c.y}-${i}`}
              type="button"
              className={c.positive ? styles.dotOn : styles.dotOff}
              style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
              aria-label={`${DOT_REMOVE_LABEL} (${c.positive ? "subject" : "not this"})`}
              data-tip={c.positive ? "A point on the subject; click to remove it" : "A point marking what to leave out; click to remove it"}
              onClick={() => removeClick(c)}
            />
          ))}
        </div>

        <div className={styles.scrub}>
          <Slider
            data-tip="Scrub to another frame of the clip to add corrections there"
            aria-label="Frame"
            value={ms}
            min={span.fromMs}
            max={Math.max(span.toMs, span.fromMs + 1)}
            step={1000 / fps}
            format={(v) => formatTimecode(v / 1000)}
            onChange={(v) => setMs(snapMs(v, fps))}
          />
        </div>

        <div className={styles.row}>
          <SegmentedControl
            size="sm"
            aria-label="Next click marks"
            value={negative}
            onChange={setNegative}
            options={[
              { value: "no", label: "The subject", tip: "Your next click marks the thing to keep" },
              { value: "yes", label: "Not this", tip: "Your next click marks something to leave out (same as Alt-click)" },
            ]}
          />
          <span className={styles.count} data-testid="matte-points" data-tip="Points you have clicked; more points on other frames improve the result">
            {clicks.length === 0 ? "No points yet" : `${clicks.length} point${clicks.length === 1 ? "" : "s"}${elsewhere ? `, ${elsewhere} on other frames` : ""}`}
          </span>
          <Button size="sm" variant="ghost" data-tip="Remove the last point you added" disabled={clicks.length === 0} onClick={() => setClicks(clicks.slice(0, -1))}>
            Undo point
          </Button>
          <Button size="sm" variant="ghost" data-tip="Remove all points and start again" disabled={clicks.length === 0} onClick={() => setClicks([])}>
            Clear
          </Button>
        </div>

        {tryError && (
          <Banner tone="danger" title={tryError.message}>
            {tryError.hint}
          </Banner>
        )}

        <div className={styles.footer}>
          <span className={styles.estimate} data-tip="A rough guess of how long the full cut-out will take">
            {!hasPositive(clicks) ? "Click the subject to begin." : `Making the cut-out takes ${describeEstimate(seconds)} on this computer.`}
          </span>
          <Button variant="secondary" data-tip="Close without keeping your changes to the cut-out" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" data-tip={missingModel ? "Subject select isn't ready; download its models first" : tooLong ? "Trim the clip to 60 seconds or less first" : !hasPositive(clicks) ? "Click the subject first" : here.length === 0 ? "Add a point on this frame to try it here" : "Preview the selection on this one frame before making the whole cut-out"} disabled={here.length === 0 || !hasPositive(clicks) || trying || missingModel || tooLong} onClick={() => void tryIt()}>
            {trying ? (
              <>
                <Spinner size={12} label="Trying" /> Trying…
              </>
            ) : (
              "Try on this frame"
            )}
          </Button>
          <Button variant="primary" data-tip={missingModel ? "Subject select isn't ready; download its models first" : tooLong ? "Trim the clip to 60 seconds or less first" : !hasPositive(clicks) ? "Click the subject first" : "Cut the subject out across the whole clip; it runs in the background"} disabled={!hasPositive(clicks) || missingModel || tooLong} onClick={make}>
            {rebuild ? "Rebuild cut-out" : "Make cut-out"}
          </Button>
        </div>
      </div>
    </div>
  );
}
