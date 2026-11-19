/**
 * The Export dialog, its checks and the done banner (§14.10). Props are frozen
 * (Wave 0). The dialog is a modal; the progress/result banner (ExportBanner)
 * is rendered here too so it outlives the dialog.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Banner, Button, Select, Spinner, toast } from "@/components";
import { EditStudioService, type EditMatteRequest, type Job } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { announceWhenDone, isActive, useJobs } from "@/state/jobs";
import { editLength } from "@/viz/edit/types";
import { flushEdit } from "@/editor/useEditAutosave";
import { refreshMattes, refreshSources } from "@/editor/useEditData";
import { useEditStudio, useProject } from "@/editor/store";
import { ExportBanner } from "./ExportBanner";
import { newId, withClip } from "@/editor/doc";
import { followMatteJob } from "../matte/matteJobs";
import { makeMatte, type MatteMode } from "../matte/matteUtil";
import {
  baseName,
  estimateExportBytes,
  exportChecks,
  formatBytes,
  formatLength,
  normalizeExportSettings,
  normalizeHeight,
  rebuildRequest,
  sizeLabel,
  withoutCutouts,
  EXPORT_AUDIO_KBPS,
  EXPORT_CODECS,
  EXPORT_FPS,
  EXPORT_HEIGHTS,
  EXPORT_QUALITIES,
  type ExportCodec,
  type ExportHeight,
  type ExportQuality,
} from "./checks";
import styles from "./ExportDialog.module.css";
import { useTimelineRange } from "@/editor/timeline/timelineStore";

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The render calls E1 adds next to Render; until the bindings carry them they're looked up by name. */
interface ExtraRenders {
  RenderAudio?(projectID: string): Promise<Job>;
  RenderStill?(projectID: string, atMs: number): Promise<Job>;
}
const extraRenders = (): ExtraRenders => EditStudioService as unknown as ExtraRenders;

type Kind = "video" | "audio" | "still";
const QUALITY_LABEL: Record<ExportQuality, string> = { draft: "Draft", good: "Good", best: "Best" };
const QUALITY_TIP: Record<ExportQuality, string> = {
  draft: "Fastest and smallest: fine for a quick look, with visible softness in busy scenes",
  good: "A good balance of sharpness and file size for sharing",
  best: "Sharpest, and the biggest file; takes the longest",
};
const FOCUSABLE = "button:not(:disabled), select:not(:disabled)";

