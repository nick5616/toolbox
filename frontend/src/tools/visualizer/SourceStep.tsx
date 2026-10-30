/**
 * Visualizer step 1 (SPEC.md §8.1): pick the song or video, say what to
 * analyse, press Analyze.
 *
 * Props:
 *  - `onAnalyze?()`: called after the options are accepted and the step has
 *    been set to "analyze" in the store. The previous analysis is cleared.
 * Reads and writes the Visualizer store (input, mode, analyze, seed).
 * Takes dropped inputs and the `timed-text` seed through `takeHandoff`.
 */
import { useCallback, useEffect, useState } from "react";
import { Banner, Button, DropZone, Icon, Section, SegmentedControl, Select, Spinner, Switch, TextArea, toast } from "@/components";
import { formatMs, useMediaSource } from "@/components/media";
import { FilesService, MediaService, PacksService, TranscribeService, VisualizerService, WordsSource, type Language } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { useUI, type ToolSeed } from "@/state/ui";
import { DepsGate, useDepsGate } from "@/tools/_kit";
import { PackComponentState } from "@/lib/api";
import { useVisualizer } from "./store";
import {
  basename,
  hasWords,
  isVideoPath,
  LYRIC_EXTS,
  neededModels,
  optionsIssue,
  SEED_LABEL,
  wordsChoiceOf,
  wordsSourceOf,
  type WordsChoice,
} from "./source/logic";
import styles from "./SourceStep.module.css";

export const VISUALIZER_ID = "visualizer";

export interface SourceStepProps {
  onAnalyze?: () => void;
}

/** Applies a handed-over timed-text seed to the store. */
export function applySeed(seed: ToolSeed): void {
  const s = useVisualizer.getState();
  s.setSeed(seed.from, seed.lines);
  s.setAnalyze({ words: WordsSource.WordsGiven, lines: seed.lines, mood: true });
  if (seed.overlay) s.setMode("overlay");
}

function modelLabel(id: string): string {
  return id === "stems-default" ? "The instrument separation model" : id === "whisper-default" ? "The speech model" : "The mood reader";
}

