/** What Paint+ remembers between sessions (SettingsService.ModuleState("paint")). */
import { useEffect } from "react";
import { SettingsService } from "@/lib/api";
import type { BrushPreset } from "@/paint/brushes/schema";
import { hexToHsv, hsvToHex, isHex } from "./color";
import { usePaintUI, type DockMode } from "./store";

export const MODULE_ID = "paint";

interface Saved {
  color?: string;
  secondary?: string;
  recent?: string[];
  size?: number;
  opacity?: number;
  dockMode?: DockMode;
  brushIds?: { brush?: string; smudge?: string; eraser?: string };
  labRecent?: string[];
  settings?: { simulatePressure?: boolean; palmRejection?: boolean };
}

const DOCKS: DockMode[] = ["auto", "dock", "pop"];

/** Applies saved prefs to the store and picks the starting brushes from `lib`. Never throws. */
export async function loadPrefs(lib: BrushPreset[]): Promise<void> {
  let saved: Saved = {};
  try {
    const raw = await SettingsService.ModuleState(MODULE_ID);
    if (raw) saved = JSON.parse(raw) as Saved;
  } catch {
    /* defaults */
  }
  const s = usePaintUI.getState();
  const pick = (id: string | undefined, fallback: (b: BrushPreset) => boolean): BrushPreset | null => lib.find((b) => b.id === id) ?? lib.find(fallback) ?? lib[0] ?? null;
  const brush = pick(saved.brushIds?.brush, (b) => b.blend === "normal");
  const smudge = pick(saved.brushIds?.smudge, (b) => /smudge|blend/i.test(b.name));
  const eraser = pick(saved.brushIds?.eraser, (b) => b.blend === "erase");
  usePaintUI.setState({
    brushes: { brush, smudge, eraser },
    ...(saved.color && isHex(saved.color) ? { color: hexToHsv(saved.color) } : {}),
    ...(saved.secondary && isHex(saved.secondary) ? { secondary: hexToHsv(saved.secondary) } : {}),
    recentColors: (saved.recent ?? []).filter(isHex).slice(0, 12),
    ...(typeof saved.size === "number" ? { size: saved.size } : brush ? { size: brush.size } : {}),
    ...(typeof saved.opacity === "number" ? { opacity: saved.opacity } : {}),
    ...(saved.dockMode && DOCKS.includes(saved.dockMode) ? { dockMode: saved.dockMode } : {}),
    labRecent: (saved.labRecent ?? []).slice(0, 6),
    settings: { ...s.settings, ...saved.settings },
  });
}

/** Saves prefs 600 ms after the last change to what's remembered. */
export function usePrefsSaver(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = usePaintUI.subscribe((s, prev) => {
      const changed = s.color !== prev.color || s.secondary !== prev.secondary || s.recentColors !== prev.recentColors || s.size !== prev.size || s.opacity !== prev.opacity || s.dockMode !== prev.dockMode || s.brushes !== prev.brushes || s.labRecent !== prev.labRecent || s.settings !== prev.settings;
      if (!changed) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const st = usePaintUI.getState();
        const out: Saved = {
          color: hsvToHex(st.color),
          secondary: hsvToHex(st.secondary),
          recent: st.recentColors,
          size: st.size,
          opacity: st.opacity,
          dockMode: st.dockMode,
          brushIds: { ...(st.brushes.brush ? { brush: st.brushes.brush.id } : {}), ...(st.brushes.smudge ? { smudge: st.brushes.smudge.id } : {}), ...(st.brushes.eraser ? { eraser: st.brushes.eraser.id } : {}) },
          labRecent: st.labRecent,
          settings: st.settings,
        };
        SettingsService.SetModuleState(MODULE_ID, JSON.stringify(out)).catch(() => undefined);
      }, 600);
    });
    return () => {
      clearTimeout(t);
      unsub();
    };
  }, [enabled]);
}
