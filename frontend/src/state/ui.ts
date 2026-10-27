import { create } from "zustand";
import type { FilesDropped } from "@/lib/api";

/** View ids: "library", "settings", or a module id. */
export type ViewId = string;

export interface Handoff {
  moduleId: string;
  inputs: string[];
}

interface UIState {
  view: ViewId;
  sidebarCollapsed: boolean;
  comingSoonOpen: boolean;
  trayOpen: boolean;
  trayHeight: number;
  paletteOpen: boolean;
  drop: FilesDropped | null;
  handoff: Handoff | null;
  expandedLogJobId: string | null;

  navigate: (view: ViewId) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setComingSoonOpen: (v: boolean) => void;
  setTrayOpen: (v: boolean) => void;
  setTrayHeight: (px: number) => void;
  setPaletteOpen: (v: boolean) => void;
  setDrop: (d: FilesDropped | null) => void;
  /** Sends inputs to a module's view and navigates there. */
  handOff: (h: Handoff) => void;
  /** Returns and clears the handoff if it targets moduleId. */
  takeHandoff: (moduleId: string) => Handoff | null;
  setExpandedLogJobId: (id: string | null) => void;
}

const STORAGE_KEY = "toolbox.ui";
type Persisted = Pick<UIState, "view" | "sidebarCollapsed" | "comingSoonOpen" | "trayOpen" | "trayHeight">;

function load(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    return {};
  }
}

function initialView(saved: Partial<Persisted>): ViewId {
  const fromQuery = new URLSearchParams(window.location.search).get("view");
  return fromQuery || saved.view || "downloader";
}

const saved = load();

export const useUI = create<UIState>((set, get) => ({
  view: initialView(saved),
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  comingSoonOpen: saved.comingSoonOpen ?? false,
  trayOpen: saved.trayOpen ?? false,
  trayHeight: saved.trayHeight ?? 300,
  paletteOpen: false,
  drop: null,
  handoff: null,
  expandedLogJobId: null,

  navigate: (view) => set({ view }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setComingSoonOpen: (comingSoonOpen) => set({ comingSoonOpen }),
  setTrayOpen: (trayOpen) => set({ trayOpen }),
  setTrayHeight: (trayHeight) => set({ trayHeight }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setDrop: (drop) => set({ drop }),
  handOff: (h) => set({ handoff: h, view: h.moduleId, drop: null }),
  takeHandoff: (moduleId) => {
    const h = get().handoff;
    if (!h || h.moduleId !== moduleId) return null;
    set({ handoff: null });
    return h;
  },
  setExpandedLogJobId: (expandedLogJobId) => set({ expandedLogJobId }),
}));

useUI.subscribe((s) => {
  const p: Persisted = {
    view: s.view,
    sidebarCollapsed: s.sidebarCollapsed,
    comingSoonOpen: s.comingSoonOpen,
    trayOpen: s.trayOpen,
    trayHeight: s.trayHeight,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
});
