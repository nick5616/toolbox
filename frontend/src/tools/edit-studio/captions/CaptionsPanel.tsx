/** The Captions tab (§14.9). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Section, Switch } from "@/components";
import { TextStyleEditor } from "@/components/viz/TextStyleEditor";
import { EditStudioService, type EditCaptions } from "@/lib/api";
import type { TextLine } from "@/viz/analysis";
import { DEFAULT_TEXT_STYLE, parseTextStyle, serializeCaptionLines, serializeTextStyle } from "@/viz/edit/schema";
import type { TextStyle } from "@/viz/types";
import { useEditStudio, useProject } from "@/editor/store";
import { TextActions } from "@/tools/_kit";
import { exportSrt } from "./exportSrt";
import { deleteLine, effectiveLines, insertAfter, linesInRange, mergeNext, setLineText, setLineTime, setWordText, setWordTime, splitLine } from "./lines";
import { WordList, type RowAction } from "./WordList";
import styles from "./CaptionsPanel.module.css";

let fontsCache: Promise<string[]> | null = null;
function loadFonts(): Promise<string[]> {
  fontsCache ??= EditStudioService.Fonts().then(
    (f) => f ?? [],
    () => {
      fontsCache = null;
      return [];
    },
  );
  return fontsCache;
}

/** The "where do the words come from" line. */
export function wordsSource(source: string | undefined, haveLines: boolean): string {
  if (!haveLines) return "No words: analyse with words…";
  if (source === "detect") return "Detected from the vocals";
  if (source === "align") return "Aligned to your lyrics";
  if (source === "file") return "Loaded from a lyrics file";
  return "Words from the analysis";
}

