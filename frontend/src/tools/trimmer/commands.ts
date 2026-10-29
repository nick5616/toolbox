import type { Command } from "@/lib/commands";
import { useUI } from "@/state/ui";

/** Actions the palette can ask the Trimmer view to perform. */
export type TrimmerAction = "set-start" | "set-end" | "add-segment" | "export" | "choose-file";

type Listener = (a: TrimmerAction) => void;
const listeners = new Set<Listener>();

/** The mounted view subscribes here; returns the unsubscribe function. */
export function onTrimmerAction(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(a: TrimmerAction): void {
  for (const l of [...listeners]) l(a);
}

const inTrimmer = () => useUI.getState().view === "trimmer";

/** Palette entries for Video Trimmer. Merged by shell/useBuiltinCommands. */
export function trimmerCommands(): Command[] {
  return [
    {
      id: "trimmer.choose-file",
      title: "Trimmer: choose a file to trim",
      section: "Actions",
      icon: "scissors",
      keywords: ["video", "cut", "trim", "open"],
      run: () => {
        useUI.getState().navigate("trimmer");
        setTimeout(() => emit("choose-file"), 0);
      },
    },
    {
      id: "trimmer.set-start",
      title: "Trimmer: set segment start at playhead",
      section: "Actions",
      icon: "scissors",
      shortcut: "I",
      enabled: inTrimmer,
      run: () => emit("set-start"),
    },
    {
      id: "trimmer.set-end",
      title: "Trimmer: set segment end at playhead",
      section: "Actions",
      icon: "scissors",
      shortcut: "O",
      enabled: inTrimmer,
      run: () => emit("set-end"),
    },
    {
      id: "trimmer.add-segment",
      title: "Trimmer: add segment at playhead",
      section: "Actions",
      icon: "plus",
      enabled: inTrimmer,
      run: () => emit("add-segment"),
    },
    {
      id: "trimmer.export",
      title: "Trimmer: export",
      section: "Actions",
      icon: "scissors",
      shortcut: "Mod+Enter",
      enabled: inTrimmer,
      run: () => emit("export"),
    },
  ];
}
