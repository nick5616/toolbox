import { toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { openTool } from "@/lib/openTool";
import { useModules } from "@/state/modules";
import { toLines } from "./logic";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import { visualizerSeed } from "./visuals";

/** The extensions a song may have (null = any). */
export function useSongExts(): string[] | null {
  const exts = useModules((s) => s.byId[LYRIC_VIDEO_ID]?.accepts.extensions);
  return exts && exts.length > 0 ? exts : null;
}

/** Makes a picked file the song (shared by the native picker and From Library). */
export function adoptSong(paths: string[]): void {
  if (paths[0]) useLyricVideo.getState().requestSong(paths[0]);
}

/** Opens the file picker for a song and makes the answer the song (asking before lyric edits are lost). */
export function useChooseSong(): () => Promise<void> {
  const exts = useSongExts();
  return async () => {
    try {
      adoptSong((await FilesService.PickWith("Choose a song", exts, false)) ?? []);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
}

/** Opens the Visualizer with this song and these lyrics (and the look of the words) as its seed. */
export function makeInVisualizer(inWindow: boolean): void {
  const s = useLyricVideo.getState();
  if (!s.songPath) return;
  void openTool("visualizer", [s.songPath], { seed: visualizerSeed(toLines(s.rows), s.prefs.look) }, { window: inWindow });
}
