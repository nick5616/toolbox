import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, EmptyState, Icon, Section, SegmentedControl, cx, toast } from "@/components";
import { JobStatus, LibraryService, StemsFormat, StemsService, type PresetInfo, type StemsPreset } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useOrderedJobs, type JobView } from "@/state/jobs";
import { FileToolLayout, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import { DEFAULT_STEMS_OPTIONS, dirname, parseStemsResult, sanitizeStemsOptions } from "./options";
import styles from "./StemsView.module.css";

const MAX_GROUPS = 10;

interface PresetCardsProps {
  presets: PresetInfo[];
  value: string;
  onChange: (id: string) => void;
}

function PresetCards({ presets, value, onChange }: PresetCardsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = presets.findIndex((p) => p.id === value);
  const tabbable = selected >= 0 ? selected : 0;

  const move = (from: number, dir: 1 | -1) => {
    const n = presets.length;
    const i = (from + dir + n) % n;
    const p = presets[i];
    if (!p) return;
    onChange(p.id);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    }
  };

  return (
    <div role="radiogroup" aria-label="Preset" className={styles.cards}>
      {presets.map((p, i) => {
        const checked = p.id === value;
        return (
          <button
            key={p.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabbable ? 0 : -1}
            className={cx(styles.card, checked && styles.selected)}
            onClick={() => onChange(p.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className={styles.cardHead}>
              <span className={styles.label}>{p.label}</span>
              <Badge tone={p.speed === "best" ? "accent" : "neutral"}>{p.speed}</Badge>
            </span>
            <span className={styles.chips}>
              {(p.stems ?? []).map((s) => (
                <Badge key={s} mono>
                  {s}
                </Badge>
              ))}
            </span>
            <span className={styles.note}>{formatBytes(p.downloadBytes)} first-use download</span>
          </button>
        );
      })}
    </div>
  );
}

async function revealFolder(path: string) {
  try {
    await LibraryService.RevealPath(path);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

function StemGroup({ job }: { job: JobView }) {
  const result = parseStemsResult(job.resultJson);
  if (!result || result.stems.length === 0) return null;
  const folder = dirname(result.stems[0]?.path ?? "");
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.track} title={job.title}>
          {job.title}
        </span>
        <Button size="sm" variant="secondary" icon="folder-open" onClick={() => void revealFolder(folder)}>
          Reveal folder
        </Button>
      </div>
      <ul className={shared.list}>
        {result.stems.map((s) => {
          const out = job.outputs.find((o) => o.path === s.path);
          return (
            <li key={s.path} className={cx(shared.row, out?.missing && shared.missing)}>
              <Icon name="music" size={14} className={shared.icon} />
              <span className={shared.name} title={s.path}>
                {s.name}
              </span>
              {out && <span className={shared.meta}>{formatBytes(out.sizeBytes)}</span>}
              <span className={shared.actions}>
                <FileActions outputId={out?.id} path={s.path} disabled={out?.missing} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function StemsView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_STEMS_OPTIONS, sanitizeStemsOptions);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone && parseStemsResult(j.resultJson)).slice(0, MAX_GROUPS),
    [jobs],
  );

  useEffect(() => {
    let cancelled = false;
    StemsService.Presets()
      .then((p) => {
        if (!cancelled) setPresets(p ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => StemsService.Enqueue(paths, opts), paths, ["track", "tracks"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={`Split ${n} ${n === 1 ? "track" : "tracks"}`}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      options={
        <Section label="Options">
          <div className={styles.options}>
            <PresetCards presets={presets} value={opts.preset} onChange={(id) => setOpts((o) => ({ ...o, preset: id as StemsPreset }))} />
            <SegmentedControl
              aria-label="Format"
              value={opts.format}
              onChange={(format) => setOpts((o) => ({ ...o, format }))}
              options={[
                { value: StemsFormat.FormatWAV, label: "wav" },
                { value: StemsFormat.FormatFLAC, label: "flac" },
                { value: StemsFormat.FormatMP3, label: "mp3" },
              ]}
            />
          </div>
        </Section>
      }
      results={
        <Section label="Results">
          {done.length === 0 ? (
            <EmptyState icon="audio-lines" title="No stems yet." body="Split a track and its stems appear here." />
          ) : (
            done.map((j) => <StemGroup key={j.id} job={j} />)
          )}
        </Section>
      }
    />
  );
}
