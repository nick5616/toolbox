import type { Command } from "@/lib/commands";
import { useUI } from "@/state/ui";

/** Actions the palette can ask the Redact view to perform. */
export type RedactViewAction = "choose-file" | "detect" | "redact" | "add-box";

type Listener = (a: RedactViewAction) => void;
const listeners = new Set<Listener>();

/** The mounted view subscribes here; returns the unsubscribe function. */
export function onRedactAction(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(a: RedactViewAction): void {
  for (const l of [...listeners]) l(a);
}

const inRedact = () => useUI.getState().view === "redact";

/** Palette entries for Redact. Merged by shell/useBuiltinCommands. */
export function redactCommands(): Command[] {
  return [
    {
      id: "redact.choose-file",
      title: "Redact: choose photos or a video",
      section: "Actions",
      icon: "scan-face",
      keywords: ["blur", "faces", "plates", "privacy", "censor", "pixelate", "open"],
      run: () => {
        useUI.getState().navigate("redact");
        setTimeout(() => emit("choose-file"), 0);
      },
    },
    { id: "redact.detect", title: "Redact: find faces and plates", section: "Actions", icon: "scan-search", enabled: inRedact, run: () => emit("detect") },
    { id: "redact.apply", title: "Redact: save the redacted copy", section: "Actions", icon: "scan-face", shortcut: "Enter", enabled: inRedact, run: () => emit("redact") },
    { id: "redact.add-box", title: "Redact: add a box by hand", section: "Actions", icon: "square-dashed", shortcut: "B", enabled: inRedact, run: () => emit("add-box") },
  ];
}
