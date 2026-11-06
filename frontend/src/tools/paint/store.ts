/**
 * Paint+'s UI state (zustand): the current tool, brushes, colour, panels,
 * Lab selection, save state. The engine owns pixels, layers and history; this
 * owns everything the artist has "in hand". Module-level, one editor at a time.
 */
import { create } from "zustand";
import type { BrushPreset } from "@/paint/brushes/schema";
import type { LabParams, LabToolInfo } from "@/paint/lab/types";
import type { HistoryId, ToolState } from "@/paint/engine/types";
import { hexToHsv, hexToRGBA, hsvToHex, type Hsv } from "./color";
import { DEFAULT_GUIDES, type GuidesState } from "./engine-adapter";

export type ToolId = "brush" | "smudge" | "eraser" | "fill" | "eyedropper" | "transform" | "lasso" | "rect" | "ellipse" | "wand" | "lab" | "history" | "liquify" | "pencil";
export type BrushToolId = "brush" | "smudge" | "eraser";
export type PanelId = "brushes" | "brushstudio" | "color" | "layers" | "history" | "lab" | "guides";
export type DockMode = "auto" | "dock" | "pop";
export type SaveState = "saved" | "dirty" | "saving" | "error";

/** Window width from which panels dock as columns (SPEC §1.6). */
export const DOCK_FROM = 1600;
/** Below this window width the layout is compact (960 x 600 inside Toolbox). */
export const COMPACT_BELOW = 1100;

export const SIZE_MIN = 1;
export const SIZE_MAX = 400;

/** Slider position 0..1 ↔ brush size in px (quadratic, so small sizes get room). */
export const sizeFromFrac = (f: number): number => Math.round(SIZE_MIN + (SIZE_MAX - SIZE_MIN) * f * f);
export const fracFromSize = (px: number): number => Math.sqrt(Math.max(0, Math.min(1, (px - SIZE_MIN) / (SIZE_MAX - SIZE_MIN))));

export interface LabSeed {
  seed: number;
  locked: boolean;
}

export interface PaintUIState {
  tool: ToolId;
  /** The Lab tool in hand when tool === "lab". */
  labToolId: string;
  brushes: Record<BrushToolId, BrushPreset | null>;
  size: number;
  opacity: number;
  color: Hsv;
  secondary: Hsv;
  recentColors: string[];
  /** Open panels, oldest first. Popover layouts show only the last. */
  panels: PanelId[];
  dockMode: DockMode;
  uiHidden: boolean;
  /** `[` / `]` held: the brush HUD shows. */
  hud: boolean;
  labRecent: string[];
  labParams: Record<string, LabParams>;
  labSeeds: Record<string, LabSeed>;
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  historySource: HistoryId | null;
  guides: GuidesState;
  settings: { simulatePressure: boolean; palmRejection: boolean };
  saveState: SaveState;
  saveError: string;
  lastSavedAt: number;

  setTool(t: ToolId): void;
  setLabTool(info: LabToolInfo): void;
  setBrush(kind: BrushToolId, b: BrushPreset): void;
  setSize(px: number): void;
  setOpacity(o: number): void;
  setColor(c: Hsv): void;
  setColorHex(hex: string): void;
  swapColors(): void;
  commitColor(): void;
  openPanel(p: PanelId): void;
  closePanel(p: PanelId): void;
  togglePanel(p: PanelId): void;
  setDockMode(m: DockMode): void;
  setUIHidden(v: boolean): void;
  setHud(v: boolean): void;
  setLabParam(toolId: string, id: string, v: number | string | boolean): void;
  setLabParams(toolId: string, p: LabParams): void;
  setLabSeed(toolId: string, seed: number): void;
  rollSeed(toolId: string): number;
  toggleSeedLock(toolId: string): void;
  setWand(w: Partial<PaintUIState["wand"]>): void;
  setHistorySource(id: HistoryId | null): void;
  setGuides(g: Partial<GuidesState>): void;
  setSettings(s: Partial<PaintUIState["settings"]>): void;
  setSave(state: SaveState, error?: string): void;
  reset(): void;
}

const RECENT = 12;
const LAB_RECENT = 6;

const INITIAL = {
  tool: "brush" as ToolId,
  labToolId: "",
  brushes: { brush: null, smudge: null, eraser: null } as Record<BrushToolId, BrushPreset | null>,
  size: 24,
  opacity: 1,
  color: { h: 220, s: 0.55, v: 0.35 } as Hsv,
  secondary: { h: 0, s: 0, v: 1 } as Hsv,
  recentColors: [] as string[],
  panels: [] as PanelId[],
  dockMode: "auto" as DockMode,
  uiHidden: false,
  hud: false,
  labRecent: [] as string[],
  labParams: {} as Record<string, LabParams>,
  labSeeds: {} as Record<string, LabSeed>,
  wand: { tolerance: 24, contiguous: true, sampleAll: false },
  historySource: null as HistoryId | null,
  guides: DEFAULT_GUIDES,
  settings: { simulatePressure: true, palmRejection: true },
  saveState: "saved" as SaveState,
  saveError: "",
  lastSavedAt: 0,
};

/** Seeds come from a counter, never the clock, so a replay is reproducible. */
let seedCounter = 1;
const nextSeed = (): number => (seedCounter = (seedCounter * 1103515245 + 12345) & 0x7fffffff) || 1;

