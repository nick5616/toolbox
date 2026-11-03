/** The Inspector's Cut-out section and the subject-select dialog (§10.7). The props are frozen. */
import { useEffect, useMemo, useState } from "react";
import { Badge, Banner, Button, ColorSwatchPicker, Meter, Section, SegmentedControl, Slider, Switch, toast } from "@/components";
import { EditStudioService, JobsService, type EditClip, type EditMatte, type EditMatteClick, type EditMatteRequest } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { clipSourceSpan, findClip, newId, withClip } from "../doc";
import { useEditStudio, useProject } from "../store";
import { flushEdit } from "../useEditAutosave";
import { MatteDialog } from "./MatteDialog";
import { followMatteJob, jobPhase, useMatteJob } from "./matteJobs";
import { MODE_LABEL, makeMatte, matteStatus, modesFor, type MatteMode, type MatteStatus } from "./matteUtil";
import { splitSubject } from "./split";
import { PACK_HINT, useMatteModels } from "./useMatteModels";
import styles from "./CutoutSection.module.css";

export interface CutoutSectionProps {
  clipId: string;
}

const FX_OPTIONS = [
  { value: "clip", label: "Clip" },
  { value: "subject", label: "Subject" },
  { value: "background", label: "Background" },
] as const;
type FxTarget = (typeof FX_OPTIONS)[number]["value"];

const STATUS_LABEL: Record<MatteStatus, string> = {
  none: "No cut-out yet",
  making: "Making the cut-out",
  ready: "Ready",
  stale: "Out of date",
  missing: "Cut-out files missing",
  failed: "Couldn't make the cut-out",
};

