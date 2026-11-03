/** A clip's Source section (§14.8): file, in point, speed, slow motion, volume, fit, flip, blend. */
import { useEffect, useRef } from "react";
import { Button, ColorSwatchPicker, Section, Select, Slider, Stepper, Switch, toast } from "@/components";
import { EditStudioService, JobStatus, type EditClip } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useJobs } from "@/state/jobs";
import { parseSpeed, serializeSpeed } from "@/viz/edit/schema";
import type { EditParam } from "@/viz/edit/types";
import { clipSourceSpan } from "../doc";
import { interpKey, useEditStudio } from "../store";
import { flushEdit } from "../useEditAutosave";
import { EditParamEditor } from "./EditParamEditor";
import { isKeyed, paramBase } from "./paramOps";
import styles from "./inspector.module.css";

export const INTERP_LABEL = "Synthesized in-between frames (slow motion)";

const FIT_OPTIONS = [
  { value: "fill", label: "Fill (crop to frame)" },
  { value: "fit", label: "Fit (bars)" },
  { value: "fit-blur", label: "Fit over blurred copy" },
  { value: "fit-color", label: "Fit over colour" },
];
const BLEND_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "add", label: "Add" },
  { value: "screen", label: "Screen" },
  { value: "multiply", label: "Multiply" },
];
const SLOW_OPTIONS = [
  { value: "blend", label: "Blend neighbouring frames" },
  { value: "none", label: "Nearest frame" },
  { value: "interpolate", label: INTERP_LABEL },
];

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export interface SourceSectionProps {
  clip: EditClip;
  fps: number;
  clipTimeMs: number;
  /** `key` is stable while one field is edited ("" for one-off changes). */
  onChange(patch: Partial<EditClip>, key: string): void;
}

export function SourceSection({ clip, fps, clipTimeMs, onChange }: SourceSectionProps) {
  const isVideo = clip.kind === "video";
  const hasSource = clip.kind === "video" || clip.kind === "image";
  const speed = parseSpeed(clip.speed).value;
  const speedKeyed = isKeyed(speed);
  const slow = clip.slow === "" ? "blend" : clip.slow;
  const setSpeed = (p: EditParam, key: string) => onChange({ speed: serializeSpeed(p) }, key);

  return (
    <Section label="Source">
      <div className={styles.stack}>
        {hasSource && (
          <div className={styles.row}>
            <span className={styles.label}>File</span>
            <span className={styles.mono} title={clip.path}>
              {baseName(clip.path)}
            </span>
          </div>
        )}
        {clip.kind === "color" && (
          <div className={styles.colorRow}>
            <span className={styles.label}>Colour</span>
            <ColorSwatchPicker aria-label="Clip colour" value={clip.color || "#000000"} onChange={(color) => onChange({ color }, `${clip.id}:color`)} />
          </div>
        )}
        {isVideo && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>In point</span>
              <Stepper aria-label="In point" unit="ms" min={0} step={100} value={clip.inMs} onChange={(inMs) => onChange({ inMs: Math.round(inMs) }, `${clip.id}:in`)} />
            </div>
            <div className={styles.stack}>
              <Switch
                label="Speed changes over time"
                checked={speedKeyed}
                onChange={(on) => setSpeed(on ? { base: paramBase(speed), keys: [{ t: 0, v: paramBase(speed), ease: "ease" }] } : paramBase(speed), "")}
              />
              {speedKeyed ? (
                <EditParamEditor
                  spec={{ min: 0, max: 4, step: 0.05, label: "Speed" }}
                  value={speed}
                  clipTimeMs={clipTimeMs}
                  allowKeys
                  allowMods={false}
                  format={(v) => `${v.toFixed(2)}×`}
                  onChange={(next, key) => setSpeed(next, key ? `${clip.id}:${key}` : "")}
                />
              ) : (
                <>
                  <span className={styles.label}>Speed</span>
                  <Slider
                    aria-label="Speed"
                    min={0.1}
                    max={4}
                    step={0.05}
                    value={Math.max(0.1, paramBase(speed))}
                    onChange={(v) => setSpeed(Math.round(v * 100) / 100, `${clip.id}:speed`)}
                    format={(v) => `${v.toFixed(2)}×`}
                  />
                </>
              )}
            </div>
            <div className={styles.stack}>
              <div className={styles.row}>
                <span className={styles.label}>Slow motion</span>
                <Select size="sm" aria-label="Slow motion" value={slow} onChange={(v) => onChange({ slow: v === "blend" ? "" : v }, "")} options={SLOW_OPTIONS} />
              </div>
              {slow === "interpolate" && <InterpControl clip={clip} fps={fps} />}
            </div>
            <div className={styles.stack}>
              <span className={styles.label}>Volume</span>
              <Slider
                aria-label="Volume"
                min={0}
                max={2}
                step={0.05}
                value={clip.volume}
                onChange={(volume) => onChange({ volume }, `${clip.id}:volume`)}
                format={(v) => `${Math.round(v * 100)}%`}
              />
              <p className={styles.hint}>Heard in the export. The preview is silent.</p>
              {speedKeyed && <p className={styles.hint}>Audio is off while the speed changes.</p>}
            </div>
          </>
        )}
        {hasSource && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>Fit</span>
              <Select size="sm" aria-label="Fit" value={clip.fit || "fill"} onChange={(fit) => onChange({ fit }, "")} options={FIT_OPTIONS} />
            </div>
            {clip.fit === "fit-color" && (
              <div className={styles.colorRow}>
                <span className={styles.label}>Fit colour</span>
                <ColorSwatchPicker aria-label="Fit colour" value={clip.fitColor || "#000000"} onChange={(fitColor) => onChange({ fitColor }, `${clip.id}:fitcolor`)} />
              </div>
            )}
            <Switch label="Flip horizontally" checked={clip.flipX} onChange={(flipX) => onChange({ flipX }, "")} />
          </>
        )}
        <div className={styles.row}>
          <span className={styles.label}>Blend</span>
          <Select size="sm" aria-label="Blend" value={clip.blend || "normal"} onChange={(blend) => onChange({ blend }, "")} options={BLEND_OPTIONS} />
        </div>
      </div>
    </Section>
  );
}

