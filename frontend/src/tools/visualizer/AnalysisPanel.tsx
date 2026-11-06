/**
 * The Analysis panel (SPEC Phase 11 §5.5; the Source step's options and the
 * Analyze step's result): where the words come from, the instrument split and
 * the mood reading, what the analysis found, and Re-analyse. The options sit
 * directly in the drawer (the drawer is already the click behind the rail).
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Section, SegmentedControl, Select, Switch, TextArea, toast, useClickIn } from "@/components";
import { FilesService, PackComponentState, PacksService, TranscribeService, VisualizerService, type Language } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { usePacks } from "@/state/packs";
import { DepsGate, useDepsGate } from "@/tools/_kit";
import { basename, hasWords, languageName, LYRIC_EXTS, neededModels, optionsIssue, SEED_LABEL, wordsChoiceOf, wordsSourceOf, type WordsChoice } from "./source/logic";
import { useVisualizer, VISUALIZER_ID } from "./store";
import styles from "./AnalysisPanel.module.css";

function modelLabel(id: string): string {
  return id === "stems-default" ? "The instrument separation model" : id === "whisper-default" ? "The speech model" : "The mood reader";
}

/** Rows for model downloads the chosen options need and the machine doesn't have. */
export function ModelRows({ ids, moodMissing }: { ids: string[]; moodMissing: boolean }) {
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
            <Button variant="primary" size="sm" icon="download" loading={busy} onClick={() => void install()} data-tip="Download the model once; after that it works offline">
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

/** Why the analysis can't run with the chosen options (empty when it can), and the models it still needs. */
export function useAnalysisBlock(): { reason: string; needed: string[]; moodMissing: boolean } {
  const input = useVisualizer((s) => s.input);
  const o = useVisualizer((s) => s.analyze);
  const gate = useDepsGate(VISUALIZER_ID);
  const [moodReady, setMoodReady] = useState(true);
  useEffect(() => {
    let cancelled = false;
    VisualizerService.MoodReaderReady()
      .then((r) => !cancelled && setMoodReady(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const needed = neededModels(o);
  const issue = optionsIssue(input, o);
  return { reason: issue || (gate.blocked ? gate.reason : ""), needed, moodMissing: needed.includes("mood-reader") && !moodReady };
}

/** What the analysis found: tempo, key, sections, instruments, lines, mood, and its warnings. */
function Findings() {
  const ref = useVisualizer((s) => s.ref);
  const code = ref?.summary.language ?? "";
  const [langName, setLangName] = useState("");
  useEffect(() => {
    setLangName(languageName(code));
    if (!code) return;
    let cancelled = false;
    TranscribeService.Languages()
      .then((l) => {
        const hit = (l ?? []).find((x) => x.code === code);
        if (hit && !cancelled) setLangName(hit.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (!ref) return null;
  const sum = ref.summary;
  const warnings = sum.warnings ?? [];
  return (
    <>
      <div className={styles.chips} aria-label="Summary" data-tip="What the analysis found in this song">
        {sum.tempo > 0 && <Badge mono tip="Detected tempo in beats per minute">{Math.round(sum.tempo)} BPM</Badge>}
        {sum.key && <Badge tip="Detected musical key">{sum.key}</Badge>}
        <Badge tip="Parts of the song found (verse, chorus…); visuals can change at each one">{(sum.sections ?? []).length} sections</Badge>
        {sum.hasStems && <Badge tip="Drums, bass, vocals and other were separated, so each can drive its own visuals">4 instruments</Badge>}
        {sum.hasWords && (
          <Badge tip="Lines of words found, with timing, and their language">
            {sum.lines} lines{langName ? ` · ${langName}` : ""}
          </Badge>
        )}
        {sum.hasMeaning && <Badge tone="accent" tip="Each line was read for feeling and imagery, so visuals can match the words">Mood read</Badge>}
      </div>
      {warnings.length > 0 && (
        <Banner tone="warn" title={warnings.length === 1 ? "Heads up" : "A few things to know"}>
          <ul className={styles.warnings}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}
    </>
  );
}

export default function AnalysisPanel() {
  const input = useVisualizer((s) => s.input);
  const o = useVisualizer((s) => s.analyze);
  const seedFrom = useVisualizer((s) => s.seedFrom);
  const seedLines = useVisualizer((s) => s.seedLines);
  const analysis = useVisualizer((s) => s.analysis);
  const set = useVisualizer((s) => s.setAnalyze);
  const { close } = useClickIn();
  const [languages, setLanguages] = useState<Language[]>([]);
  const [chatReady, setChatReady] = useState(false);
  const block = useAnalysisBlock();

  useEffect(() => {
    let cancelled = false;
    TranscribeService.Languages()
      .then((l) => !cancelled && setLanguages(l ?? []))
      .catch(() => undefined);
    VisualizerService.ChatStatus()
      .then((c) => !cancelled && setChatReady(c.ready))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Deeper reading needs a ready chat model.
  useEffect(() => {
    if (!chatReady && o.deepRead) set({ deepRead: false });
  }, [chatReady, o.deepRead, set]);

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
  const wordsOptions: Array<{ value: WordsChoice; label: string; tip?: string }> = [
    ...(seedFrom && seedLines ? [{ value: "given" as const, label: SEED_LABEL[seedFrom], tip: "Use the lines and timing already made in the other tool" }] : []),
    { value: "detect", label: "Detect from the audio", tip: "Listen to the vocals and write out the words with timing" },
    { value: "align", label: "Paste lyrics", tip: "Paste the real lyrics; they are matched to the singing for accurate timing" },
    { value: "file", label: "From a file", tip: "Load lyrics from an .lrc, .srt, .vtt or .txt file" },
    { value: "none", label: "No words", tip: "Skip words; visuals follow only the music" },
  ];
  const langOptions = [{ value: "", label: "Detect the language" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];

  if (!input) return null;
  return (
    <div className={styles.panel}>
      <Findings />

      <Section label="Words" tip="Where the lyrics come from, so visuals can follow them">
        <div className={styles.form}>
          <SegmentedControl aria-label="Words" value={choice} options={wordsOptions} onChange={(v) => set({ words: wordsSourceOf(v), mood: v === "none" ? o.mood : true })} />
          {choice === "align" && (
            <TextArea aria-label="Lyrics" value={o.lyricsText} onChange={(e) => set({ lyricsText: e.target.value })} placeholder="Paste the lyrics here" data-tip="Plain lyrics, one line per row; blank lines separate verses" minRows={5} maxRows={12} />
          )}
          {choice === "file" && (
            <div className={styles.row}>
              <Button size="sm" variant="secondary" icon="file-text" onClick={() => void pickLyrics()} data-tip="Pick a lyrics file: .lrc, .srt, .vtt or .txt">
                {o.lyricsPath ? "Change file…" : "Choose a lyrics file…"}
              </Button>
              <span className={styles.hint} data-tip={o.lyricsPath || "Accepted lyrics file types"}>
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
              <Select aria-label="Language" data-tip="The language sung; pick it if detection gets it wrong" size="sm" value={o.language} options={langOptions} onChange={(v) => set({ language: v })} />
            </label>
          )}
        </div>
      </Section>

      <Section label="Instruments" tip="Split the song into drums, bass, vocals and other">
        <div className={styles.form}>
          <Switch tip="Split the song so each instrument can drive its own visuals; takes about as long as the song" label="Separate instruments" checked={o.stems} onChange={(v) => set({ stems: v, saveStems: v && o.saveStems })} />
          <span className={styles.hint}>Lets drums, bass, vocals and other instruments drive different visuals. Takes about as long as the song.</span>
          <div className={styles.indent}>
            <Switch tip={o.stems ? "Keep the separated instrument tracks as audio files in your Library" : "Turn on Separate instruments first"} label="Also save the stems to the Library" checked={o.stems && o.saveStems} disabled={!o.stems} onChange={(v) => set({ saveStems: v })} />
          </div>
        </div>
      </Section>

      <Section label="Mood" tip="Let the meaning of the words shape the visuals">
        <div className={styles.form}>
          <Switch tip={words ? "A small local model reads how each line feels and what it pictures" : "Choose a Words option first"} label="Read the mood of the words" checked={words && o.mood} disabled={!words} onChange={(v) => set({ mood: v })} />
          <span className={styles.hint}>
            A small local model reads how each line feels and what it pictures (fire, rain, stars…), in any language.
            {!words && " Choose a Words option to turn this on."}
          </span>
          <div className={styles.indent}>
            <Switch
              tip={!words || !o.mood ? "Turn on the mood reading first" : chatReady ? "Use your local chat model for a slower, subtler reading" : "Needs a model downloaded in Local Chat"}
              label="Deeper reading with Local Chat"
              checked={words && o.mood && o.deepRead}
              disabled={!words || !o.mood || !chatReady}
              onChange={(v) => set({ deepRead: v })}
            />
            <span className={styles.hint}>{chatReady ? "Slower, picks the words to emphasise and catches subtler lines." : "Download a model in Local Chat"}</span>
          </div>
        </div>
      </Section>

      <div className={styles.gates}>
        <DepsGate moduleId={VISUALIZER_ID} />
        <ModelRows ids={block.needed} moodMissing={block.moodMissing} />
      </div>

      <div className={styles.footer}>
        {block.reason && <span className={styles.reason}>{block.reason}</span>}
        {analysis ? (
          <Button
            icon="rotate-ccw"
            disabled={!!block.reason}
            data-tip={block.reason || "Analyse the song again with these options; finished stages are reused from the cache"}
            onClick={() => {
              useVisualizer.setState({ restored: false }); // asked for: the stage runs by itself
              useVisualizer.getState().setAnalysis(null, null);
              close();
            }}
          >
            Re-analyse
          </Button>
        ) : (
          <span className={styles.hint}>Changes apply the next time the analysis runs.</span>
        )}
      </div>
    </div>
  );
}
