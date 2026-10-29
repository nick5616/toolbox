import { toast } from "@/components";
import { FilesService } from "@/lib/api";
import type { Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";

const MODULE_ID = "subtitles";

/** Palette entries for Subtitles. Merged by shell/useBuiltinCommands. */
export function subtitlesCommands(): Command[] {
  return [
    {
      id: "subtitles.open",
      title: "Open Subtitles",
      section: "Actions",
      icon: "captions",
      keywords: ["captions", "srt", "vtt", "subtitle"],
      run: () => useUI.getState().navigate(MODULE_ID),
    },
    {
      id: "subtitles.generate",
      title: "Generate subtitles from a video or audio file…",
      section: "Actions",
      icon: "captions",
      keywords: ["transcribe", "whisper", "captions", "speech"],
      run: async () => {
        try {
          const paths = (await FilesService.Pick(MODULE_ID)) ?? [];
          const media = paths.find((p) => !/\.(srt|vtt)$/i.test(p));
          if (media) useUI.getState().handOff({ moduleId: MODULE_ID, inputs: [media] });
        } catch (e) {
          toast({ title: toAppError(e).message, tone: "danger" });
        }
      },
    },
    {
      id: "subtitles.edit-file",
      title: "Edit a subtitle file…",
      section: "Actions",
      icon: "file-text",
      keywords: ["srt", "vtt", "captions", "edit", "shift", "translate"],
      run: async () => {
        try {
          const paths = (await FilesService.PickWith("Choose a subtitle file", [".srt", ".vtt"], false)) ?? [];
          if (paths[0]) useUI.getState().handOff({ moduleId: MODULE_ID, inputs: [paths[0]] });
        } catch (e) {
          toast({ title: toAppError(e).message, tone: "danger" });
        }
      },
    },
  ];
}
