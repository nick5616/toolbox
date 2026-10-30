import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ConfirmDialog, Icon, cx, toast } from "@/components";
import { useMediaSource, type MediaPlayerHandle } from "@/components/media";
import {
  FilesService,
  type VisualsSpec,
  LyricVideoService,
  MediaService,
  SubtitlesAction,
  SubtitlesService,
  TranscribeService,
  type Language,
  type SubtitleLanguage,
  type SubtitleStyleInfo,
  type TranslatorStatus,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import type { JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { useModuleOptions } from "@/tools/_kit";
import { DesignerSheet } from "./DesignerSheet";
import { canvasAspect } from "./options";
import { cuesToLines, defaultVisuals, handoffSeed } from "./visuals";
import type { ToolViewProps } from "@/tools";
import type { RowAction } from "./CueList";
import { EditStep } from "./EditStep";
import { ExportStep } from "./ExportStep";
import { EMPTY_EDITOR, activeTab, anyDirty, editorReducer, isDirty, makeTab } from "./editor";
import {
  activeCueIndex,
  cuesKey,
  defaultSplitCaret,
  deleteCue,
  documentIssues,
  findReplace,
  insertAfter,
  isSubtitlePath,
  mergeWithNext,
  shiftAll,
  splitCue,
  toCues,
  toRows,
  updateCue,
  type CueRow,
} from "./logic";
import { DEFAULT_PREFS, buildOptions, parseResult, sanitizePrefs } from "./options";
import { SourceStep } from "./SourceStep";
import { TranslateStep } from "./TranslateStep";
import { useJobRun } from "./useJobRun";
import styles from "./SubtitlesView.module.css";

type Step = "source" | "edit" | "translate" | "export";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "source", label: "Source" },
  { id: "edit", label: "Edit" },
  { id: "translate", label: "Translate" },
  { id: "export", label: "Export" },
];

const SUBTITLE_EXTS = [".srt", ".vtt"];

function srtOutput(job: JobView): string | undefined {
  const result = parseResult(job.resultJson);
  const paths = result?.outputs?.length ? result.outputs : job.outputs.map((o) => o.path);
  return paths.find((p) => /\.srt$/i.test(p)) ?? paths.find(isSubtitlePath);
}