function Panel({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const project = useProject();
  const sources = useEditStudio((s) => s.sources);
  const mattes = useEditStudio((s) => s.mattes);
  const matteJobs = useEditStudio((s) => s.jobs.mattes);
  const jobsById = useJobs((s) => s.byId);

  const [height, setHeight] = useState<ExportHeight>(normalizeHeight(project?.exportHeight ?? 1080));
  const saved = useMemo(() => normalizeExportSettings(project?.export), []); // eslint-disable-line react-hooks/exhaustive-deps -- the dialog starts from what was saved
  const range = useTimelineRange();
  const [fps, setFps] = useState<number>(saved.fps);
  const [codec, setCodec] = useState<ExportCodec>(saved.codec as ExportCodec);
  const [quality, setQuality] = useState<ExportQuality>(saved.quality as ExportQuality);
  const [audioKbps, setAudioKbps] = useState<number>(saved.audioKbps);
  const [useRange, setUseRange] = useState(saved.outMs > saved.inMs && range !== null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Fresh source and matte states before the checks speak.
  useEffect(() => {
    let live = true;
    void Promise.all([refreshSources(), refreshMattes()]).then(() => live && setChecked(true));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const checks = useMemo(() => (project ? exportChecks(project, sources, mattes) : null), [project, sources, mattes]);
  const rebuilding = useMemo(() => {
    if (!checks) return 0;
    return checks.badMattes.filter((c) => {
      const id = c.matte ? matteJobs[c.matte.id] : undefined;
      const j = id ? jobsById[id] : undefined;
      return !!j && isActive(j);
    }).length;
  }, [checks, matteJobs, jobsById]);
  // A rebuild that just finished: read the new matte states.
  const wasRebuilding = useRef(0);
  useEffect(() => {
    if (wasRebuilding.current > 0 && rebuilding === 0) void refreshMattes();
    wasRebuilding.current = rebuilding;
  }, [rebuilding]);

  if (!project || !checks) return null;
  const whole = editLength(project);
  const ranged = useRange && range ? { inMs: Math.max(0, range.inMs), outMs: Math.min(whole, range.outMs) } : null;
  const d = ranged ? Math.max(0, ranged.outMs - ranged.inMs) : whole;
  const outFps = fps || project.fps;
  const frames = Math.round((d / 1000) * outFps);
  const estimate = estimateExportBytes({ aspect: project.aspect, height, fps: outFps, codec, quality, audioKbps, lengthMs: d });
  const waitingOnPrep = checks.preparing.length > 0;
  const blockers: string[] = [];
  // The song is optional (Video Editor); an edit that points at an analysis keeps it checked by the export itself.
  if (checks.clipCount === 0) blockers.push("Add a clip to the edit first.");
  const blocked = blockers.length > 0 || waitingOnPrep || checks.missing.length > 0 || checks.badMattes.length > 0 || !checked || busy;
  const badCount = checks.badMattes.length;
  const exportTip = blockers[0] ?? (!checked ? "Still checking your files" : waitingOnPrep ? "Wait for the clips to finish preparing" : checks.missing.length > 0 ? "Some files are missing: put them back or remove those clips" : badCount > 0 ? "Fix the cut-outs above first" : busy ? "Starting the export" : "Render the edit to a video file in your library");

  const rebuild = async () => {
    const st = useEditStudio.getState();
    const doc = st.history?.present;
    if (!st.projectId || !doc) return;
    setError("");
    try {
      // Like the Cut-out section: every rebuild gets a fresh matte ID (no stale files in the engine's caches).
      let next = doc;
      const reqs: EditMatteRequest[] = [];
      for (const c of checks.badMattes) {
        const old = rebuildRequest(c, project.fps);
        if (!old || !c.matte) continue;
        const id = newId("m");
        const matte = makeMatte(c.matte.mode as MatteMode, id, { fromMs: old.fromMs, toMs: old.toMs }, c.matte.clicks ?? [], c.matte);
        next = withClip(next, c.id, { matte });
        reqs.push({ ...old, matteId: id, fromMs: matte.fromMs, toMs: matte.toMs });
      }
      if (next !== doc) st.edit(next);
      await flushEdit(); // the matte IDs are in the saved document
      for (const req of reqs) {
        const job = await EditStudioService.Matte(st.projectId, req);
        useJobs.getState().upsert(job);
        useEditStudio.getState().setMatteJob(req.matteId, job.id);
        followMatteJob(req.matteId, job.id);
      }
    } catch (e) {
      setError(toAppError(e).message);
    }
  };

  const removeCutouts = () => {
    const ids = new Set(checks.badMattes.map((c) => c.id));
    useEditStudio.getState().edit(withoutCutouts(project, ids));
  };

  const submit = async (kind: Kind) => {
    setBusy(true);
    setError("");
    try {
      const st = useEditStudio.getState();
      const p = st.history?.present;
      const settings = { fps, codec, quality, audioKbps, inMs: ranged?.inMs ?? 0, outMs: ranged?.outMs ?? 0 };
      if (p) {
        const next = { ...p, exportHeight: height, export: normalizeExportSettings(settings) };
        if (p.exportHeight !== next.exportHeight || JSON.stringify(p.export ?? null) !== JSON.stringify(next.export)) st.edit(next, "export-settings");
      }
      await flushEdit();
      const after = useEditStudio.getState();
      if (after.saveState === "error") {
        setError(after.saveError ?? "Couldn't save the edit");
        return;
      }
      if (!after.projectId) return;
      let job: Job;
      if (kind === "audio") {
        const call = extraRenders().RenderAudio;
        if (!call) throw new Error("Audio-only export isn't available in this build yet");
        job = await call.call(EditStudioService, after.projectId);
      } else if (kind === "still") {
        const call = extraRenders().RenderStill;
        if (!call) throw new Error("Still-frame export isn't available in this build yet");
        job = await call.call(EditStudioService, after.projectId, Math.round(after.playheadMs));
      } else {
        job = await EditStudioService.Render(after.projectId);
      }
      useJobs.getState().upsert(job);
      announceWhenDone(job.id); // leaving the project list wipes jobs.render; the toast still says where it went
      useEditStudio.getState().setJob("render", job.id);
      onClose();
    } catch (e) {
      const msg = toAppError(e).message;
      setError(msg);
      toast({ title: msg, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div ref={panel} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 id={titleId} className={styles.title}>
          Export video
        </h2>

        <div className={styles.form}>
          <div className={styles.field}>
            <span className={styles.label}>Size</span>
            <Select
              size="sm"
              aria-label="Size"
              data-tip="Height of the exported video; the width follows the edit's shape. Bigger is sharper but slower"
              value={String(height)}
              onChange={(v) => setHeight(normalizeHeight(Number(v)))}
              options={EXPORT_HEIGHTS.map((h) => ({ value: String(h), label: `${sizeLabel(project.aspect, h)} (${h}p)` }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Frame rate</span>
            <Select
              size="sm"
              aria-label="Frame rate"
              data-tip="Frames per second of the export. Project uses the edit's own rate"
              value={String(fps)}
              onChange={(v) => setFps(Number(v))}
              options={EXPORT_FPS.map((f) => ({ value: String(f), label: f === 0 ? `Project (${project.fps} fps)` : `${f} fps` }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Format</span>
            <Select
              size="sm"
              aria-label="Format"
              data-tip="MP4 with H.264 plays everywhere; H.265 makes smaller files but some apps can't open it"
              value={codec}
              onChange={(v) => setCodec(v)}
              options={EXPORT_CODECS.map((c) => ({ value: c, label: c === "h264" ? "H.264 MP4" : "H.265 MP4" }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Quality</span>
            <Select
              size="sm"
              aria-label="Quality"
              data-tip={QUALITY_TIP[quality]}
              value={quality}
              onChange={(v) => setQuality(v)}
              options={EXPORT_QUALITIES.map((q) => ({ value: q, label: QUALITY_LABEL[q] }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Audio</span>
            <Select
              size="sm"
              aria-label="Audio"
              data-tip="Audio quality in kilobits per second; higher sounds cleaner and adds a little size"
              value={String(audioKbps)}
              onChange={(v) => setAudioKbps(Number(v))}
              options={EXPORT_AUDIO_KBPS.map((k) => ({ value: String(k), label: `${k} kb/s` }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Range</span>
            <Select
              size="sm"
              aria-label="Range"
              data-tip={range ? "Export the whole edit, or only between the In and Out points" : "Set In and Out points on the timeline (I and O) to export just that part"}
              value={useRange && range ? "range" : "whole"}
              onChange={(v) => setUseRange(v === "range")}
              options={[
                { value: "whole", label: "Whole edit" },
                { value: "range", label: range ? `In–Out (${formatLength(range.inMs)}–${formatLength(range.outMs)})` : "In–Out (set In and Out first)", disabled: !range },
              ]}
            />
            {!range && <span className={styles.hint}>Set In and Out points first</span>}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Length</span>
            <span className={styles.value} data-tip="Length of the export and how many frames will be rendered">
              {formatLength(d)} · {frames} frames
            </span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Estimated size</span>
            <span className={styles.value} data-tip="A rough guess from the size, quality and length; the real file can differ by a third either way">
              ≈ {formatBytes(estimate)}
            </span>
          </div>
        </div>

        {!checked && (
          <div className={styles.checking} role="status">
            <Spinner size={14} /> Checking your files…
          </div>
        )}
        {blockers.map((b) => (
          <Banner key={b} tone="warn" title={b} />
        ))}
        {checked && waitingOnPrep && (
          <Banner tone="warn" title={`Wait for ${plural(checks.preparing.length, "clip", "clips")} to finish preparing`}>
            {checks.preparing.map(baseName).join(", ")}
          </Banner>
        )}
        {checked && checks.missing.length > 0 && (
          <Banner tone="danger" title={`${plural(checks.missing.length, "file is", "files are")} missing`}>
            <ul className={styles.list}>
              {checks.missing.map((m) => (
                <li key={m.path} data-tip={m.path}>
                  {baseName(m.path)}
                  <span className={styles.hint}> — {m.reason}</span>
                </li>
              ))}
            </ul>
            Put them back, or remove those clips from the edit.
          </Banner>
        )}
        {checked && badCount > 0 && (
          <Banner
            tone="warn"
            title={
              rebuilding > 0
                ? `Rebuilding ${plural(rebuilding, "cut-out", "cut-outs")}…`
                : `${plural(badCount, "cut-out isn't", "cut-outs aren't")} ready or ${badCount === 1 ? "is" : "are"} out of date`
            }
            action={
              rebuilding > 0 ? (
                <Spinner size={14} />
              ) : (
                <div className={styles.actions}>
                  <Button size="sm" data-tip="Make the cut-outs again so they are ready for the export" onClick={() => void rebuild()}>
                    Rebuild
                  </Button>
                  <Button size="sm" data-tip="Export those clips without their cut-out; the clips stay in the edit" onClick={removeCutouts}>
                    Remove the cut-out from those clips
                  </Button>
                </div>
              )
            }
          >
            {checks.badMattes.map((c) => baseName(c.path)).join(", ")}
          </Banner>
        )}
        {checked && checks.unprepared.length > 0 && !waitingOnPrep && (
          <p className={styles.note}>
            {plural(checks.unprepared.length, "file isn't", "files aren't")} prepared for editing yet, so the export will prepare {checks.unprepared.length === 1 ? "it" : "them"} first.
          </p>
        )}
        {error && <Banner tone="danger" title={error} />}

        <div className={styles.footer}>
          <Button variant="secondary" data-tip="Close without exporting" onClick={onClose}>
            Cancel
          </Button>
          <span className={styles.spacer} />
          <Button variant="secondary" icon="music" data-tip={blocked ? exportTip : "Export only the sound of the edit as an .m4a file"} disabled={blocked} onClick={() => void submit("audio")}>
            Audio only (.m4a)
          </Button>
          <Button variant="secondary" icon="image" data-tip={blocked ? exportTip : "Export the frame under the playhead as a .png picture"} disabled={blocked} onClick={() => void submit("still")}>
            Still frame (.png)
          </Button>
          <Button variant="primary" icon="download" data-tip={exportTip} disabled={blocked} onClick={() => void submit("video")}>
            Export
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  return (
    <>
      {open && <Panel onClose={onClose} />}
      <ExportBanner />
    </>
  );
}
