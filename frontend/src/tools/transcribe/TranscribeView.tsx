import { useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, Icon, Section, ToolClickIn, cx } from "@/components";
import { LanguageField, ModelCards, SkipSilence, TaskField, useSpeechData } from "@/blocks/speech";
import { FilesService, JobStatus, TranscribeService, TranscribeTask, type Language, type TranscribeModel } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import { useOrderedJobs, type JobView } from "@/state/jobs";
import { FileToolLayout, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
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
const FORMAT_TIPS: Record<string, string> = {
  txt: "Plain text transcript, no timestamps",
  srt: "Subtitle file with timestamps; works in most video players and editors",
  vtt: "WebVTT subtitles for web video and HTML players",
  json: "Full detail with word timings, for scripts and other programs",
};

/** The most text handed to Local Chat (the chat trims further to its model's context). */
const CHAT_TEXT_MAX = 200_000;

/** "Ask Local Chat" about a transcript (Phase 11 §6): Local Chat opens here with the text attached. */
function AskChat({ path, title }: { path: string; title: string }) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    FilesService.ReadText(path, CHAT_TEXT_MAX)
      .then((t) => live && setBody(t))
      .catch(() => live && setBody(""));
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <ToolClickIn
      host="transcribe"
      module="llm-chat"
      variant="icon"
      icon="message-square"
      title="Ask Local Chat"
      tip="Ask Local Chat about this transcript: summarise it, pull out key points or action items"
      id={`chat:${path}`}
      width={520}
      disabledReason={body === null ? "Reading the transcript…" : body === "" ? "The transcript is empty or unreadable" : undefined}
      extra={body ? { text: { title: `Transcript of ${title}`, body, prompts: ["Summarise", "Key points", "Action items"] } } : undefined}
    />
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
        <span className={styles.track} data-tip={job.title}>
          {job.title}
        </span>
        <span className={styles.meta}>
          {result.language && (
            <Badge tone="accent" tip={auto ? "Language the model detected, with its confidence" : "Language you chose"}>
              {langName}
              {auto && result.languageProbability > 0 ? ` · ${Math.round(result.languageProbability * 100)}%` : ""}
            </Badge>
          )}
          <Badge mono tip="Length of the audio or video">
            {formatDuration(result.durationSec)}
          </Badge>
          <Badge mono tip="Number of timed text blocks in the transcript">
            {result.segments} segments
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            disabled={!preview}
            data-tip={preview ? "Read the first lines of the transcript here" : "No text file to preview"}
            onClick={() => preview && onPreview(preview, job.title)}
          >
            Preview
          </Button>
          {preview && <AskChat path={preview} title={job.title} />}
        </span>
      </div>
      <ul className={shared.list}>
        {result.outputs.map((path) => {
          const out = job.outputs.find((o) => o.path === path);
          return (
            <li key={path} className={cx(shared.row, out?.missing && shared.missing)}>
              <Icon name="file-text" size={14} className={shared.icon} />
              <span className={shared.name} data-tip={path}>
                {basename(path)}
              </span>
              {out && (
                <span className={shared.meta} data-tip="File size on disk">
                  {formatBytes(out.sizeBytes)}
                </span>
              )}
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
  const { presets, languages } = useSpeechData();
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ path: string; title: string } | null>(null);
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone && parseTranscriptResult(j.resultJson)).slice(0, MAX_GROUPS),
    [jobs],
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
        primary={
          <>
            <div className={styles.optRow}>
              <label className={styles.optLabel} htmlFor="transcribe-language">
                Language
              </label>
              <LanguageField id="transcribe-language" value={opts.language} languages={languages} onChange={(language) => setOpts((o) => ({ ...o, language }))} />
            </div>
            <div className={styles.optRow}>
              <span className={styles.optLabel} id="transcribe-formats" data-tip="Which transcript files to save; pick at least one">
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
                      data-tip={`${FORMAT_TIPS[f] ?? f}${on ? "" : " (click to include)"}`}
                      className={cx(styles.chip, on && styles.chipOn)}
                      onClick={() => setOpts((o) => ({ ...o, formats: toggleFormat(o.formats, f) }))}
                    >
                      {f.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        }
        advancedSummary={summarize(
          presets.find((p) => p.id === opts.model)?.label ?? opts.model,
          opts.task === TranscribeTask.TaskTranslate ? "translate to English" : "transcribe",
          opts.vad && "skip silence",
        )}
        advanced={
          <div className={styles.options}>
            <Section label="Model" tip="Speed versus accuracy of the speech model">
              <ModelCards presets={presets} value={opts.model} onChange={(id) => setOpts((o) => ({ ...o, model: id as TranscribeModel }))} />
            </Section>
            <Section label="Speech" tip="What to write and how to treat quiet parts">
              <div className={styles.options}>
                <div className={styles.optRow}>
                  <span className={styles.optLabel} data-tip="Keep the original language or translate to English">Task</span>
                  <TaskField task={opts.task} onChange={(task) => setOpts((o) => ({ ...o, task }))} />
                </div>
                <SkipSilence checked={opts.vad} onChange={(vad) => setOpts((o) => ({ ...o, vad }))} />
              </div>
            </Section>
          </div>
        }
        results={
          <Section label="Results" tip="Finished transcripts with their files">
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