export default function SubtitlesView({ moduleId }: ToolViewProps) {
  const [prefs, setPrefs] = useModuleOptions(moduleId, DEFAULT_PREFS, sanitizePrefs);
  const [step, setStep] = useState<Step>("source");
  const [mediaPath, setMediaPath] = useState<string | null>(null);
  const [subPath, setSubPath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, dispatch] = useReducer(editorReducer, EMPTY_EDITOR);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => void } | null>(null);
  const [languages, setLanguages] = useState<SubtitleLanguage[]>([]);
  const [spoken, setSpoken] = useState<Language[]>([]);
  const [styleInfos, setStyleInfos] = useState<SubtitleStyleInfo[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [translator, setTranslator] = useState<TranslatorStatus | null>(null);
  const [sourceLang, setSourceLang] = useState<string | null>(null);
  const [filmstripUrl, setFilmstripUrl] = useState<string | undefined>(undefined);
  const [waveform, setWaveform] = useState<number[] | undefined>(undefined);

  const playerRef = useRef<MediaPlayerHandle>(null);
  const media = useMediaSource(mediaPath);
  const tab = activeTab(editor);
  const rows = useMemo<CueRow[]>(() => tab?.history.present ?? [], [tab]);
  const original = editor.tabs[0];
  const dirty = anyDirty(editor);
  const tabDirty = tab ? isDirty(tab) : false;
  const issues = useMemo(() => documentIssues(rows, prefs.maxLineChars), [rows, prefs.maxLineChars]);
  const blocker = issues.tooMany ? "There are too many subtitles (the limit is 20,000)." : issues.firstError;
  const originalIssues = useMemo(() => (original ? documentIssues(original.history.present, prefs.maxLineChars) : null), [original, prefs.maxLineChars]);
  const activeIndex = useMemo(() => activeCueIndex(rows, playheadMs), [rows, playheadMs]);
  const hasCues = editor.tabs.length > 0;

  // ---- static data ----
  useEffect(() => {
    let cancelled = false;
    SubtitlesService.TranslationLanguages().then((l) => !cancelled && setLanguages(l ?? [])).catch(() => undefined);
    SubtitlesService.Styles().then((s) => !cancelled && setStyleInfos(s ?? [])).catch(() => undefined);
    TranscribeService.Languages().then((l) => !cancelled && setSpoken(l ?? [])).catch(() => undefined);
    LyricVideoService.Fonts().then((f) => !cancelled && setFonts(f ?? [])).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshTranslator = useCallback(() => {
    setTranslator(null);
    SubtitlesService.TranslatorStatus()
      .then(setTranslator)
      .catch((e: unknown) => setTranslator({ ready: false, model: "", error: toAppError(e).message }));
  }, []);
  useEffect(() => {
    if (step === "translate") refreshTranslator();
  }, [step, refreshTranslator]);

  // ---- timeline decorations ----
  const mediaReady = media.status === "ready" && !!media.source;
  const isVideo = !!media.source?.info.video;
  useEffect(() => {
    setFilmstripUrl(undefined);
    setWaveform(undefined);
    if (!mediaPath || !mediaReady) return;
    let cancelled = false;
    if (isVideo) {
      MediaService.Filmstrip(mediaPath, 24, 48).then((u) => !cancelled && setFilmstripUrl(u)).catch(() => undefined);
    } else {
      MediaService.Waveform(mediaPath, 800).then((w) => !cancelled && setWaveform(w ?? undefined)).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [mediaPath, mediaReady, isVideo]);

  // ---- opening cues ----
  const openCues = useCallback(async (path: string, label: string, language: string, kind: "open" | "add", savedPath?: string) => {
    try {
      const cues = await SubtitlesService.Load(path);
      const t = makeTab(kind === "open" ? "original" : `tr-${language || label}`, label, language, toRows(cues), savedPath);
      dispatch({ type: kind === "open" ? "open" : "addTab", tab: t });
      setLoadError(null);
      setPlayheadMs(0);
      setStep("edit");
    } catch (e) {
      const err = toAppError(e);
      setLoadError(err.hint ? `${err.message} ${err.hint}` : err.message);
      toast({ title: "Couldn't read the subtitles", description: err.message, tone: "danger" });
    }
  }, []);

  const gen = useJobRun((job) => {
    const out = srtOutput(job);
    if (out) void openCues(out, "Original", parseResult(job.resultJson)?.language ?? "", "open", out);
  });
  const extract = useJobRun((job) => {
    const out = srtOutput(job);
    if (out) void openCues(out, "Original", parseResult(job.resultJson)?.language ?? "", "open", out);
  });
  const pendingSave = useRef<{ tabId: string; key: string } | null>(null);
  const save = useJobRun((job) => {
    const p = pendingSave.current;
    pendingSave.current = null;
    const result = parseResult(job.resultJson);
    const out = result?.outputs?.find((o) => /\.srt$/i.test(o)) ?? result?.outputs?.[0];
    if (p) dispatch({ type: "saved", id: p.tabId, key: p.key, path: out });
  });
  const translate = useJobRun((job) => {
    const out = srtOutput(job);
    const code = parseResult(job.resultJson)?.language || prefs.targetLanguage;
    const name = languages.find((l) => l.code === code)?.name ?? code.toUpperCase();
    if (out) void openCues(out, name, code, "add", out);
  });
  const burn = useJobRun();
  const embed = useJobRun();

  // ---- visuals for the burn (SPEC.md 9.3) ----
  const [addVisuals, setAddVisuals] = useState(false);
  const [designerOpen, setDesignerOpen] = useState(false);
  const [chosen, setChosen] = useState<VisualsSpec | null>(null);
  const visualsMode = isVideo ? "overlay" : "background";
  const visuals = useMemo(() => chosen ?? defaultVisuals(visualsMode), [chosen, visualsMode]);
  useEffect(() => setChosen(null), [visualsMode, mediaPath]); // a design belongs to one kind of input
  const burnsVisuals = isVideo ? addVisuals : prefs.background === "visualizer";
  const cueLines = useMemo(() => cuesToLines(rows), [rows]);

  // ---- sources ----
  const guard = useCallback(
    (run: () => void) => {
      if (!dirty) return run();
      setConfirm({
        title: "Discard unsaved changes?",
        body: "Your edits haven't been saved. Opening something else will lose them.",
        label: "Discard",
        run,
      });
    },
    [dirty],
  );

  const loadSubtitleFile = useCallback(
    (path: string) => {
      guard(() => {
        setSubPath(path);
        void openCues(path, "Original", "", "open");
      });
    },
    [guard, openCues],
  );

  const takeMedia = useCallback((path: string) => {
    setMediaPath(path);
    setPlayheadMs(0);
    setPlaying(false);
    gen.clear();
    extract.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputs = useCallback(
    (paths: string[]) => {
      const first = paths[0];
      if (!first) return;
      if (isSubtitlePath(first)) loadSubtitleFile(first);
      else takeMedia(first);
    },
    [loadSubtitleFile, takeMedia],
  );

  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (handoff?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    if (h) handleInputs(h.inputs);
  }, [handoff, moduleId, handleInputs]);

  const mediaExts = useModules((s) => s.byId[moduleId]?.accepts.extensions);
  const onPickMedia = useCallback(async () => {
    try {
      const exts = (mediaExts ?? []).filter((e) => !SUBTITLE_EXTS.includes(e.toLowerCase()));
      const paths = (await FilesService.PickWith("Choose a video or audio file", exts.length > 0 ? exts : null, false)) ?? [];
      if (paths[0]) takeMedia(paths[0]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [mediaExts, takeMedia]);

  const onPickSubtitleFile = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a subtitle file", SUBTITLE_EXTS, false)) ?? [];
      if (paths[0]) loadSubtitleFile(paths[0]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [loadSubtitleFile]);

  const startOver = useCallback(() => {
    guard(() => {
      dispatch({ type: "reset" });
      setMediaPath(null);
      setSubPath(null);
      setLoadError(null);
      setStep("source");
      gen.clear();
      extract.clear();
      save.clear();
      translate.clear();
      burn.clear();
      embed.clear();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard]);

  // ---- running jobs ----
  const onGenerate = () => {
    if (!mediaPath) return;
    const run = () =>
      void gen.start([mediaPath], buildOptions(SubtitlesAction.ActionGenerate, prefs, { formats: ["srt"] }));
    if (dirty) guard(run);
    else run();
  };
  const onExtract = (streamIndex: number) => {
    if (!mediaPath) return;
    const run = () => void extract.start([mediaPath], buildOptions(SubtitlesAction.ActionExtract, prefs, { streamIndex }));
    if (dirty) guard(run);
    else run();
  };

  const doSave = useCallback(
    (formats?: string[]) => {
      if (!tab || blocker || save.busy) return;
      const input = tab.savedPath ?? subPath ?? mediaPath;
      if (!input) {
        toast({ title: "Nothing to name the file after", description: "Pick the video or a subtitle file first.", tone: "warn" });
        return;
      }
      pendingSave.current = { tabId: tab.id, key: cuesKey(tab.history.present) };
      void save.start(
        [input],
        buildOptions(SubtitlesAction.ActionSave, prefs, { cues: toCues(tab.history.present), formats: formats ?? prefs.formats }),
      );
    },
    [tab, blocker, save, subPath, mediaPath, prefs],
  );

  const onTranslate = () => {
    if (!original || originalIssues?.firstError) return;
    const input = original.savedPath ?? subPath ?? mediaPath;
    if (!input) return;
    void translate.start(
      [input],
      buildOptions(SubtitlesAction.ActionTranslate, prefs, {
        cues: toCues(original.history.present),
        sourceLanguage: sourceLang ?? original.language,
        targetLanguage: prefs.targetLanguage,
      }),
    );
  };

  const onBurn = () => {
    if (!mediaPath || !tab || blocker) return;
    void burn.start(
      [mediaPath],
      buildOptions(SubtitlesAction.ActionBurn, prefs, { cues: toCues(rows), visuals: burnsVisuals ? visuals : null }),
    );
  };
  const onOpenInVisualizer = () => {
    if (!mediaPath) return;
    useUI.getState().handOff({ moduleId: "visualizer", inputs: [mediaPath], seed: handoffSeed(cueLines, isVideo, prefs) });
  };
  const onEmbed = () => {
    if (!mediaPath || !tab || blocker) return;
    void embed.start(
      [mediaPath],
      buildOptions(SubtitlesAction.ActionEmbed, prefs, { cues: toCues(rows), trackLanguage: prefs.trackLanguage || tab.language }),
    );
  };

  const openChat = useCallback(() => useUI.getState().navigate("llm-chat"), []);

  // ---- editing ----
  const edit = useCallback((fn: (r: CueRow[]) => CueRow[], key?: string) => dispatch({ type: "edit", fn, key, at: Date.now() }), []);
  const onPatch = useCallback(
    (id: string, patch: Partial<Omit<CueRow, "id">>, key?: string) => edit((r) => updateCue(r, id, patch), key),
    [edit],
  );
  const onSeek = useCallback((ms: number) => {
    setPlayheadMs(ms);
    playerRef.current?.seek(ms);
  }, []);

  const onRowAction = (action: RowAction, id: string, caret: number) => {
    const index = rows.findIndex((r) => r.id === id);
    const row = rows[index];
    if (!row) return;
    const now = playerRef.current?.currentMs() ?? playheadMs;
    switch (action) {
      case "split": {
        const at = caret >= 0 ? caret : defaultSplitCaret(row.text);
        const next = splitCue(rows, index, at, mediaReady ? now : undefined);
        if (!next) {
          toast({ title: "Put the cursor inside the text to split", tone: "warn" });
          return;
        }
        edit(() => next);
        return;
      }
      case "merge": {
        const next = mergeWithNext(rows, index, prefs.maxLineChars);
        if (next) edit(() => next);
        return;
      }
      case "insert": {
        const res = insertAfter(rows, index);
        edit(() => res.rows);
        setFocusId(res.id);
        return;
      }
      case "delete":
        edit((r) => deleteCue(r, id));
        return;
      case "startAtPlayhead":
        if (now >= row.endMs) toast({ title: "The playhead is after this subtitle's end", tone: "warn" });
        else onPatch(id, { startMs: Math.round(now) });
        return;
      case "endAtPlayhead":
        if (now <= row.startMs) toast({ title: "The playhead is before this subtitle's start", tone: "warn" });
        else onPatch(id, { endMs: Math.round(now) });
        return;
    }
  };

  const onInsertFirst = () => {
    const res = insertAfter(rows, -1);
    edit(() => res.rows);
    setFocusId(res.id);
  };

  const onReplace = (find: string, replacement: string, matchCase: boolean): number => {
    const res = findReplace(rows, find, replacement, matchCase);
    if (res.count > 0) edit(() => res.rows);
    return res.count;
  };

  const canUndo = (tab?.history.past.length ?? 0) > 0;
  const canRedo = (tab?.history.future.length ?? 0) > 0;
  const inEditing = step === "edit" || step === "export";
  useShortcut("Mod+Z", () => dispatch({ type: "undo" }), { when: step === "edit", allowInInputs: true });
  useShortcut(["Mod+Shift+Z", "Mod+Y"], () => dispatch({ type: "redo" }), { when: step === "edit", allowInInputs: true });
  useShortcut("Mod+S", () => doSave(), { when: inEditing && hasCues, allowInInputs: true });

  // ---- header ----
  const reachable = (s: Step) => s === "source" || hasCues;
  const sampleText = rows[activeIndex]?.text ?? "";
  const sourceLanguage = sourceLang ?? original?.language ?? "";

  return (
    <div className={styles.root}>
      <nav className={styles.steps} aria-label="Steps">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={cx(styles.step, step === s.id && styles.stepOn)}
            aria-current={step === s.id ? "step" : undefined}
            disabled={!reachable(s.id)}
            onClick={() => setStep(s.id)}
          >
            <span className={styles.stepNum}>{i + 1}</span>
            {s.label}
            {s.id === "edit" && dirty && <span className={styles.dot} role="img" aria-label="Unsaved changes" />}
            {i < STEPS.length - 1 && <Icon name="chevron-right" size={12} className={styles.stepSep} />}
          </button>
        ))}
        {tabDirty && step === "edit" && <span className={styles.unsaved}>Unsaved changes</span>}
      </nav>

      <div className={styles.body}>
        {step === "source" && (
          <SourceStep
            mediaPath={mediaPath}
            subPath={subPath}
            media={media}
            cueCount={original?.history.present.length ?? 0}
            prefs={prefs}
            setPrefs={setPrefs}
            languages={spoken}
            gen={gen}
            extract={extract}
            loadError={loadError}
            onPickMedia={() => void onPickMedia()}
            onPickSubtitleFile={() => void onPickSubtitleFile()}
            onGenerate={onGenerate}
            onExtract={onExtract}
            onContinue={() => setStep("edit")}
            onStartOver={startOver}
          />
        )}
        {step === "edit" && (
          <EditStep
            mediaPath={mediaPath}
            media={media}
            playerRef={playerRef}
            playheadMs={playheadMs}
            playing={playing}
            filmstripUrl={filmstripUrl}
            waveform={waveform}
            tabs={editor.tabs}
            activeId={editor.activeId}
            rows={rows}
            activeIndex={activeIndex}
            prefs={prefs}
            canUndo={canUndo}
            canRedo={canRedo}
            dirty={tabDirty}
            blocker={blocker}
            save={save}
            focusId={focusId}
            onFocused={() => setFocusId(undefined)}
            onSelectTab={(id) => dispatch({ type: "select", id })}
            onTime={setPlayheadMs}
            onPlayingChange={setPlaying}
            onSeek={onSeek}
            onPatch={onPatch}
            onRowAction={onRowAction}
            onInsertFirst={onInsertFirst}
            onShift={(d) => edit((r) => shiftAll(r, d))}
            onReplace={onReplace}
            onUndo={() => dispatch({ type: "undo" })}
            onRedo={() => dispatch({ type: "redo" })}
            onSave={() => doSave()}
            onPickMedia={() => void onPickMedia()}
          />
        )}
        {step === "translate" && (
          <TranslateStep
            languages={languages}
            status={translator}
            cueCount={original?.history.present.length ?? 0}
            blocker={originalIssues?.firstError ?? null}
            sourceLanguage={sourceLanguage}
            targetLanguage={prefs.targetLanguage}
            run={translate}
            onSource={setSourceLang}
            onTarget={(targetLanguage) => setPrefs((o) => ({ ...o, targetLanguage }))}
            onTranslate={onTranslate}
            onRefreshStatus={refreshTranslator}
            onOpenChat={openChat}
          />
        )}
        {step === "export" && (
          <ExportStep
            tabs={editor.tabs}
            activeId={editor.activeId}
            onSelectTab={(id) => dispatch({ type: "select", id })}
            cueCount={rows.length}
            sampleText={sampleText}
            playheadMs={playheadMs}
            blocker={blocker}
            prefs={prefs}
            setPrefs={setPrefs}
            styleInfos={styleInfos}
            fonts={fonts}
            languages={languages}
            mediaPath={mediaPath}
            media={media}
            save={save}
            burn={burn}
            embed={embed}
            onSave={() => doSave()}
            onBurn={onBurn}
            onEmbed={onEmbed}
            onPickMedia={() => void onPickMedia()}
            visuals={visuals}
            onVisuals={setChosen}
            addVisuals={addVisuals}
            onAddVisuals={setAddVisuals}
            lines={cueLines}
            onOpenDesigner={() => setDesignerOpen(true)}
            onOpenInVisualizer={onOpenInVisualizer}
          />
        )}
      </div>

      {designerOpen && mediaPath && visuals && (
        <DesignerSheet
          inputPath={mediaPath}
          rows={rows}
          lines={cueLines}
          value={visuals}
          mode={visualsMode}
          aspect={isVideo ? (media.source?.info.video ? media.source.info.video.width / Math.max(1, media.source.info.video.height) : 16 / 9) : canvasAspect(prefs.canvas)}
          prefs={prefs}
          onDone={(spec) => {
            setChosen(spec);
            setDesignerOpen(false);
          }}
          onClose={() => setDesignerOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body}
        confirmLabel={confirm?.label ?? "OK"}
        tone="danger"
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          run?.();
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
