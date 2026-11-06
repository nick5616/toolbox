/**
 * Lyric Video (SPEC.md §9.2; Phase 11 §5.4): a drop zone until a song is
 * chosen, then one workspace (`LyricVideoWorkspace`): song chip, undo/redo and
 * Render in the header, the Song / Lyrics / Visuals / Look panels in the rail,
 * the preview on the stage and the lyric lines at the side.
 *
 * The song, its lyric sheet and its undo history live in the store (they
 * survive leaving the tool); the look and options are remembered in module
 * state. `?vizfixture=1` opens with a sample sheet so the visuals can be tried
 * without a song.
 */
import { Suspense, lazy, useEffect } from "react";
import { Button, ClickInHost, DropZone, Spinner } from "@/components";
import { fixtureFlag } from "@/components/viz/useVisualsAnalysis";
import { SettingsService } from "@/lib/api";
import { useToolHandoff } from "@/lib/embed";
import { useCompositionInputs } from "@/state/composition";
import { DepsGate } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { useChooseSong } from "./actions";
import { useEngineRequirement } from "./engine";
import type { Row } from "./logic";
import { DEFAULT_PREFS, sanitizePrefs } from "./options";
import { useLyricVideo } from "./store";
import { lyricVideoWorkspace as ws } from "./workspace";
import styles from "./panels.module.css";

const LyricVideoWorkspace = lazy(() => import("./LyricVideoWorkspace"));

/** Dev only (`?vizfixture=1`): a sample sheet so the Visuals panel opens without a song. */
const FIXTURE_SONG = "C:\\fixture\\song.mp3";
const FIXTURE_LINES: Row[] = [
  { id: "f1", startMs: 2000, endMs: 6000, text: "Hold the light a little longer", words: [] },
  { id: "f2", startMs: 6500, endMs: 10500, text: "Let the morning find us here", words: [] },
  { id: "f3", startMs: 11000, endMs: 15000, text: "Every colour in the sky", words: [] },
];

/** The look and options are remembered between sessions (never the lyrics). */
function usePrefsPersistence(moduleId: string): void {
  const prefs = useLyricVideo((s) => s.prefs);
  const dirty = useLyricVideo((s) => s.prefsDirty);
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const saved = await SettingsService.ModuleState(moduleId);
        if (!off && saved) useLyricVideo.getState().loadPrefs(sanitizePrefs(JSON.parse(saved) as unknown, DEFAULT_PREFS));
      } catch {
        /* unreadable state: the defaults stay */
      }
    })();
    return () => {
      off = true;
    };
  }, [moduleId]);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      SettingsService.SetModuleState(moduleId, JSON.stringify(prefs)).catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [prefs, dirty, moduleId]);
}

function EmptySong({ moduleId }: { moduleId: string }) {
  const choose = useChooseSong();
  return (
    <div className={styles.sourceEmpty}>
      <DropZone id="tool-drop:lyric-video" icon="mic-vocal" label="Drop a song" hint="Turn a song and its lyrics into a video with the words on screen.">
        <div className={styles.buttonRow}>
          <Button icon="plus" onClick={() => void choose()} data-tip="Pick an audio file from your computer">
            Choose a song…
          </Button>
        </div>
      </DropZone>
      <DepsGate moduleId={moduleId} />
    </div>
  );
}

export default function LyricVideoView({ moduleId }: ToolViewProps) {
  const songPath = useLyricVideo((s) => s.songPath);

  usePrefsPersistence(moduleId);
  useEngineRequirement();
  ws.useHost();
  useToolHandoff(moduleId, (h) => {
    const first = h.inputs[0];
    if (first) useLyricVideo.getState().requestSong(first);
  });
  useCompositionInputs(moduleId, songPath ? { stems: [songPath], transcribe: [songPath], visualizer: [songPath] } : {});

  // Dev only: `?vizfixture=1` starts with a sample sheet.
  useEffect(() => {
    if (!fixtureFlag() || useLyricVideo.getState().songPath) return;
    const s = useLyricVideo.getState();
    s.applySong(FIXTURE_SONG);
    s.setMeta({ title: "Golden Hour", artist: "Fixture" });
    s.resetSheet(FIXTURE_LINES);
    s.setVisualsEngaged(true);
  }, []);

  return (
    <ClickInHost className={styles.root}>
      {songPath ? (
        <Suspense fallback={<Spinner size={18} label="Loading" />}>
          <LyricVideoWorkspace />
        </Suspense>
      ) : (
        <EmptySong moduleId={moduleId} />
      )}
    </ClickInHost>
  );
}
