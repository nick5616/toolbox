import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ConfirmDialog, Icon, cx, toast } from "@/components";
import { MediaPlayer, useMediaSource, type MediaPlayerHandle } from "@/components/media";
import {
  FilesService,
  LyricAction,
  LyricSource,
  LyricVideoService,
  MediaService,
  TranscribeService,
  type Language,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { setRequiresOverride, useDepsGate, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import {
  deleteRow,
  documentIssues,
  editorReducer,
  insertAfter,
  latestStarted,
  newHistory,
  nudgeLine,
  setLineStart,
  setLineText,
  shiftAll,
  stem,
  suspectIds,
  tagValue,
  tapBack,
  tapStamp,
  toLines,
  toRows,
  type Row,
} from "./logic";
import { IMAGE_EXTS, LYRIC_EXTS, VIDEO_EXTS, DEFAULT_PREFS, buildOptions, lyricsNeedEngine, parseResult, sanitizePrefs } from "./options";
import { LookStep } from "./LookStep";
import { LyricsStep } from "./LyricsStep";
import { RenderStep } from "./RenderStep";
import { SongStep } from "./SongStep";
import { useJobRun } from "./useJobRun";
import styles from "./LyricVideoView.module.css";

type Step = "song" | "lyrics" | "look" | "render";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "song", label: "Song" },
  { id: "lyrics", label: "Lyrics" },
  { id: "look", label: "Look" },
  { id: "render", label: "Render" },
];

const EMPTY_HISTORY = newHistory<Row[]>([]);

