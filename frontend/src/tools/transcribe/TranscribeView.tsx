import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, EmptyState, Icon, Section, SegmentedControl, Select, Switch, cx } from "@/components";
import {
  JobStatus,
  TranscribeService,
  TranscribeTask,
  type Language,
  type PresetInfo,
  type TranscribeModel,
} from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import { useOrderedJobs, type JobView } from "@/state/jobs";
import { FileToolLayout, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import {
  DEFAULT_TRANSCRIBE_OPTIONS,
  FORMATS,
  basename,
  parseTranscriptResult,
  previewPath,
  sanitizeTranscribeOptions,
  toggleFormat,
  wasAutoDetected,
} from "./options";
import { PreviewPanel } from "./PreviewPanel";
import styles from "./TranscribeView.module.css";

const MAX_GROUPS = 10;
const SPEED_LABEL: Record<string, string> = { fast: "Fastest", balanced: "Balanced", best: "Best quality" };

function ModelCards({ presets, value, onChange }: { presets: PresetInfo[]; value: string; onChange: (id: string) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = presets.findIndex((p) => p.id === value);
  const tabbable = selected >= 0 ? selected : 0;

  const move = (from: number, dir: 1 | -1) => {
    const i = (from + dir + presets.length) % presets.length;
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
    <div role="radiogroup" aria-label="Model" className={styles.cards}>
      {presets.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={p.id === value}
          tabIndex={i === tabbable ? 0 : -1}
          className={cx(styles.card, p.id === value && styles.selected)}
          onClick={() => onChange(p.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className={styles.cardHead}>
            <span className={styles.label}>{p.label}</span>
            <Badge tone={p.speed === "best" ? "accent" : "neutral"}>{SPEED_LABEL[p.speed] ?? p.speed}</Badge>
          </span>
          <span className={styles.note}>{formatBytes(p.downloadBytes)} first-use download</span>
          {p.id === "turbo" && <span className={styles.note}>Slower on CPU</span>}
        </button>
      ))}
    </div>
  );
}

function TranscriptGroup({
  job,
  languages,
  onPreview,
}: {
  job: JobView;
  languages: Language[];
  onPreview: (path: string, title: string) => void;
}) {
  const result = parseTranscriptResult(job.resultJson);
  if (!result) return null;
  const langName = languages.find((l) => l.code === result.language)?.name ?? result.language.toUpperCase();
  const auto = wasAutoDetected(job.optionsJson);
  const preview = previewPath(result.outputs);
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.track} title={job.title}>
          {job.title}
        </span>
        <span className={styles.meta}>
          {result.language && (
            <Badge tone="accent">
              {langName}
              {auto && result.languageProbability > 0 ? ` · ${Math.round(result.languageProbability * 100)}%` : ""}
            </Badge>
          )}
          <Badge mono>{formatDuration(result.durationSec)}</Badge>
          <Badge mono>{result.segments} segments</Badge>
          <Button
            size="sm"
            variant="secondary"
            disabled={!preview}
            onClick={() => preview && onPreview(preview, job.title)}
          >
            Preview
          </Button>
        </span>
      </div>
      <ul className={shared.list}>
        {result.outputs.map((path) => {
          const out = job.outputs.find((o) => o.path === path);
          return (
            <li key={path} className={cx(shared.row, out?.missing && shared.missing)}>
              <Icon name="file-text" size={14} className={shared.icon} />
              <span className={shared.name} title={path}>
                {basename(path)}
              </span>
              {out && <span className={shared.meta}>{formatBytes(out.sizeBytes)}</span>}
              <span className={shared.actions}>
                <FileActions outputId={out?.id} path={path} disabled={out?.missing} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function TranscribeView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_TRANSCRIBE_OPTIONS, sanitizeTranscribeOptions);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ path: string; title: string } | null>(null);
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone && parseTranscriptResult(j.resultJson)).slice(0, MAX_GROUPS),
    [jobs],
  );

  useEffect(() => {
    let cancelled = false;
    TranscribeService.Presets()
      .then((p) => !cancelled && setPresets(p ?? []))
      .catch(() => undefined);
    TranscribeService.Languages()
      .then((l) => !cancelled && setLanguages(l ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const languageOptions = useMemo(
    () => [{ value: "", label: "Auto-detect" }, ...languages.map((l) => ({ value: l.code, label: l.name }))],
    [languages],
  );

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => TranscribeService.Enqueue(paths, opts), paths, ["file", "files"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <>
      <FileToolLayout
        moduleId={moduleId}
        inputs={inputs}
        runLabel={runLabel("Transcribe", n, "file", "files")}
        onRun={onRun}
        running={running}
        inputErrors={inputErrors}
        options={
          <Section label="Options">
            <div className={styles.options}>
              <ModelCards
                presets={presets}
                value={opts.model}
                onChange={(id) => setOpts((o) => ({ ...o, model: id as TranscribeModel }))}
              />
              <div className={styles.optRow}>
                <label className={styles.optLabel} htmlFor="transcribe-language">
                  Language
                </label>
                <Select
                  id="transcribe-language"
                  value={opts.language}
                  options={languageOptions}
                  onChange={(language) => setOpts((o) => ({ ...o, language }))}
                />
              </div>
              <div className={styles.optRow}>
                <span className={styles.optLabel}>Task</span>
                <SegmentedControl
                  aria-label="Task"
                  value={opts.task}
                  onChange={(task) => setOpts((o) => ({ ...o, task }))}
                  options={[
                    { value: TranscribeTask.TaskTranscribe, label: "Transcribe" },
                    { value: TranscribeTask.TaskTranslate, label: "Translate to English" },
                  ]}
                />
              </div>
              <div className={styles.optRow}>
                <span className={styles.optLabel} id="transcribe-formats">
                  Formats
                </span>
                <div role="group" aria-labelledby="transcribe-formats" className={styles.chips}>
                  {FORMATS.map((f) => {
                    const on = (opts.formats ?? []).includes(f);
                    return (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={on}
                        className={cx(styles.chip, on && styles.chipOn)}
                        onClick={() => setOpts((o) => ({ ...o, formats: toggleFormat(o.formats, f) }))}
                      >
                        {f.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Switch
                checked={opts.vad}
                onChange={(vad) => setOpts((o) => ({ ...o, vad }))}
                label="Skip silence"
              />
            </div>
          </Section>
        }
        results={
          <Section label="Results">
            {done.length === 0 ? (
              <EmptyState icon="captions" title="No transcripts yet." body="Transcribe a file and its transcript appears here." />
            ) : (
              done.map((j) => (
                <TranscriptGroup key={j.id} job={j} languages={languages} onPreview={(path, title) => setPreview({ path, title })} />
              ))
            )}
          </Section>
        }
      />
      {preview && <PreviewPanel path={preview.path} title={preview.title} onClose={() => setPreview(null)} />}
    </>
  );
}
