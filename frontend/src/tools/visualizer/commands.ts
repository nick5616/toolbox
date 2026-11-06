import { toast } from "@/components";
import { FilesService } from "@/lib/api";
import type { Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { useVisualizer } from "./store";

const MODULE_ID = "visualizer";

/** Opens the workspace on a panel when there is something to put in it (an analysed song for Export); else just the tool. */
function go(panel: "export" | null) {
  useUI.getState().navigate(MODULE_ID);
  const s = useVisualizer.getState();
  if (panel === "export" && s.analysis && s.show) s.requestPanel("export");
}

/** Palette entries for the Visualizer. Merged by shell/useBuiltinCommands. */
export function visualizerCommands(): Command[] {
  return [
    {
      id: "visualizer.open",
      title: "Open Visualizer",
      section: "Actions",
      icon: "sparkles",
      keywords: ["music", "video", "reactive", "visuals"],
      run: () => useUI.getState().navigate(MODULE_ID),
    },
    {
      id: "visualizer.analyze",
      title: "Visualizer: analyze a song…",
      section: "Actions",
      icon: "sparkles",
      keywords: ["listen", "beats", "sections"],
      run: async () => {
        try {
          const paths = (await FilesService.Pick(MODULE_ID)) ?? [];
          if (paths[0]) useUI.getState().handOff({ moduleId: MODULE_ID, inputs: [paths[0]] });
          else go(null);
        } catch (e) {
          toast({ title: toAppError(e).message, tone: "danger" });
        }
      },
    },
    {
      id: "visualizer.render",
      title: "Visualizer: render the video",
      section: "Actions",
      icon: "film",
      keywords: ["export"],
      run: () => go("export"),
    },
    {
      id: "visualizer.render-preview",
      title: "Visualizer: render a 10 s preview",
      section: "Actions",
      icon: "play",
      keywords: ["export", "preview"],
      run: () => go("export"),
    },
    {
      id: "visualizer.fullscreen",
      title: "Visualizer: full screen preview",
      section: "Actions",
      icon: "maximize",
      run: () => {
        go(null);
        setTimeout(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="design-stage"]');
          void el?.requestFullscreen?.().catch(() => undefined);
        }, 100);
      },
    },
  ];
}
