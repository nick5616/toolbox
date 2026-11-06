import { useCommandRegistry } from "@/lib/commands";
import { useShortcut } from "@/lib/shortcuts";
import { useUI } from "@/state/ui";
import { useNavGroups } from "./nav";

/** The command id a tool registers (with `useCommands`) to open its file picker; Mod+O runs it. */
export const ADD_FILES_COMMAND = "tool.addFiles";

/** Runs the current tool's "add files" command. Returns false when no tool registered one. */
export function runAddFiles(): boolean {
  const c = useCommandRegistry.getState().commands[ADD_FILES_COMMAND];
  if (!c || !(c.enabled?.() ?? true)) return false;
  void Promise.resolve(c.run());
  return true;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => `Mod+${d}`);

export function useShellShortcuts(): void {
  const { ordered } = useNavGroups();
  const paletteOpen = useUI((s) => s.paletteOpen);
  const dropOpen = useUI((s) => s.drop !== null);
  const logOpen = useUI((s) => s.expandedLogJobId !== null);

  useShortcut(DIGITS, (e) => {
    const idx = Number(e.key) - 1;
    const item = ordered[idx];
    if (item) useUI.getState().navigate(item.id);
  });
  useShortcut("Mod+O", () => void runAddFiles());
  useShortcut("?", () => useUI.getState().setShortcutsOpen(!useUI.getState().shortcutsOpen));
  useShortcut("Mod+,", () => useUI.getState().navigate("settings"));
  useShortcut("Mod+J", () => useUI.getState().setTrayOpen(!useUI.getState().trayOpen));
  useShortcut("Mod+Backslash", () => useUI.getState().toggleSidebar());

  // Esc closes the topmost overlay. The palette closes itself; `paletteOpen`
  // is the render-time value, so this never double-closes in the same event.
  useShortcut(
    "Escape",
    () => {
      const ui = useUI.getState();
      if (paletteOpen) return;
      if (dropOpen) ui.setDrop(null);
      else if (logOpen) ui.setExpandedLogJobId(null);
    },
    { allowInInputs: true, preventDefault: false, when: !paletteOpen && (dropOpen || logOpen) },
  );
}