export const usePaintUI = create<PaintUIState>((set, get) => ({
  ...INITIAL,

  setTool: (tool) => set({ tool }),
  setLabTool: (info) =>
    set((s) => ({
      tool: "lab",
      labToolId: info.id,
      labRecent: [info.id, ...s.labRecent.filter((x) => x !== info.id)].slice(0, LAB_RECENT),
      labParams: s.labParams[info.id] ? s.labParams : { ...s.labParams, [info.id]: defaultParams(info) },
      labSeeds: s.labSeeds[info.id] ? s.labSeeds : { ...s.labSeeds, [info.id]: { seed: nextSeed(), locked: false } },
    })),
  setBrush: (kind, b) => set((s) => ({ brushes: { ...s.brushes, [kind]: b }, size: b.size, opacity: b.opacity, tool: kind })),
  setSize: (px) => set({ size: Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(px))) }),
  setOpacity: (o) => set({ opacity: Math.max(0, Math.min(1, o)) }),
  setColor: (color) => set({ color }),
  setColorHex: (hex) => set({ color: hexToHsv(hex) }),
  swapColors: () => set((s) => ({ color: s.secondary, secondary: s.color })),
  commitColor: () =>
    set((s) => {
      const hex = hsvToHex(s.color);
      return { recentColors: [hex, ...s.recentColors.filter((c) => c !== hex)].slice(0, RECENT) };
    }),
  openPanel: (p) => set((s) => ({ panels: [...s.panels.filter((x) => x !== p), p] })),
  closePanel: (p) => set((s) => ({ panels: s.panels.filter((x) => x !== p) })),
  togglePanel: (p) => set((s) => ({ panels: s.panels.includes(p) ? s.panels.filter((x) => x !== p) : [...s.panels, p] })),
  setDockMode: (dockMode) => set({ dockMode }),
  setUIHidden: (uiHidden) => set({ uiHidden }),
  setHud: (hud) => set({ hud }),
  setLabParam: (toolId, id, v) => set((s) => ({ labParams: { ...s.labParams, [toolId]: { ...(s.labParams[toolId] ?? {}), [id]: v } } })),
  setLabParams: (toolId, p) => set((s) => ({ labParams: { ...s.labParams, [toolId]: p } })),
  setLabSeed: (toolId, seed) => set((s) => ({ labSeeds: { ...s.labSeeds, [toolId]: { seed, locked: s.labSeeds[toolId]?.locked ?? false } } })),
  rollSeed: (toolId) => {
    const seed = nextSeed();
    set((s) => ({ labSeeds: { ...s.labSeeds, [toolId]: { seed, locked: s.labSeeds[toolId]?.locked ?? false } } }));
    return seed;
  },
  toggleSeedLock: (toolId) => set((s) => ({ labSeeds: { ...s.labSeeds, [toolId]: { seed: s.labSeeds[toolId]?.seed ?? nextSeed(), locked: !s.labSeeds[toolId]?.locked } } })),
  setWand: (w) => set((s) => ({ wand: { ...s.wand, ...w } })),
  setHistorySource: (historySource) => set({ historySource }),
  setGuides: (g) => set((s) => ({ guides: { ...s.guides, ...g } })),
  setSettings: (st) => set((s) => ({ settings: { ...s.settings, ...st } })),
  setSave: (saveState, saveError = "") => set({ saveState, saveError, lastSavedAt: saveState === "saved" ? get().lastSavedAt + 1 : get().lastSavedAt }),
  reset: () => set({ ...INITIAL, panels: [], brushes: { brush: null, smudge: null, eraser: null } }),
}));

export function defaultParams(info: LabToolInfo): LabParams {
  return Object.fromEntries(info.params.map((p) => [p.id, p.default]));
}

/** The seed a stroke should use; an unlocked seed rolls every stroke. */
export function strokeSeed(toolId: string): number {
  const st = usePaintUI.getState();
  const cur = st.labSeeds[toolId];
  if (cur?.locked) return cur.seed;
  return st.rollSeed(toolId);
}

/** The ToolState for the engine from what the artist has in hand (null = not a stroke tool, or no brush yet). */
export function buildToolState(s: PaintUIState, seed: number, perception: boolean): ToolState | null {
  const withSize = (b: BrushPreset): BrushPreset => ({ ...b, size: s.size, opacity: s.opacity });
  const color = hexToRGBA(hsvToHex(s.color));
  const secondary = hexToRGBA(hsvToHex(s.secondary));
  switch (s.tool) {
    case "brush":
      return s.brushes.brush ? { kind: "brush", brush: withSize(s.brushes.brush), color, secondary, seed } : null;
    case "smudge":
      return s.brushes.smudge ? { kind: "smudge", brush: withSize(s.brushes.smudge), seed } : null;
    case "eraser":
      return s.brushes.eraser ? { kind: "eraser", brush: withSize(s.brushes.eraser), seed } : null;
    case "pencil":
      // Adjustment Pencil: the stroke only records a mask (nothing is drawn).
      return s.brushes.brush ? { kind: "mask", brush: withSize(s.brushes.brush), seed } : null;
    case "history":
      return s.brushes.brush && s.historySource !== null ? { kind: "history", brush: withSize(s.brushes.brush), source: s.historySource, seed } : null;
    case "lab": {
      const base = s.brushes.brush;
      if (!base) return null;
      const brush = withSize(base);
      return perception ? { kind: "mask", brush, seed } : { kind: "lab", toolId: s.labToolId, brush, color, params: s.labParams[s.labToolId] ?? {}, seed };
    }
    default:
      return null;
  }
}