export default function LyricVideoView({ moduleId }: ToolViewProps) {
  const [prefs, setPrefs] = useModuleOptions(moduleId, DEFAULT_PREFS, sanitizePrefs);
  const [step, setStep] = useState<Step>("song");
  const [songPath, setSongPath] = useState<string | null>(null);
  const [meta, setMeta] = useState({ title: "", artist: "" });
  const [text, setText] = useState("");
  const [lyricsPath, setLyricsPath] = useState("");
  const [history, dispatch] = useReducer(editorReducer, EMPTY_HISTORY);
  const [selectedId, setSelectedId] = useState("");
  const [matched, setMatched] = useState<number | null>(null);
  const [noLyrics, setNoLyrics] = useState(false);
  const [hasInstrumental, setHasInstrumental] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [tapIndex, setTapIndex] = useState(-1);
  const [previewStartMs, setPreviewStartMs] = useState(0);
  const [previewPath, setPreviewPath] = useState("");
  const [languages, setLanguages] = useState<Language[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);
  const [waveform, setWaveform] = useState<number[] | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => void } | null>(null);

  const playerRef = useRef<MediaPlayerHandle>(null);
  const media = useMediaSource(songPath);
  const info = media.source?.info;
  const mediaReady = media.status === "ready" && !!media.source;
  const durationMs = info?.durationMs ?? 0;
  const hasCover = !!info?.hasCover;
  const rows = history.present;
  const dirty = history.past.length > 0;
  const issues = useMemo(() => documentIssues(rows), [rows]);
  const tapping = tapIndex >= 0;
  const look = prefs.look;

  // ---- static data ----
  useEffect(() => {
    let cancelled = false;
    TranscribeService.Languages().then((l) => !cancelled && setLanguages(l ?? [])).catch(() => undefined);
    LyricVideoService.Fonts().then((f) => !cancelled && setFonts(f ?? [])).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- song decorations: cover, waveform, tags ----
  useEffect(() => {
    setCoverUrl(undefined);
    setWaveform(undefined);
    if (!songPath || !mediaReady) return;
    let cancelled = false;
    if (hasCover) MediaService.Frame(songPath, 0, 640).then((u) => !cancelled && setCoverUrl(u)).catch(() => undefined);
    MediaService.Waveform(songPath, 800).then((w) => !cancelled && setWaveform(w ?? undefined)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [songPath, mediaReady, hasCover]);

  const metaFor = useRef("");
  useEffect(() => {
    if (!songPath || !info || metaFor.current === songPath) return;
    metaFor.current = songPath;
    setMeta({ title: tagValue(info.tags, "title") || stem(songPath), artist: tagValue(info.tags, "artist") });
  }, [songPath, info]);

  useEffect(() => {
    setImageUrl(undefined);
    if (look.background !== "image" || !look.backgroundPath) return;
    let cancelled = false;
    MediaService.URLFor(look.backgroundPath).then((u) => !cancelled && setImageUrl(u)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [look.background, look.backgroundPath]);

  // ---- the AI engine gate: only the runs that need it require it ----
  const engineRequired =
    (step === "lyrics" && lyricsNeedEngine(prefs.source, lyricsPath)) || ((step === "render" || step === "song") && prefs.audio === "instrumental");
  useEffect(() => {
    setRequiresOverride(moduleId, engineRequired ? ["ffmpeg", "ffprobe", "audio-engine"] : null);
  }, [moduleId, engineRequired]);
  useEffect(() => () => setRequiresOverride(moduleId, null), [moduleId]);
  const gate = useDepsGate(moduleId);
  const engineBlocked = engineRequired && gate.blocked;

  // ---- jobs ----
  const gen = useJobRun((job) => {
    const r = parseResult(job.resultJson);
    if (!r) return;
    dispatch({ type: "reset", rows: toRows(r.lines) });
    setSelectedId("");
    setNoLyrics((r.lines ?? []).length === 0);
    setHasInstrumental(r.hasInstrumental);
    const aligned = prefs.source === LyricSource.SourceAlign || (prefs.source === LyricSource.SourceFile && /\.txt$/i.test(lyricsPath));
    setMatched(aligned ? r.matched : null);
    setPlayheadMs(0);
  });
  const lrc = useJobRun();
  const preview = useJobRun((job) => {
    const r = parseResult(job.resultJson);
    if (r?.previewPath) setPreviewPath(r.previewPath);
  });
  const render = useJobRun();

  // ---- navigation ----
  const guard = useCallback(
    (run: () => void) => {
      if (!dirty) return run();
      setConfirm({
        title: "Discard your lyric edits?",
        body: "The lines you edited by hand will be replaced.",
        label: "Discard",
        run,
      });
    },
    [dirty],
  );

  const takeSong = useCallback(
    (path: string) => {
      const apply = () => {
        setSongPath(path);
        setMeta({ title: "", artist: "" });
        metaFor.current = "";
        setText("");
        setLyricsPath("");
        dispatch({ type: "reset", rows: [] });
        setSelectedId("");
        setMatched(null);
        setNoLyrics(false);
        setHasInstrumental(false);
        setPlayheadMs(0);
        setTapIndex(-1);
        setPreviewPath("");
        setPreviewStartMs(0);
        gen.clear();
        lrc.clear();
        preview.clear();
        render.clear();
        setStep("song");
      };
      if (dirty) guard(apply);
      else apply();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dirty, guard],
  );

  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (handoff?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    const first = h?.inputs[0];
    if (first) takeSong(first);
  }, [handoff, moduleId, takeSong]);

  const exts = useModules((s) => s.byId[moduleId]?.accepts.extensions);
  const onPickSong = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a song", exts && exts.length > 0 ? exts : null, false)) ?? [];
      if (paths[0]) takeSong(paths[0]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [exts, takeSong]);

  const onPickLyricsFile = useCallback(async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a lyrics file", LYRIC_EXTS, false)) ?? [];
      if (paths[0]) setLyricsPath(paths[0]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, []);

  const onPickBackground = useCallback(
    async (kind: "image" | "video") => {
      try {
        const title = kind === "image" ? "Choose a background image" : "Choose a background video";
        const paths = (await FilesService.PickWith(title, kind === "image" ? IMAGE_EXTS : VIDEO_EXTS, false)) ?? [];
        const path = paths[0];
        if (path) setPrefs((o) => ({ ...o, look: { ...o.look, backgroundPath: path } }));
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
      }
    },
    [setPrefs],
  );

  // ---- playback ----
  const onSeek = useCallback((ms: number) => {
    setPlayheadMs(ms);
    playerRef.current?.seek(ms);
  }, []);
  const onPlayFrom = useCallback((ms: number) => {
    setPlayheadMs(ms);
    playerRef.current?.seek(ms);
    playerRef.current?.play();
  }, []);

  useEffect(() => {
    setPlayheadMs(0);
    setTapIndex(-1);
  }, [step]);

  // ---- editing ----
  const edit = useCallback((fn: (r: Row[]) => Row[], key?: string) => dispatch({ type: "edit", fn, key, at: Date.now() }), []);
  const onStart = useCallback((id: string, ms: number) => edit((r) => setLineStart(r, id, ms), `start:${id}`), [edit]);
  const onNudge = useCallback((id: string, d: number) => edit((r) => nudgeLine(r, id, d), `nudge:${id}`), [edit]);
  const onTextEdit = useCallback((id: string, t: string) => edit((r) => setLineText(r, id, t), `text:${id}`), [edit]);

  const activeIndex = useMemo(() => latestStarted(rows, playheadMs), [rows, playheadMs]);

  const onInsert = () => {
    const sel = rows.findIndex((r) => r.id === selectedId);
    const index = sel >= 0 ? sel : activeIndex >= 0 ? activeIndex : rows.length - 1;
    const res = insertAfter(rows, index, mediaReady ? Math.round(playheadMs) : undefined);
    edit(() => res.rows);
    setSelectedId(res.id);
  };
  const onDelete = () => {
    const sel = rows.findIndex((r) => r.id === selectedId);
    if (sel < 0) return;
    const neighbour = rows[sel + 1] ?? rows[sel - 1];
    edit((r) => deleteRow(r, selectedId));
    setSelectedId(neighbour?.id ?? "");
  };

  useShortcut("Mod+Z", () => dispatch({ type: "undo" }), { when: step === "lyrics" && !tapping, allowInInputs: true });
  useShortcut(["Mod+Shift+Z", "Mod+Y"], () => dispatch({ type: "redo" }), { when: step === "lyrics" && !tapping, allowInInputs: true });

  // ---- tap to sync ----
  const endTap = useCallback(() => {
    setTapIndex(-1);
    playerRef.current?.pause();
  }, []);
  const startTap = () => {
    if (rows.length === 0) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    playerRef.current?.seek(0);
    setPlayheadMs(0);
    playerRef.current?.play();
    setTapIndex(0);
  };
  const stamp = () => {
    const index = tapIndex;
    const ms = Math.round(playerRef.current?.currentMs() ?? playheadMs);
    const res = tapStamp(rows, index, ms);
    edit((r) => tapStamp(r, index, ms).rows);
    const row = res.rows[index];
    if (row) setSelectedId(row.id);
    if (res.done) endTap();
    else setTapIndex(res.next);
  };
  useShortcut(" ", stamp, { when: tapping });
  useShortcut("Backspace", () => setTapIndex(tapBack(tapIndex)), { when: tapping });
  useShortcut("Escape", endTap, { when: tapping });

  // ---- running jobs ----
  const onGetTimings = () => {
    if (!songPath) return;
    const run = () =>
      void gen.start(
        [songPath],
        buildOptions(LyricAction.ActionLyrics, prefs, meta, {
          text: prefs.source === LyricSource.SourceAlign ? text : "",
          lyricsPath: prefs.source === LyricSource.SourceFile ? lyricsPath : "",
        }),
      );
    if (dirty) guard(run);
    else run();
  };
  const onExportLrc = () => {
    if (!songPath || issues.blocker) return;
    void lrc.start([songPath], buildOptions(LyricAction.ActionLRC, prefs, meta, { lines: toLines(rows) }));
  };
  const lookBlocker =
    (look.background === "image" || look.background === "video") && !look.backgroundPath
      ? "Choose a background file on the Look step, or pick another background."
      : "";
  const blocker = issues.blocker || lookBlocker;
  const onPreview = () => {
    if (!songPath || blocker) return;
    setPreviewPath("");
    void preview.start(
      [songPath],
      buildOptions(LyricAction.ActionPreview, prefs, meta, { lines: toLines(rows), previewStartMs: Math.round(previewStartMs) }),
    );
  };
  const onRender = () => {
    if (!songPath || blocker) return;
    void render.start([songPath], buildOptions(LyricAction.ActionRender, prefs, meta, { lines: toLines(rows) }));
  };

  // ---- the shared player ----
  const playerNode =
    mediaReady && media.source && songPath ? (
      <MediaPlayer
        ref={playerRef}
        source={media.source}
        kind="audio"
        path={songPath}
        onTime={setPlayheadMs}
        keyboard={!tapping}
        {...(waveform ? { waveform } : {})}
      />
    ) : media.status === "error" ? null : (
      <div className={styles.muted}>Opening the song…</div>
    );

  const suspect = useMemo(() => (matched !== null && matched < 0.7 ? suspectIds(rows) : new Set<string>()), [matched, rows]);
  const tapLine = tapping ? (rows[tapIndex]?.text ?? "") : "";
  const hasLines = rows.length > 0;
  const reachable = (s: Step) => s === "song" || (!!songPath && (s === "lyrics" || hasLines));
  const renderWarning = look.background === "blur-cover" || look.background === "cover" ? (hasCover ? "" : "This song has no cover art, so the background falls back to a gradient.") : "";

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
            onClick={() => (tapping ? undefined : setStep(s.id))}
          >
            <span className={styles.stepNum}>{i + 1}</span>
            {s.label}
            {s.id === "lyrics" && dirty && <span className={styles.dot} role="img" aria-label="Edited lines" />}
            {i < STEPS.length - 1 && <Icon name="chevron-right" size={12} className={styles.stepSep} />}
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        {step === "song" && (
          <SongStep
            songPath={songPath}
            media={media}
            coverUrl={coverUrl}
            title={meta.title}
            artist={meta.artist}
            onTitle={(title) => setMeta((m) => ({ ...m, title }))}
            onArtist={(artist) => setMeta((m) => ({ ...m, artist }))}
            audio={prefs.audio}
            onAudio={(audio) => setPrefs((o) => ({ ...o, audio }))}
            hasInstrumental={hasInstrumental}
            rows={rows}
            onPick={() => void onPickSong()}
            onContinue={() => setStep("lyrics")}
          />
        )}
        {step === "lyrics" && songPath && (
          <LyricsStep
            moduleId={moduleId}
            prefs={prefs}
            setPrefs={setPrefs}
            languages={languages}
            text={text}
            onText={setText}
            lyricsPath={lyricsPath}
            onPickLyricsFile={() => void onPickLyricsFile()}
            gen={gen}
            engineBlocked={engineBlocked}
            onGetTimings={onGetTimings}
            player={playerNode}
            durationMs={durationMs}
            playheadMs={playheadMs}
            waveform={waveform}
            onSeek={onSeek}
            rows={rows}
            activeIndex={activeIndex}
            sheet={{
              selectedId,
              tapIndex,
              suspect,
              outOfOrder: issues.firstOutOfOrder,
              onSelect: setSelectedId,
              onStart,
              onNudge,
              onText: onTextEdit,
              onPlay: onPlayFrom,
            }}
            matched={matched}
            noLyrics={noLyrics}
            blocker={issues.blocker}
            blank={issues.blank}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onUndo={() => dispatch({ type: "undo" })}
            onRedo={() => dispatch({ type: "redo" })}
            onInsert={onInsert}
            onDelete={onDelete}
            canDelete={rows.some((r) => r.id === selectedId)}
            onShiftAll={(d) => edit((r) => shiftAll(r, d))}
            tapping={tapping}
            tapLine={tapLine}
            onTapStart={startTap}
            onTapEnd={endTap}
            lrc={lrc}
            onExportLrc={onExportLrc}
            onContinue={() => setStep("look")}
          />
        )}
        {step === "look" && (
          <LookStep
            prefs={prefs}
            setPrefs={setPrefs}
            meta={meta}
            fonts={fonts}
            rows={rows}
            playheadMs={playheadMs}
            coverUrl={coverUrl}
            imageUrl={imageUrl}
            hasCover={hasCover}
            player={playerNode}
            onPickBackground={(k) => void onPickBackground(k)}
            onContinue={() => {
              setPreviewStartMs(Math.max(0, Math.round(playheadMs)));
              setStep("render");
            }}
          />
        )}
        {step === "render" && (
          <RenderStep
            moduleId={moduleId}
            durationMs={durationMs}
            previewStartMs={previewStartMs}
            onPreviewStart={setPreviewStartMs}
            blocker={blocker}
            engineBlocked={engineBlocked}
            instrumental={prefs.audio === "instrumental"}
            warning={renderWarning}
            preview={preview}
            previewPath={previewPath}
            render={render}
            onPreview={onPreview}
            onRender={onRender}
          />
        )}
      </div>

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
