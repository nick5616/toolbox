import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, Section, SegmentedControl, cx, toast } from "@/components";
import { JobStatus, LibraryService, StemsFormat, StemsService, type PresetInfo, type StemsPreset } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { type JobView } from "@/state/jobs";
import { useToolJobs } from "@/tools/_kit/session";
import { EmptyLine, FileToolLayout, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { ResultRow } from "@/tools/_kit/ResultRow";
import { formatResultDate } from "@/tools/_kit/format";
import { revealLabel } from "@/lib/platform";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import { DEFAULT_STEMS_OPTIONS, STEMS_SIZE_HINT, dirname, parseStemsResult, sanitizeStemsOptions } from "./options";
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
            data-tip={`${p.label}: ${p.speed === "best" ? "slowest, cleanest separation" : "faster, slightly more bleed between stems"}; splits into ${(p.stems ?? []).join(", ")}; ${formatBytes(p.downloadBytes)} model download on first use`}
          >
            <span className={styles.cardHead}>
              <span className={styles.label}>{p.label}</span>
              <Badge tone={p.speed === "best" ? "accent" : "neutral"} tip={p.speed === "best" ? "Highest quality, takes longer" : "Quicker to run, a little less clean"}>
                {p.speed}
              </Badge>
            </span>
            <span className={styles.foot}>
              <span className={styles.chips}>
                {(p.stems ?? []).map((s) => (
                  <Badge key={s} mono tip={`A separate ${s} track is saved`}>
                    {s}
                  </Badge>
                ))}
              </span>
              <span className={styles.note} data-tip="First-use model download; it is downloaded once and then works offline">{formatBytes(p.downloadBytes)}</span>
            </span>
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

function StemGroup({ job, showTime }: { job: JobView; showTime: boolean }) {
  const result = parseStemsResult(job.resultJson);
  if (!result || result.stems.length === 0) return null;
  const folder = dirname(result.stems[0]?.path ?? "");
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.track} data-tip={job.title}>
          {job.title}
          {showTime && job.finishedAt ? <span className={styles.runTime} data-tip={new Date(job.finishedAt).toLocaleString()}> · {formatResultDate(job.finishedAt)}</span> : null}
        </span>
        <Button size="sm" variant="secondary" icon="folder-open" data-tip="Open the folder that holds all stems of this track" onClick={() => void revealFolder(folder)}>
          {revealLabel}
        </Button>
      </div>
      <ul className={shared.list}>
        {result.stems.map((s) => {
          const out = job.outputs.find((o) => o.path === s.path);
          return (
            <li key={s.path}>
              <ResultRow path={s.path} outputId={out?.id} missing={out?.missing} name={s.name} sizeBytes={out?.sizeBytes} icon="music" />
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
  const jobs = useToolJobs(moduleId);
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
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Split", n, "track", "tracks")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={<PresetCards presets={presets} value={opts.preset} onChange={(id) => setOpts((o) => ({ ...o, preset: id as StemsPreset }))} />}
      advancedSummary={summarize(opts.format.toUpperCase(), opts.format === StemsFormat.FormatMP3 ? "small lossy files" : "lossless")}
      advanced={
        <div className={styles.options}>
          <Section label="File format" tip="The format of every stem file">
            <div className={styles.options}>
              <SegmentedControl
                aria-label="Format"
                value={opts.format}
                onChange={(format) => setOpts((o) => ({ ...o, format }))}
                options={[
                  { value: StemsFormat.FormatWAV, label: "wav", tip: "Uncompressed and lossless; biggest files, best for editing in a DAW" },
                  { value: StemsFormat.FormatFLAC, label: "flac", tip: "Lossless but compressed; about half the size of WAV" },
                  { value: StemsFormat.FormatMP3, label: "mp3", tip: "Small lossy files; fine for listening or sharing, not for further mixing" },
                ]}
              />
              <p className={styles.hint} data-tip="Rough output size for each format, per stem">
                {STEMS_SIZE_HINT}
              </p>
            </div>
          </Section>
        </div>
      }
      results={

        <Section label="Results" tip="Finished tracks; each shows its stems with open and reveal actions">
          {done.length === 0 ? (
            <EmptyLine title="No stems yet." body="Split a track and its stems appear here." />
          ) : (
            done.map((j) => <StemGroup key={j.id} job={j} showTime={done.some((o) => o !== j && o.title === j.title)} />)
          )}
        </Section>
      }
    />
  );
}