/** Status of the clip's interpolated stream and the Make button. */
function InterpControl({ clip, fps }: { clip: EditClip; fps: number }) {
  const projectId = useEditStudio((s) => s.projectId);
  const span = clipSourceSpan(clip, fps);
  const key = interpKey(clip.path, span.fromMs, span.toMs);
  const have = useEditStudio((s) => !!s.interps[key]);
  const jobId = useEditStudio((s) => s.jobs.interps[key]);
  const status = useJobs((s) => (jobId ? s.byId[jobId]?.status : undefined));
  const asked = useRef(new Set<string>());

  const load = async () => {
    try {
      const st = await EditStudioService.InterpFor(clip.path, span.fromMs, span.toMs, fps);
      if (st) useEditStudio.getState().setInterp(key, st);
    } catch {
      // not made yet
    }
  };

  // Pick up a stream made earlier (once per range).
  useEffect(() => {
    if (have || jobId || asked.current.has(key)) return;
    asked.current.add(key);
    void (async () => {
      try {
        const st = await EditStudioService.InterpFor(clip.path, span.fromMs, span.toMs, fps);
        if (st) useEditStudio.getState().setInterp(key, st);
      } catch {
        // not made yet
      }
    })();
  }, [have, jobId, key, clip.path, span.fromMs, span.toMs, fps]);

  // The job ended: load its stream, or say it failed.
  useEffect(() => {
    if (!jobId) return;
    if (status === JobStatus.JobDone) {
      void load().finally(() => useEditStudio.getState().setInterpJob(key, undefined));
    } else if (status === JobStatus.JobFailed || status === JobStatus.JobCancelled) {
      useEditStudio.getState().setInterpJob(key, undefined);
      if (status === JobStatus.JobFailed) toast({ title: "Couldn't make the slow motion", tone: "danger" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status]);

  const make = async () => {
    if (!projectId) return;
    try {
      await flushEdit();
      const job = await EditStudioService.Interpolate(projectId, { path: clip.path, fromMs: span.fromMs, toMs: span.toMs, fps });
      useEditStudio.getState().setInterpJob(key, job.id);
      useJobs.getState().upsert(job);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  if (have) return <p className={styles.hint}>{INTERP_LABEL}: ready for this range.</p>;
  if (jobId) return <p className={styles.hint}>Making slow motion…</p>;
  return (
    <div className={styles.stack}>
      <p className={styles.hint}>Until it is made, the clip uses blended frames.</p>
      <Button size="sm" onClick={() => void make()}>
        Make
      </Button>
    </div>
  );
}
