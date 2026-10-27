import { useShortcut } from "@/lib/shortcuts";
import { useUI } from "@/state/ui";
import { useNavGroups } from "./nav";

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
  useShortcut("Mod+,", () => useUI.getState().navigate("settings"));
  useShortcut("Mod+J", () => useUI.getState().setTrayOpen(!useUI.getState().trayOpen));
  useShortcut("Mod+Backslash", () => useUI.getState().setSidebarCollapsed(!useUI.getState().sidebarCollapsed));

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
