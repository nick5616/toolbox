import { toast } from "@/components";
import { FilesService } from "@/lib/api";
import type { Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { pickFromLibrary } from "@/blocks/library-picker";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";

const MODULE_ID = "lyric-video";

/** Palette entries for Lyric Video. Merged by shell/useBuiltinCommands. */
export function lyricvideoCommands(): Command[] {
  return [
    {
      id: "lyricvideo.open",
      title: "Open Lyric Video",
      section: "Actions",
      icon: "mic-vocal",
      keywords: ["karaoke", "lyrics", "lrc", "song"],
      run: () => useUI.getState().navigate(MODULE_ID),
    },
    {
      id: "lyricvideo.make",
      title: "Make a lyric video from a song…",
      section: "Actions",
      icon: "mic-vocal",
      keywords: ["karaoke", "lyrics", "lrc", "video", "song"],
      run: async () => {
        try {
          const paths = (await FilesService.Pick(MODULE_ID)) ?? [];
          if (paths[0]) useUI.getState().handOff({ moduleId: MODULE_ID, inputs: [paths[0]] });
        } catch (e) {
          toast({ title: toAppError(e).message, tone: "danger" });
        }
      },
    },
    {
      id: "lyricvideo.make-library",
      title: "Make a lyric video from a song in Library…",
      section: "Actions",
      icon: "history",
      keywords: ["karaoke", "lyrics", "lrc", "video", "song", "library"],
      run: async () => {
        const exts = useModules.getState().byId[MODULE_ID]?.accepts.extensions;
        const paths = await pickFromLibrary({ title: "Choose a song from Library", exts: exts && exts.length > 0 ? exts : null, multiple: false });
        if (paths[0]) useUI.getState().handOff({ moduleId: MODULE_ID, inputs: [paths[0]] });
      },
    },
  ];
}