/** Rows for model downloads the chosen options need and the machine doesn't have. */
function ModelRows({ ids, moodMissing }: { ids: string[]; moodMissing: boolean }) {
  const packs = usePacks((s) => s.list);
  const [busy, setBusy] = useState(false);
  const missing = ids.filter((id) => {
    if (id === "mood-reader" && moodMissing) return true;
    for (const p of packs) {
      const c = p.components.find((x) => x.id === id);
      if (c) return c.state === PackComponentState.ComponentMissing || c.state === PackComponentState.ComponentOutdated;
    }
    return false;
  });
  if (missing.length === 0) return null;
  const install = async () => {
    setBusy(true);
    try {
      await PacksService.InstallFor(VISUALIZER_ID);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {missing.map((id) => (
        <Banner
          key={id}
          tone="info"
          title={`${modelLabel(id)} isn't downloaded`}
          action={
            <Button variant="primary" size="sm" icon="download" loading={busy} onClick={() => void install()}>
              Download
            </Button>
          }
        >
          It downloads once and then works offline.
        </Banner>
      ))}
    </>
  );
}

export default function SourceStep({ onAnalyze }: SourceStepProps) {
  const input = useVisualizer((s) => s.input);
  const isVideo = useVisualizer((s) => s.isVideo);
  const mode = useVisualizer((s) => s.mode);
  const o = useVisualizer((s) => s.analyze);
  const seedFrom = useVisualizer((s) => s.seedFrom);
  const seedLines = useVisualizer((s) => s.seedLines);
  const set = useVisualizer((s) => s.setAnalyze);

  const media = useMediaSource(input);
  const info = media.source?.info;
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [chatReady, setChatReady] = useState(false);
  const [moodReady, setMoodReady] = useState(true);
  const gate = useDepsGate(VISUALIZER_ID);
  const exts = useModules((s) => s.byId[VISUALIZER_ID]?.accepts.extensions);

  const choose = useCallback((path: string) => {
    const s = useVisualizer.getState();
    s.setInput(path, isVideoPath(path));
    s.setSeed(null, null);
  }, []);

  // ---- handoff: dropped inputs and the timed-text seed ----
  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (handoff?.moduleId !== VISUALIZER_ID) return;
    const h = useUI.getState().takeHandoff(VISUALIZER_ID);
    if (!h) return;
    const first = h.inputs[0];
    if (first) useVisualizer.getState().setInput(first, isVideoPath(first));
    if (h.seed?.kind === "timed-text") applySeed(h.seed);
  }, [handoff]);

  // ---- the probe is the truth about video vs audio ----
  useEffect(() => {
    if (!input || !info) return;
    const video = !!info.video;
    if (video === isVideo) return;
    const prev = useVisualizer.getState();
    const wasGiven = wordsChoiceOf(prev.analyze.words) === "given";
    prev.setInput(input, video);
    if (wasGiven && prev.seedLines) prev.setAnalyze({ words: WordsSource.WordsGiven, lines: prev.seedLines });
  }, [input, info, isVideo]);

  // ---- still frame / cover ----
  useEffect(() => {
    setCoverUrl(undefined);
    if (!input || media.status !== "ready" || !info) return;
    if (!info.hasCover && !info.video) return;
    let cancelled = false;
    const at = info.video ? Math.min(1000, Math.round(info.durationMs / 10)) : 0;
    MediaService.Frame(input, at, 640)
      .then((u) => !cancelled && setCoverUrl(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [input, media.status, info]);

  useEffect(() => {
    let cancelled = false;
    TranscribeService.Languages()
      .then((l) => !cancelled && setLanguages(l ?? []))
      .catch(() => undefined);
    VisualizerService.ChatStatus()
      .then((c) => !cancelled && setChatReady(c.ready))
      .catch(() => undefined);
    VisualizerService.MoodReaderReady()
      .then((r) => !cancelled && setMoodReady(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Deeper reading needs a ready chat model.
  useEffect(() => {
    if (!chatReady && o.deepRead) set({ deepRead: false });
  }, [chatReady, o.deepRead, set]);

  const pick = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a song or video", exts && exts.length > 0 ? exts : null, false)) ?? [];
      if (paths[0]) choose(paths[0]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [exts, choose]);

  const pickLyrics = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a lyrics file", LYRIC_EXTS, false)) ?? [];
      if (paths[0]) set({ lyricsPath: paths[0] });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [set]);

  const choice = wordsChoiceOf(o.words);
  const words = hasWords(o);
  const wordsOptions: Array<{ value: WordsChoice; label: string }> = [
    ...(seedFrom && seedLines ? [{ value: "given" as const, label: SEED_LABEL[seedFrom] }] : []),
    { value: "detect", label: "Detect from the audio" },
    { value: "align", label: "Paste lyrics" },
    { value: "file", label: "From a file" },
    { value: "none", label: "No words" },
  ];
  const langOptions = [{ value: "", label: "Detect the language" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];

  const needed = neededModels(o);
  const issue = optionsIssue(input, o);
  const blockReason = issue || (gate.blocked ? gate.reason : "");

  const analyze = () => {
    const s = useVisualizer.getState();
    s.setAnalysis(null, null);
    s.setStep("analyze");
    onAnalyze?.();
  };

  if (!input) {
    return (
      <div className={styles.empty}>
        <DropZone id="tool-drop:visualizer" icon="sparkles" label="Drop a song or video" hint="Visuals that follow the instruments, the beat, the chords and the words.">
          <div className={styles.buttonRow}>
            <Button icon="plus" onClick={() => void pick()}>
              Choose a file…
            </Button>
          </div>
        </DropZone>
        <DepsGate moduleId={VISUALIZER_ID} />
      </div>
    );
  }

  const tagTitle = info?.tags?.title;
  const tagArtist = info?.tags?.artist;
  return (
    <div className={styles.body}>
      <div className={styles.card}>
        <div className={styles.cover} aria-label={isVideo ? "Video still" : "Cover art"}>
          {coverUrl ? <img src={coverUrl} alt="" /> : <Icon name={isVideo ? "film" : "music"} size={32} />}
        </div>
        <div className={styles.info}>
          <div className={styles.fileName} title={input}>
            {tagTitle || basename(input)}
          </div>
          <div className={styles.meta}>
            {media.status === "loading" && (
              <>
                <Spinner size={12} /> Reading the file…
              </>
            )}
            {media.status === "preparing" && "Preparing a preview copy…"}
            {media.status === "error" && (media.error?.message ?? "Couldn't read this file")}
            {info && [tagArtist, isVideo ? "Video" : "Audio", formatMs(info.durationMs)].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void pick()}>
          Change
        </Button>
      </div>

      {isVideo && (
        <Section label="Video">
          <SegmentedControl
            aria-label="Video"
            value={mode}
            options={[
              { value: "overlay", label: "Over the video" },
              { value: "full", label: "Use only its sound" },
            ]}
            onChange={(v) => useVisualizer.getState().setMode(v)}
          />
        </Section>
      )}

      <Section label="Words">
        <div className={styles.form}>
          <SegmentedControl
            aria-label="Words"
            value={choice}
            options={wordsOptions}
            onChange={(v) => set({ words: wordsSourceOf(v), mood: v === "none" ? o.mood : true })}
          />
          {choice === "align" && (
            <TextArea
              aria-label="Lyrics"
              value={o.lyricsText}
              onChange={(e) => set({ lyricsText: e.target.value })}
              placeholder="Paste the lyrics here"
              minRows={5}
              maxRows={12}
            />
          )}
          {choice === "file" && (
            <div className={styles.row}>
              <Button size="sm" variant="secondary" icon="file-text" onClick={() => void pickLyrics()}>
                {o.lyricsPath ? "Change file…" : "Choose a lyrics file…"}
              </Button>
              <span className={styles.hint} title={o.lyricsPath}>
                {o.lyricsPath ? basename(o.lyricsPath) : ".lrc, .srt, .vtt or .txt"}
              </span>
            </div>
          )}
          {choice === "given" && seedFrom && (
            <span className={styles.hint}>
              {(seedLines ?? []).length} lines from {seedFrom === "lyric-video" ? "Lyric Video" : "Subtitles"}, with their timing.
            </span>
          )}
          {(choice === "detect" || choice === "align") && (
            <label className={styles.row}>
              <span className={styles.fieldLabel}>Language</span>
              <Select aria-label="Language" size="sm" value={o.language} options={langOptions} onChange={(v) => set({ language: v })} />
            </label>
          )}
        </div>
      </Section>

      <Section label="Instruments">
        <div className={styles.form}>
          <Switch label="Separate instruments" checked={o.stems} onChange={(v) => set({ stems: v, saveStems: v && o.saveStems })} />
          <span className={styles.hint}>Lets drums, bass, vocals and other instruments drive different visuals. Takes about as long as the song.</span>
          <div className={styles.indent}>
            <Switch label="Also save the stems to the Library" checked={o.stems && o.saveStems} disabled={!o.stems} onChange={(v) => set({ saveStems: v })} />
          </div>
        </div>
      </Section>

      <Section label="Mood">
        <div className={styles.form}>
          <Switch label="Read the mood of the words" checked={words && o.mood} disabled={!words} onChange={(v) => set({ mood: v })} />
          <span className={styles.hint}>
            A small local model reads how each line feels and what it pictures (fire, rain, stars…), in any language.
            {!words && " Choose a Words option to turn this on."}
          </span>
          <div className={styles.indent}>
            <Switch
              label="Deeper reading with Local Chat"
              checked={words && o.mood && o.deepRead}
              disabled={!words || !o.mood || !chatReady}
              onChange={(v) => set({ deepRead: v })}
            />
            <span className={styles.hint}>
              {chatReady ? "Slower, picks the words to emphasise and catches subtler lines." : "Download a model in Local Chat"}
            </span>
          </div>
        </div>
      </Section>

      <div className={styles.gates}>
        <DepsGate moduleId={VISUALIZER_ID} />
        <ModelRows ids={needed} moodMissing={needed.includes("mood-reader") && !moodReady} />
      </div>

      <div className={styles.footer}>
        {blockReason && <span className={styles.reason}>{blockReason}</span>}
        <Button icon="sparkles" onClick={analyze} disabled={!!blockReason || media.status === "error"}>
          Analyze
        </Button>
      </div>
    </div>
  );
}
