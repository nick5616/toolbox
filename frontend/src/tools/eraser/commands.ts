import type { Command } from "@/lib/commands";
import { useUI } from "@/state/ui";

/** Actions the palette can ask the Object Eraser view to perform. */
export type EraserAction = "choose-file" | "erase" | "clear" | "undo" | "redo";

type Listener = (a: EraserAction) => void;
const listeners = new Set<Listener>();

/** The mounted view subscribes here; returns the unsubscribe function. */
export function onEraserAction(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(a: EraserAction): void {
  for (const l of [...listeners]) l(a);
}

const inEraser = () => useUI.getState().view === "object-eraser";

/** Palette entries for Object Eraser. Merged by shell/useBuiltinCommands. */
export function eraserCommands(): Command[] {
  return [
    {
      id: "eraser.choose-file",
      title: "Object Eraser: choose a photo",
      section: "Actions",
      icon: "eraser",
      keywords: ["remove", "object", "inpaint", "retouch", "open"],
      run: () => {
        useUI.getState().navigate("object-eraser");
        setTimeout(() => emit("choose-file"), 0);
      },
    },
    { id: "eraser.erase", title: "Object Eraser: erase the painted area", section: "Actions", icon: "eraser", shortcut: "Enter", enabled: inEraser, run: () => emit("erase") },
    { id: "eraser.undo", title: "Object Eraser: undo stroke", section: "Actions", icon: "undo-2", shortcut: "Mod+Z", enabled: inEraser, run: () => emit("undo") },
    { id: "eraser.redo", title: "Object Eraser: redo stroke", section: "Actions", icon: "redo-2", shortcut: "Mod+Shift+Z", enabled: inEraser, run: () => emit("redo") },
    { id: "eraser.clear", title: "Object Eraser: clear the mask", section: "Actions", icon: "trash-2", shortcut: "Mod+Backspace", enabled: inEraser, run: () => emit("clear") },
  ];
}
