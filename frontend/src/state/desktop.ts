import { create } from "zustand";
import type { ClipboardState, HotkeyStatus } from "@/lib/api";

/** Desktop-shell state shared by every window: clipboard recorder and hotkeys. */
interface DesktopState {
  clipboard: ClipboardState;
  hotkeys: HotkeyStatus[];
  setClipboardState: (s: ClipboardState) => void;
  setHotkeys: (h: HotkeyStatus[]) => void;
}

export const useDesktop = create<DesktopState>((set) => ({
  clipboard: { recording: false, paused: false, error: "" },
  hotkeys: [],
  setClipboardState: (clipboard) => set({ clipboard }),
  setHotkeys: (hotkeys) => set({ hotkeys }),
}));
