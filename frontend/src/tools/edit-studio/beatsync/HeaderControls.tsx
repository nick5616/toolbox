/**
 * The edit's main settings, always in reach in the header: aspect, frame
 * rate and the song (change it, its range, analyze again, split into stems).
 */
import { MenuButton, Select, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { ASPECTS } from "@/viz/edit/types";
import { useNewEditRequest } from "../home/newEditRequest";
import { editDoc, openRangePicker } from "../inspector/inspectorState";
import { useEditStudio, useProject } from "../store";
import { SONG_EXTENSIONS } from "../transport/logic";
import styles from "../EditStudioView.module.css";

const ASPECT_LABELS: Record<string, string> = { "9:16": "9:16 TikTok / Reels", "4:5": "4:5 Feed", "1:1": "1:1 Square", "16:9": "16:9 YouTube" };

export function HeaderControls({ disabled }: { disabled: boolean }) {
  const project = useProject();
  if (!project) return null;
  const songName = project.song?.path.split(/[\\/]/).pop() ?? "No song";

  const changeSong = async () => {
    try {
      const picked = (await FilesService.PickWith("Pick a song", SONG_EXTENSIONS, false)) ?? [];
      const p = picked[0];
      if (p) useNewEditRequest.getState().askSong(p);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  return (
    <span className={styles.badges}>
      <Select size="sm" data-tip="Video shape: 9:16 for TikTok and Reels, 4:5 feed, 1:1 square, 16:9 YouTube" aria-label="Aspect" value={project.aspect} onChange={(aspect) => editDoc((p) => ({ ...p, aspect }), "")} options={ASPECTS.map((a) => ({ value: a, label: ASPECT_LABELS[a] ?? a }))} />
      <Select
        size="sm"
        aria-label="Frame rate"
        data-tip="Frames per second; 60 is smoother but takes longer to prepare and export"
        value={String(project.fps)}
        onChange={(v) => editDoc((p) => ({ ...p, fps: Number(v) }), "")}
        options={[
          { value: "30", label: "30 fps" },
          { value: "60", label: "60 fps" },
        ]}
      />
      <MenuButton
        data-tip="Song: change it, pick which part to use, analyze again or split into stems"
        size="sm"
        label={songName}
        icon="music"
        items={() => [
          { id: "change", label: "Change song…", icon: "music", tip: "Pick a different song; you choose whether to keep your clips", onSelect: () => void changeSong() },
          { id: "range", label: "Change the part of the song…", icon: "scissors", tip: "Choose which start and end of the song the edit uses", disabled, onSelect: openRangePicker },
          { id: "analyze", label: "Analyze again (beats, stems, lyrics)…", icon: "refresh-cw", tip: "Find beats, stems and lyrics again; your clips and markers are kept", disabled: !project.song, onSelect: () => useEditStudio.getState().setReanalyze(true) },
          {
            id: "stems",
            label: "Split into stems (vocals, drums, bass, other)…",
            icon: "audio-lines",
            tip: "Open the Stems tool to separate the song into vocals, drums, bass and other",
            disabled: !project.song,
            onSelect: () => project.song && useUI.getState().handOff({ moduleId: "stems", inputs: [project.song.path] }),
          },
        ]}
      />
    </span>
  );
}