export function CutoutSection({ clipId }: CutoutSectionProps) {
  const project = useProject();
  const edit = useEditStudio((s) => s.edit);
  const projectId = useEditStudio((s) => s.projectId);
  const mattes = useEditStudio((s) => s.mattes);
  const ref = project ? findClip(project, clipId) : null;
  const clip: EditClip | null = ref?.clip ?? null;
  const matte = clip?.matte ?? null;
  const fps = project?.fps ?? 30;
  const span = useMemo(() => (clip && clip.kind === "video" ? clipSourceSpan(clip, fps) : { fromMs: 0, toMs: 0 }), [clip, fps]);
  const job = useMatteJob(matte?.id ?? "");
  const models = useMatteModels();
  const [pending, setPending] = useState<MatteMode | null>(null);
  const [error, setError] = useState<AppErrorShape | null>(null);
  const [dialog, setDialog] = useState(false);
  const phase = jobPhase(job);
  const jobId = job?.id ?? "";
  const matteId = matte?.id ?? "";

  // A running job outlives this section (and a reopened edit finds it again).
  useEffect(() => {
    if (matteId && jobId && phase === "active") followMatteJob(matteId, jobId);
  }, [matteId, jobId, phase]);

  if (!project || !clip) return null;
  const modes = modesFor(clip.kind);
  if (modes.length === 0) return null;

  const mode: MatteMode = pending && modes.includes(pending) ? pending : matte && modes.includes(matte.mode as MatteMode) ? (matte.mode as MatteMode) : (modes[0] as MatteMode);
  const status = matteStatus(matte, matte ? mattes[matte.id] : undefined, span, phase);
  const ready = status === "ready";
  const modeMissing =
    models !== null && ((mode === "people" && !models.people) || (mode === "select" && (!models.select || !models.selectAvailable)) || (mode === "image" && !models.image));
  const modeHint = mode === "select" && models && !models.selectAvailable ? "Subject select isn't available on this computer" : PACK_HINT[mode];

  const patch = (over: Partial<EditMatte>, key: string) => {
    if (!matte) return;
    edit(withClip(project, clip.id, { matte: { ...matte, ...over } }), `matte:${clip.id}:${key}`);
  };

  /** Starts a matte job: saves, records the new matte in the clip, submits, then follows the job. */
  const make = async (m: MatteMode, clicks: EditMatteClick[]) => {
    if (!projectId) return;
    setError(null);
    const id = newId("m");
    const next = makeMatte(m, id, span, clicks, matte);
    const req: EditMatteRequest = { clipId: clip.id, matteId: id, mode: m, path: clip.path, fromMs: next.fromMs, toMs: next.toMs, clicks: next.clicks, preview: false };
    try {
      edit(withClip(project, clip.id, { matte: next }), `matte-make:${clip.id}`);
      await flushEdit();
      const j = await EditStudioService.Matte(projectId, req);
      useEditStudio.getState().setMatteJob(id, j.id);
      followMatteJob(id, j.id);
    } catch (e) {
      const err = toAppError(e);
      setError(err);
      toast({ title: err.message, tone: "danger" });
    }
  };

  const start = () => {
    if (mode === "select") setDialog(true);
    else void make(mode, []);
  };

  const split = () => {
    const next = splitSubject(project, clip.id);
    if (next) edit(next, "");
  };

  const rebuilding = matte !== null && matte.mode === mode;
  const percent = job && job.progress >= 0 ? Math.round(job.progress * 100) : null;
  const canSplit = matte !== null && ready && splitSubject(project, clip.id) !== null;

  return (
    <Section label="Cut-out">
      <div className={styles.root}>
        {modes.length > 1 ? (
          <SegmentedControl
            size="sm"
            aria-label="Cut-out kind"
            value={mode}
            onChange={setPending}
            options={modes.map((m) => ({
              value: m,
              label: MODE_LABEL[m],
              disabled: m === "select" && models !== null && !models.selectAvailable,
            }))}
          />
        ) : (
          <span className={styles.kind}>{MODE_LABEL[mode]}</span>
        )}

        <div className={styles.status} role="status">
          <Badge tone={status === "ready" ? "ok" : status === "failed" ? "danger" : status === "none" ? "neutral" : "warn"}>{STATUS_LABEL[status]}</Badge>
          {status === "making" && (
            <>
              <Meter value={job?.progress ?? -1} label="Cut-out progress" size="sm" />
              <span className={styles.pct}>{percent !== null ? `${percent} %` : job?.message || "Working"}</span>
              <Button size="sm" variant="ghost" onClick={() => job && void JobsService.Cancel(job.id).catch(() => undefined)}>
                Cancel
              </Button>
            </>
          )}
        </div>

        {status === "stale" && (
          <Banner tone="warn" title="Matte out of date">
            The clip now shows more of the source than the cut-out covers. Rebuild it{matte?.mode === "select" ? " (your points are kept)" : ""}.
          </Banner>
        )}
        {status === "failed" && job && (
          <Banner tone="danger" title={job.error || "The cut-out failed"}>
            {job.errorHint}
          </Banner>
        )}
        {error && status !== "failed" && (
          <Banner tone="danger" title={error.message}>
            {error.hint}
          </Banner>
        )}
        {modeMissing && status !== "making" && (
          <Banner tone="warn" title="This cut-out needs a download">
            {modeHint}
          </Banner>
        )}

        {status !== "making" && (
          <div className={styles.actions}>
            {matte === null || !rebuilding ? (
              <Button size="sm" variant="primary" disabled={modeMissing} onClick={start}>
                {mode === "select" ? "Select a subject…" : mode === "image" ? "Cut out the subject" : "Cut out people"}
              </Button>
            ) : status === "failed" ? (
              <Button size="sm" variant="primary" disabled={modeMissing} onClick={() => void make(mode, matte.clicks ?? [])}>
                Retry
              </Button>
            ) : (
              <Button size="sm" variant={status === "ready" ? "secondary" : "primary"} disabled={modeMissing} onClick={start}>
                {mode === "select" ? "Edit points…" : "Rebuild"}
              </Button>
            )}
            {rebuilding && mode === "select" && status !== "ready" && status !== "failed" && (
              <Button size="sm" variant="primary" disabled={modeMissing} onClick={() => void make("select", matte.clicks ?? [])}>
                Rebuild
              </Button>
            )}
            {canSplit && (
              <Button size="sm" variant="ghost" onClick={split}>
                Split subject
              </Button>
            )}
          </div>
        )}

        {matte && (
          <div className={styles.controls}>
            <Switch label="Cut-out (show only the subject)" checked={matte.cutout} onChange={(v) => patch({ cutout: v }, "cutout")} />
            <Switch label="Invert" checked={matte.invert} onChange={(v) => patch({ invert: v }, "invert")} />
            <label className={styles.field}>
              <span>Feather</span>
              <Slider aria-label="Feather" min={0} max={1} step={0.01} value={matte.feather} format={(v) => `${v.toFixed(2)} %`} onChange={(v) => patch({ feather: v }, "feather")} />
            </label>
            <label className={styles.field}>
              <span>Stroke</span>
              <Slider aria-label="Stroke width" min={0} max={40} step={1} value={matte.stroke.px} format={(v) => `${v} px`} onChange={(v) => patch({ stroke: { ...matte.stroke, px: v } }, "stroke")} />
            </label>
            <div className={styles.colour}>
              <ColorSwatchPicker aria-label="Stroke colour" value={matte.stroke.color || "#ffffff"} onChange={(c) => patch({ stroke: { ...matte.stroke, color: c } }, "stroke-colour")} />
            </div>
            <label className={styles.field}>
              <span>Glow</span>
              <Slider aria-label="Glow amount" min={0} max={1} step={0.01} value={matte.glow.amount} format={(v) => v.toFixed(2)} onChange={(v) => patch({ glow: { ...matte.glow, amount: v } }, "glow")} />
            </label>
            <div className={styles.colour}>
              <ColorSwatchPicker aria-label="Glow colour" value={matte.glow.color || "#ffffff"} onChange={(c) => patch({ glow: { ...matte.glow, color: c } }, "glow-colour")} />
            </div>
          </div>
        )}

        {matte && (
          <div className={styles.fx}>
            <span className={styles.fxLabel}>Effects apply to</span>
            <SegmentedControl
              size="sm"
              aria-label="Effects apply to"
              value={(clip.fxTarget || "clip") as FxTarget}
              onChange={(v) => edit(withClip(project, clip.id, { fxTarget: v }), `fx-target:${clip.id}`)}
              options={FX_OPTIONS.map((o) => ({ value: o.value, label: o.label, disabled: o.value !== "clip" && !ready }))}
            />
            {!ready && <span className={styles.hint}>Subject and Background need a ready cut-out.</span>}
          </div>
        )}
      </div>

      {dialog && <MatteDialog clipId={clip.id} onClose={() => setDialog(false)} onMake={(clicks) => void make("select", clicks)} />}
    </Section>
  );
}
