/**
 * The Lyrics panel (formerly the first half of the Lyrics step): where the
 * words come from (detect from the vocals, paste them, or a file), the sung
 * language and Get timings. The timed lines themselves are the `lines` panel.
 * It submits a job, so it only opens inline.
 */
import { useEffect, useState } from "react";
import { Banner, Button, ConfirmDialog, SegmentedControl, Select, TextArea, toast } from "@/components";
import { FilesService, LyricAction, LyricSource, TranscribeService, type Language } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { DepsGate } from "@/tools/_kit";
import { useEngineGate } from "./engine";
import { LOW_MATCH, OKAY_MATCH } from "./logic";
import { LYRIC_EXTS, buildOptions } from "./options";
import { RunStatus } from "./RunStatus";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import { useJobRun } from "./useJobRun";
import styles from "./panels.module.css";

const SOURCE_OPTIONS: Array<{ value: LyricSource; label: string; tip: string }> = [
  { value: LyricSource.SourceDetect, label: "Detect from the song", tip: "Listen to the isolated vocals and write out the words with timing" },
  { value: LyricSource.SourceAlign, label: "Paste lyrics", tip: "Paste the real lyrics; they are matched to the singing for accurate timing" },
  { value: LyricSource.SourceFile, label: "From a file", tip: "Load lyrics that already have timing from an .lrc, .srt or .vtt file, or plain .txt" },
];

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export default function LyricsPanel() {
  const prefs = useLyricVideo((s) => s.prefs);
  const songPath = useLyricVideo((s) => s.songPath);
  const text = useLyricVideo((s) => s.text);
  const lyricsPath = useLyricVideo((s) => s.lyricsPath);
  const matched = useLyricVideo((s) => s.matched);
  const noLyrics = useLyricVideo((s) => s.noLyrics);
  const gen = useJobRun("gen");
  const gate = useEngineGate("lyrics");
  const [languages, setLanguages] = useState<Language[]>([]);
  const [confirm, setConfirm] = useState(false);
  const st = useLyricVideo.getState;
  const source = prefs.source;

  useEffect(() => {
    let off = false;
    TranscribeService.Languages().then((l) => !off && setLanguages(l ?? [])).catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);

  const languageOptions = [{ value: "", label: "Auto-detect" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];
  const textOk = source !== "align" || text.trim() !== "";
  const fileOk = source !== "file" || lyricsPath !== "";
  const canGet = textOk && fileOk && !gen.busy && !gate.blocked;

  const onPickFile = async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a lyrics file", LYRIC_EXTS, false)) ?? [];
      if (paths[0]) st().setLyricsPath(paths[0]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const run = () => {
    const s = st();
    if (!s.songPath) return;
    void gen.start(
      [s.songPath],
      buildOptions(LyricAction.ActionLyrics, s.prefs, s.meta, {
        text: s.prefs.source === LyricSource.SourceAlign ? s.text : "",
        lyricsPath: s.prefs.source === LyricSource.SourceFile ? s.lyricsPath : "",
      }),
    );
  };
  const onGet = () => (st().history.past.length > 0 ? setConfirm(true) : run());
  if (!songPath) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.form}>
        <SegmentedControl aria-label="Lyrics source" value={source} options={SOURCE_OPTIONS} onChange={(v) => st().setPrefs((o) => ({ ...o, source: v }))} />
        {source === "align" && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Lyrics (recommended)</span>
            <TextArea
              aria-label="Lyrics"
              data-tip="Plain text, one line per row; up to 20,000 characters"
              minRows={5}
              maxRows={12}
              maxLength={20000}
              value={text}
              placeholder="Paste the words, one line per row"
              onChange={(e) => st().setText(e.target.value)}
            />
            <span className={styles.hint}>Paste the words and Toolbox times them to the song.</span>
          </label>
        )}
        {source === "detect" && <div className={styles.hint}>Listens to the isolated vocals. It works best on clear singing; pasting the lyrics is more reliable.</div>}
        {source === "file" && (
          <div className={styles.buttonRow}>
            <Button variant="secondary" icon="file-text" onClick={() => void onPickFile()} data-tip="Pick a lyrics file: .lrc, .srt, .vtt or .txt">
              Choose a .lrc, .srt, .vtt or .txt…
            </Button>
            <span className={styles.muted}>{lyricsPath ? basenameOf(lyricsPath) : "No file chosen"}</span>
          </div>
        )}
        {source !== "file" && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Sung language</span>
            <Select aria-label="Sung language" data-tip="The language of the singing; set it if auto-detect gets it wrong" value={prefs.language} options={languageOptions} onChange={(language) => st().setPrefs((o) => ({ ...o, language }))} />
          </label>
        )}
        {gate.needed && <DepsGate moduleId={LYRIC_VIDEO_ID} />}
        <div className={styles.buttonRow}>
          <Button
            icon="wand-sparkles"
            onClick={onGet}
            loading={gen.busy}
            disabled={!canGet}
            data-tip={canGet ? "Find out when each line is sung and fill the lyric lines" : gen.busy ? "Timing is already running" : gate.blocked ? "The AI engine isn't installed yet" : source === "align" ? "Paste the lyrics first" : "Choose a lyrics file first"}
          >
            Get timings
          </Button>
        </div>
        <RunStatus run={gen} runningLabel="Timing the lyrics…" showResult={false} />
      </div>

      {noLyrics && (
        <Banner tone="warn" title="No lyrics were found">
          Try pasting the lyrics, or choose a lyrics file. You can also add lines by hand in the lyric lines.
        </Banner>
      )}
      {matched !== null && matched < LOW_MATCH && (
        <Banner tone="warn" title="Couldn't follow the song well — check the timings">
          Only {Math.round(matched * 100)}% of the words matched what was sung. Use tap to sync or the nudge buttons to fix the lines.
        </Banner>
      )}
      {matched !== null && matched >= LOW_MATCH && matched < OKAY_MATCH && (
        <Banner tone="info" title="Some lines may be off">
          {Math.round(matched * 100)}% of the words matched. Lines marked in orange look suspicious.
        </Banner>
      )}

      <ConfirmDialog
        open={confirm}
        title="Discard your lyric edits?"
        body="The lines you edited by hand will be replaced."
        confirmLabel="Discard"
        tone="danger"
        onConfirm={() => {
          setConfirm(false);
          run();
        }}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

