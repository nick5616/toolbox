import { create } from "zustand";
import type { FilesDropped, TimedLine } from "@/lib/api";
import { matchesNow, NARROW_QUERY, useMediaQuery } from "@/lib/media";
import { currentWindow } from "@/lib/windows";

/** View ids: "library", "settings", "setup" (the setup overlay), or a module id. */
export type ViewId = string;

export interface Handoff {
  moduleId: string;
  inputs: string[];
  /** Extra data for the target tool (SPEC.md §9.4): timed text for the Visualizer. */
  seed?: ToolSeed;
  /** A Post Builder slide to make or edit (SPEC.md Part B §B7.5): Photo Composer and Video Editor. */
  postSlide?: PostSlideSeed;
  /** A piece of text for the tool (Phase 11 §5): Local Chat starts a conversation about it; Dev Utilities opens it in the matching utility. */
  text?: TextSeed;
  /** Set when the tool was opened from another tool's click-in into its own window: its "Use" sends results back (Phase 11 §4). */
  embed?: EmbedLink;
}

/** Text handed to a tool (a transcript, OCR text, a clipboard item). */
export interface TextSeed {
  /** What the text is, for headings and the first message ("Transcript of interview.mp3"). */
  title: string;
  body: string;
  /** Local Chat: one-click prompts offered above the composer ("Summarise", "Key points"). */
  prompts?: string[];
}

/** How a tool window returns results to the click-in it was popped out of (lib/embed.ts). */
export interface EmbedLink {
  /** Random per click-in; the host listens for it on the "embed" relay channel. */
  token: string;
  /** Host module id and name ("photo-composer", "Photo Composer"). */
  host: string;
  hostName: string;
  /** The host's window key ("main" or a pop-out key): where results go. */
  hostWindow: string;
  /** The label of the Use button ("Use as layer"); "" = the window only shows results. */
  useLabel: string;
}

/** Opens Photo Composer or Video Editor for a slide of a post. */
export interface PostSlideSeed {
  postId: string;
  slideId: string;
  /** The post's aspect ("4:5", "9:16", …): new projects start at it. */
  aspect: string;
  /** The slide's linked project ("" = make a new one and link it on first save). */
  projectId: string;
  /** Build a new project from the handoff's inputs (SPEC.md §B13.5); absent = open/create as usual. */
  build?: SlideBuild;
}

/** How Photo Composer / Video Editor build a new slide from several sources (the handoff's inputs). */
export type SlideBuild =
  | {
      kind: "collage";
      /** Source path used as the background ("" = a colour). */
      background: string;
      color: string;
      /** Cut out every other source (one background-removal job each). */
      cutouts: boolean;
      layout: "scatter" | "grid" | "stack" | "polaroids";
    }
  | {
      kind: "stitch";
      /** Song path ("" = none). */
      music: string;
      beatCut: boolean;
      order: "date-taken" | "as-given";
      transition: string;
    };

/** Timed text handed to the Visualizer from Lyric Video or Subtitles (SPEC.md §9.5). */
export interface ToolSeed {
  kind: "timed-text";
  from: "lyric-video" | "subtitles";
  lines: TimedLine[];
  look?: { font: string; textColor: string; highlightColor: string; karaoke: boolean; position: "center" | "lower" };
  overlay?: boolean;
}

interface UIState {
  view: ViewId;
  /** The view to go back to when the "setup" overlay closes. */
  returnView: ViewId;
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
  /** On a narrow window the sidebar is a rail unless opened for the session. */
  sidebarNarrowOpen: boolean;
  /** Collapses or expands the sidebar: the saved preference on wide windows, the session override on narrow ones. */
  toggleSidebar: () => void;
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
  // A tool window's view is its `view` parameter (never the main window's saved one).
  const fromQuery = new URLSearchParams(window.location.search).get("view");
  return fromQuery || saved.view || "downloader";
}

/** Only the main window writes the shared `toolbox.ui` entry; pop-outs and popups would clobber it. */
const persists = currentWindow().kind === "main";

const saved = load();

export const useUI = create<UIState>((set, get) => ({
  view: initialView(saved),
  returnView: "library",
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  comingSoonOpen: saved.comingSoonOpen ?? false,
  trayOpen: saved.trayOpen ?? false,
  trayHeight: saved.trayHeight ?? 300,
  paletteOpen: false,
  drop: null,
  handoff: null,
  expandedLogJobId: null,

  navigate: (view) =>
    set((s) => (view === "setup" && s.view !== "setup" ? { view, returnView: s.view } : { view })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  sidebarNarrowOpen: false,
  toggleSidebar: () => set((s) => (matchesNow(NARROW_QUERY) ? { sidebarNarrowOpen: !s.sidebarNarrowOpen } : { sidebarCollapsed: !s.sidebarCollapsed })),
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
  if (!persists) return;
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

// Dev builds only: a handle for automated UI checks (.dev QA scripts).
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __ui?: typeof useUI }).__ui = useUI;

/** Whether the sidebar shows as an icon rail (saved preference, or a narrow window). */
export function useSidebarCollapsed(): boolean {
  const pref = useUI((s) => s.sidebarCollapsed);
  const narrowOpen = useUI((s) => s.sidebarNarrowOpen);
  const narrow = useMediaQuery(NARROW_QUERY);
  return narrow ? !narrowOpen : pref;
}
