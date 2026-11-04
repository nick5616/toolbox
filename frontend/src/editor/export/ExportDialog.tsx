/**
 * The Export dialog, its checks and the done banner (§14.10). Props are frozen
 * (Wave 0). The dialog is a modal; the progress/result banner (ExportBanner)
 * is rendered here too so it outlives the dialog.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Banner, Button, Select, Spinner, toast } from "@/components";
import { EditStudioService, type EditMatteRequest } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isActive, useJobs } from "@/state/jobs";
import { editLength } from "@/viz/edit/types";
import { flushEdit } from "@/editor/useEditAutosave";
import { refreshMattes, refreshSources } from "@/editor/useEditData";
import { useEditStudio, useProject } from "@/editor/store";
import { ExportBanner } from "./ExportBanner";
import { newId, withClip } from "@/editor/doc";
import { followMatteJob } from "../matte/matteJobs";
import { makeMatte, type MatteMode } from "../matte/matteUtil";
import { baseName, exportChecks, formatLength, normalizeHeight, rebuildRequest, sizeLabel, withoutCutouts, EXPORT_HEIGHTS, type ExportHeight } from "./checks";
import styles from "./ExportDialog.module.css";

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
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
  const d = editLength(project);
  const frames = Math.round((d / 1000) * project.fps);
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

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const st = useEditStudio.getState();
      const p = st.history?.present;
      if (p && p.exportHeight !== height) st.edit({ ...p, exportHeight: height }, "exportHeight");
      await flushEdit();
      const after = useEditStudio.getState();
      if (after.saveState === "error") {
        setError(after.saveError ?? "Couldn't save the edit");
        return;
      }
      if (!after.projectId) return;
      const job = await EditStudioService.Render(after.projectId);
      useJobs.getState().upsert(job);
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
            <span className={styles.value} data-tip="Frames per second of the export, fixed when the edit was created">{project.fps} fps</span>
            <span className={styles.hint}>Set in the edit's setup</span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Length</span>
            <span className={styles.value} data-tip="Length of the edit and how many frames will be rendered">
              {formatLength(d)} · {frames} frames
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
          <Button variant="primary" icon="download" data-tip={exportTip} disabled={blocked} onClick={() => void start()}>
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