export function CaptionsPanel() {
  const project = useProject();
  const analysis = useEditStudio((s) => s.analysis);
  const mattes = useEditStudio((s) => s.mattes);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const [fonts, setFonts] = useState<string[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | undefined>(undefined);

  useEffect(() => {
    let off = false;
    void loadFonts().then((f) => !off && setFonts(f));
    return () => {
      off = true;
    };
  }, []);

  const captions = project?.captions ?? null;
  const song = project?.song ?? null;
  const style = useMemo(() => (captions ? parseTextStyle(captions.style).value : DEFAULT_TEXT_STYLE), [captions?.style]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectName = useEditStudio((s) => s.name);
  const lines = useMemo(() => effectiveLines(captions, analysis), [captions, analysis]);
  const rows = useMemo(() => (song ? linesInRange(lines, song.startMs, song.endMs).map((index) => ({ index, line: lines[index] as TextLine })) : []), [lines, song]);

  const setCaptions = useCallback((next: EditCaptions | null, key?: string) => {
    const s = useEditStudio.getState();
    const p = s.history?.present;
    if (p) s.edit({ ...p, captions: next }, key);
  }, []);

  /** Current captions at call time (handlers must not use stale closures while typing). */
  const current = () => useEditStudio.getState().history?.present.captions ?? null;
  const writeLines = useCallback(
    (fn: (cur: TextLine[]) => TextLine[], key?: string) => {
      const s = useEditStudio.getState();
      const c = s.history?.present.captions;
      if (!c) return;
      const cur = effectiveLines(c, s.analysis);
      const next = fn(cur);
      if (next === cur) return;
      setCaptions({ ...c, lines: serializeCaptionLines(next) }, key);
    },
    [setCaptions],
  );

  if (!project) return null;
  const hasMatte = project.tracks.some((t) => t.clips.some((c) => c.matte?.id && mattes[c.matte.id]?.ready));
  const offset = song?.startMs ?? 0;
  const edited = !!captions?.lines;
  const analysisHasWords = (analysis?.text?.lines.length ?? 0) > 0;
  const songPlayhead = playheadMs + offset;

  const act = (action: RowAction, i: number, caret: number) => {
    switch (action) {
      case "split":
        writeLines((l) => splitLine(l, i, caret));
        break;
      case "merge":
        writeLines((l) => mergeNext(l, i));
        break;
      case "insert":
        writeLines((l) => insertAfter(l, i));
        setFocusIndex(i + 1);
        break;
      case "delete":
        writeLines((l) => deleteLine(l, i));
        break;
      case "startAtPlayhead":
        writeLines((l) => setLineTime(l, i, { startMs: songPlayhead }));
        break;
      case "endAtPlayhead":
        writeLines((l) => setLineTime(l, i, { endMs: songPlayhead }));
        break;
    }
  };

  const addAtPlayhead = () => {
    const cur = effectiveLines(current(), useEditStudio.getState().analysis);
    let at = -1;
    cur.forEach((l, i) => {
      if (l.startMs <= songPlayhead) at = i;
    });
    writeLines((l) => insertAfter(l, at, songPlayhead));
    setFocusIndex(at + 1);
  };

  return (
    <div className={styles.panel}>
      <Section label="Captions" tip="Words from the song drawn over the video, like subtitles or a lyric video">
        <Switch
          tip="Draw the song's words over the video; turning it off removes your caption edits"
          label="Show captions"
          checked={!!captions}
          onChange={(on) => setCaptions(on ? { style: serializeTextStyle(DEFAULT_TEXT_STYLE), behindSubject: false, lines: "" } : null)}
        />
        {!captions && <p className={styles.hint}>Draw the song's words over the video, like subtitles or a lyric video.</p>}
      </Section>

      {captions && (
        <>
          <Section label="Style" tip="Font, size, colour and look of the captions">
            <TextStyleEditor
              value={style}
              fonts={fonts}
              allowMood={!!analysis?.text?.mood?.length}
              onChange={(next: TextStyle) => {
                const c = current();
                if (c) setCaptions({ ...c, style: serializeTextStyle(next) }, "captions-style");
              }}
            />
          </Section>

          <Section label="Layering" tip="Where captions sit relative to the people in the video">
            <Switch
              tip={!hasMatte && !captions.behindSubject ? "Needs a cut-out on a clip first (Cut-out in that clip's Inspector)" : "Draw the captions behind the cut-out person so they stand in front of the words"}
              label="Behind the subject"
              checked={captions.behindSubject}
              disabled={!hasMatte && !captions.behindSubject}
              onChange={(behindSubject) => {
                const c = current();
                if (c) setCaptions({ ...c, behindSubject });
              }}
            />
            {!hasMatte && <p className={styles.hint}>Make a cut-out on a clip first</p>}
          </Section>

          <Section
            label="Words"
            tip="The caption lines and their timing; edit text, times or split and merge lines"
            action={
              <Button size="sm" variant="ghost" icon="rotate-ccw" data-tip={edited ? "Throw away your edits and use the words found by the analysis" : "Nothing to reset: the words are as the analysis found them"} disabled={!edited} onClick={() => { const c = current(); if (c) setCaptions({ ...c, lines: "" }); }}>
                Reset to the analysis
              </Button>
            }
          >
            <p className={styles.source} data-testid="words-source" data-tip="Where the words came from">
              {wordsSource(analysis?.text?.source, analysisHasWords || (edited && lines.length > 0))}
              {edited ? " (edited)" : ""}
            </p>
            {!analysisHasWords && !edited && <p className={styles.hint}>Use "Analyze again…" on the song in Setup and choose to detect the words or paste the lyrics.</p>}
            {rows.length === 0 && <p className={styles.hint}>No lines inside this edit's song range.</p>}
            {rows.length > 0 && (
              <WordList
                rows={rows}
                offset={offset}
                playheadMs={playheadMs}
                focusIndex={focusIndex}
                onFocused={() => setFocusIndex(undefined)}
                onText={(i, text) => writeLines((l) => setLineText(l, i, text), `cap-text:${i}`)}
                onTime={(i, t) => writeLines((l) => setLineTime(l, i, t), `cap-time:${i}`)}
                onWordText={(i, w, text) => writeLines((l) => setWordText(l, i, w, text), `cap-word:${i}:${w}`)}
                onWordTime={(i, w, t) => writeLines((l) => setWordTime(l, i, w, t), `cap-wtime:${i}:${w}`)}
                onAction={act}
                onSeek={(ms) => useEditStudio.getState().setPlayhead(ms)}
              />
            )}
            <div className={styles.actions}>
              <Button size="sm" icon="plus" data-tip="Add a new empty line starting at the playhead" onClick={addAtPlayhead}>
                Add a line at the playhead
              </Button>
              <Button size="sm" icon="download" data-tip="Save the captions as an .srt subtitle file you can use in other apps" onClick={() => void exportSrt()}>
                Export SRT
              </Button>
              <TextActions text={() => lines.map((l) => l.text).join("\n")} filename={`${projectName || "Captions"}.txt`} what="caption text" disabled={lines.length === 0} />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
