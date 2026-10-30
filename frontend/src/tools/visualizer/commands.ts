import { toast } from "@/components";
import { FilesService } from "@/lib/api";
import type { Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { useVisualizer, type VisualizerStep } from "./store";

const MODULE_ID = "visualizer";

/** Goes to a step when its prerequisites exist, else to Source. */
function go(step: VisualizerStep) {
  useUI.getState().navigate(MODULE_ID);
  const s = useVisualizer.getState();
  const ok = step === "source" || (step === "analyze" && !!s.input) || (step === "design" && !!s.ref) || (step === "export" && !!s.ref && !!s.show);
  s.setStep(ok ? step : "source");
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
          else go("source");
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
        go("design");
        setTimeout(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="design-stage"]');
          void el?.requestFullscreen?.().catch(() => undefined);
        }, 100);
      },
    },
  ];
}
