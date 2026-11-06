import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, Field, Section, SegmentedControl, Select, Slider, TextArea, toast } from "@/components";
import { MediaPlayer, type MediaPlayerHandle } from "@/components/media";
import { JobStatus, MediaService, PacksService, PackComponentState, type MediaSource } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useJob, useJobs, isActive } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { EmptyLine, FileToolLayout, ResultRow, recordSubmitted, runLabel, summarize, useDepsGate, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import { useToolJobs } from "@/tools/_kit/session";
import shared from "@/tools/_kit/results.module.css";
import type { ToolViewProps } from "../index";
import { TtsFormat, TtsService, TtsSplit, type TtsVoiceInfo } from "@/lib/api";
import {
  DEFAULT_TTS_OPTIONS,
  MAX_SPEED,
  MIN_SPEED,
  VOICE_MODEL_COMPONENT,
  formatSpeechLength,
  formatSpeed,
  orderVoices,
  parseTtsResult,
  previewKey,
  sanitizeTtsOptions,
  splitLabel,
  voiceLabel,
} from "./options";
import styles from "./TtsView.module.css";

const MAX_RESULTS = 20;
const FORMAT_LABEL: Record<string, string> = { [TtsFormat.FormatMP3]: "MP3", [TtsFormat.FormatM4A]: "M4A", [TtsFormat.FormatWAV]: "WAV" };

/** A MediaSource for a local WAV in the preview cache (the media route plays it as is). */
async function previewSource(path: string, seconds: number): Promise<MediaSource> {
  const url = await MediaService.URLFor(path);
  return {
    url,
    proxy: false,
    proxyJobId: "",
    info: {
      durationMs: Math.round(seconds * 1000),
      startMs: 0,
      container: "wav",
      sizeBytes: 0,
      bitRate: 0,
      video: null,
      audio: null,
      subtitles: null,
      hasCover: false,
      tags: null,
    },
  };
}

export default function TtsView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_TTS_OPTIONS, sanitizeTtsOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([]);
  const [text, setText] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const jobs = useToolJobs(moduleId);
  const gate = useDepsGate(moduleId);

  const packsLoaded = usePacks((s) => s.loaded);
  const modelPresent = usePacks((s) => {
    for (const p of s.list) {
      const c = p.components.find((x) => x.id === VOICE_MODEL_COMPONENT);
      if (c) return c.state === PackComponentState.ComponentInstalled || c.state === PackComponentState.ComponentSystem;
    }
    return true; // unknown component: don't block
  });
  const modelMissing = packsLoaded && !modelPresent;

  useEffect(() => {
    let cancelled = false;
    TtsService.Voices()
      .then((v) => !cancelled && setVoices(orderVoices(v ?? [])))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Discard the preview audio when the view goes away.
  useEffect(
    () => () => {
      TtsService.DiscardPreviews().catch(() => undefined);
    },
    [],
  );

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const blockedReason = modelMissing ? "The voices aren't installed yet. Install them first." : "";
  const voiceOptions = useMemo(() => {
    const list = voices.map((v) => ({ value: v.id, label: voiceLabel(v) }));
    return list.some((o) => o.value === opts.voice) || voices.length === 0 ? list : [{ value: opts.voice, label: opts.voice }, ...list];
  }, [voices, opts.voice]);

  // ---- voice preview ----
  const [previewJobId, setPreviewJobId] = useState("");
  const [shown, setShown] = useState<{ key: string; source: MediaSource } | null>(null);
  const [starting, setStarting] = useState(false);
  const player = useRef<MediaPlayerHandle>(null);
  const keyAtStart = useRef("");
  const previewJob = useJob(previewJobId);
  const resultJson = previewJob?.status === JobStatus.JobDone ? previewJob.resultJson : "";
  const key = previewKey(opts);
  const previewRunning = !!previewJob && isActive(previewJob);
  const previewFailed = previewJob?.status === JobStatus.JobFailed ? previewJob.error || "The preview failed" : "";

  useEffect(() => {
    const res = parseTtsResult(resultJson);
    if (!res?.previewPath) return;
    let cancelled = false;
    previewSource(res.previewPath, res.seconds)
      .then((source) => {
        if (!cancelled) setShown({ key: keyAtStart.current, source });
      })
      .catch((e) => toast({ title: toAppError(e).message, tone: "danger" }));
    return () => {
      cancelled = true;
    };
  }, [resultJson]);

  // Start playing as soon as a fresh preview is ready.
  const playedFor = useRef<MediaSource | null>(null);
  useEffect(() => {
    if (!shown || playedFor.current === shown.source) return;
    playedFor.current = shown.source;
    const t = setTimeout(() => player.current?.play(), 150);
    return () => clearTimeout(t);
  }, [shown]);

  const preview = async () => {
    if (shown && shown.key === key) {
      player.current?.seek(0);
      player.current?.play();
      return;
    }
    setStarting(true);
    keyAtStart.current = key;
    try {
      const started = await TtsService.Preview({ ...opts, preview: true });
      const j = started?.[0];
      if (j) {
        useJobs.getState().upsert(j);
        setPreviewJobId(j.id);
      }
    } catch (e) {
      const err = toAppError(e);
      toast({ title: err.message, description: err.hint, tone: "danger" });
    } finally {
      setStarting(false);
    }
  };

  const installModel = async () => {
    setInstalling(true);
    try {
      useJobs.getState().upsert(await PacksService.InstallFor(moduleId));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setInstalling(false);
    }
  };

  // ---- run ----
  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(() => TtsService.Enqueue(paths, { ...opts, preview: false }), paths, ["text", "texts"]);
    setRunning(false);
    // Keep the file list so a tweak and another run needs no re-pick; Clear empties it.
    setInputErrors(res.inputErrors);
  };

  const speakText = async () => {
    setSpeaking(true);
    try {
      const started = await TtsService.SpeakText(text, { ...opts, preview: false });
      recordSubmitted((started ?? []).map((j) => j.id));
      for (const j of started ?? []) useJobs.getState().upsert(j);
      toast({ title: "Reading your text aloud", tone: "success" });
    } catch (e) {
      const err = toAppError(e);
      toast({ title: err.message, description: err.hint, tone: "danger" });
    } finally {
      setSpeaking(false);
    }
  };

  const done = useMemo(() => jobs.filter((j) => j.status === JobStatus.JobDone && j.outputs.length > 0).slice(0, MAX_RESULTS), [jobs]);
  const textBlocked = gate.blocked ? gate.reason : blockedReason;
  const stale = shown !== null && shown.key !== key;

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Read", paths.length, "file aloud", "files aloud")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      runDisabledReason={blockedReason || undefined}
      primary={
        <div className={styles.primary}>
          {modelMissing && (
            <Banner
              tone="info"
              title="The voices need a one-time download"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon="download"
                  loading={installing}
                  data-tip="Download the Kokoro voices (about 115 MB, one time); they run offline afterwards"
                  onClick={() => void installModel()}
                >
                  Install voices (115 MB)
                </Button>
              }
            >
              Kokoro is a small voice model that runs on your computer.
            </Banner>
          )}

          <Field label="Voice">
            {(c) => (
              <div className={styles.voiceRow}>
                <Select
                  id={c.id}
                  data-tip="Who reads. Featured voices are listed first"
                  value={opts.voice}
                  onChange={(voice) => setOpts((o) => ({ ...o, voice }))}
                  options={voiceOptions}
                />
                <Button
                  variant="secondary"
                  icon="play"
                  loading={previewRunning || starting}
                  disabled={!!textBlocked || previewRunning || starting}
                  data-tip={textBlocked || "Hear this voice and speed read one sentence"}
                  onClick={() => void preview()}
                >
                  Preview
                </Button>
              </div>
            )}
          </Field>

          <Field label="Speed">
            {(c) => (
              <div data-tip="How fast the voice speaks; 1× is natural">
                <Slider id={c.id} value={opts.speed} min={MIN_SPEED} max={MAX_SPEED} step={0.05} format={formatSpeed} onChange={(speed) => setOpts((o) => ({ ...o, speed }))} />
              </div>
            )}
          </Field>

          {previewRunning && <p className={styles.note}>{previewJob?.message || "Making the preview…"}</p>}
          {previewFailed && (
            <p className={styles.error} role="alert">
              {previewFailed}
            </p>
          )}
          {shown && (
            <div className={styles.player} data-testid="tts-preview">
              <MediaPlayer ref={player} source={shown.source} kind="audio" compact />
              {stale && <p className={styles.note}>The voice or speed changed. Preview again to hear it.</p>}
            </div>
          )}

          <Section label="Type or paste text" tip="Speak text you type here instead of a file; it is saved as a .txt next to your other results">
            <div className={styles.textBox}>
              <TextArea
                aria-label="Text to read aloud"
                placeholder="Type or paste text. Lines starting with # become chapters when you split by heading."
                minRows={3}
                maxRows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className={styles.textActions}>
                <Button
                  variant="secondary"
                  icon="audio-lines"
                  loading={speaking}
                  disabled={text.trim() === "" || !!textBlocked || speaking}
                  data-tip={textBlocked || "Turn this text into an audio file with the voice above"}
                  onClick={() => void speakText()}
                >
                  Read text aloud
                </Button>
                <Button variant="ghost" icon="x" disabled={text === ""} data-tip="Empty the text box" onClick={() => setText("")}>
                  Clear text
                </Button>
              </div>
            </div>
          </Section>
        </div>
      }
      advancedSummary={summarize(FORMAT_LABEL[opts.format], splitLabel(opts.split))}
      advanced={
        <div className={styles.stack}>
          <Field label="Split">
            <SegmentedControl
              aria-label="Split"
              value={opts.split}
              onChange={(split) => setOpts((o) => ({ ...o, split }))}
              options={[
                { value: TtsSplit.SplitNone, label: "One file", tip: "Everything becomes one audio file" },
                { value: TtsSplit.SplitHeadings, label: "By heading", tip: "One audio file per top-level Markdown heading (a line starting with #), like chapters of an audiobook" },
              ]}
            />
          </Field>
          <Field label="Format">
            {(c) => (
              <Select
                id={c.id}
                size="sm"
                data-tip="File type of the audio; MP3 plays anywhere, M4A is smaller, WAV is uncompressed"
                value={opts.format}
                onChange={(format) => setOpts((o) => ({ ...o, format }))}
                options={[
                  { value: TtsFormat.FormatMP3, label: "MP3" },
                  { value: TtsFormat.FormatM4A, label: "M4A (AAC)" },
                  { value: TtsFormat.FormatWAV, label: "WAV" },
                ]}
              />
            )}
          </Field>
        </div>
      }
      results={
        <Section label="Results" tip="Finished audio, newest first">
          {done.length === 0 ? (
            <EmptyLine title="No speech yet." body="Audio files appear here." />
          ) : (
            <ul className={shared.list}>
              {done.flatMap((j) => {
                const res = parseTtsResult(j.resultJson);
                return j.outputs.map((out) => {
                  const f = res?.files?.find((x) => x.path === out.path);
                  return (
                    <li key={out.id}>
                      <ResultRow
                        path={out.path}
                        outputId={out.id}
                        missing={out.missing}
                        name={out.name}
                        icon="audio-lines"
                        sizeBytes={out.sizeBytes}
                        at={j.finishedAt || j.createdAt}
                        meta={f && f.seconds > 0 ? <span data-tip="Length of the speech">{formatSpeechLength(f.seconds)}</span> : undefined}
                      />
                    </li>
                  );
                });
              })}
            </ul>
          )}
        </Section>
      }
    />
  );
}
