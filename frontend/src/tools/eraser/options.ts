import { EraserModel, type EraserOptions } from "@/lib/api";
import { clampBrush } from "./mask";

/** Remembered tool settings (SettingsService.SetModuleState). */
export interface EraserSettings {
  model: EraserOptions["model"];
  /** Brush diameter in screen px. */
  brush: number;
}

export const DEFAULT_SETTINGS: EraserSettings = { model: EraserModel.ModelBest, brush: 40 };

/** `sanitize` for useModuleOptions. */
export function sanitizeSettings(raw: unknown, defaults: EraserSettings): EraserSettings {
  const out = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (r.model === EraserModel.ModelBest || r.model === EraserModel.ModelFast) out.model = r.model;
  if (typeof r.brush === "number" && Number.isFinite(r.brush)) out.brush = clampBrush(r.brush);
  return out;
}

/** "Best · 208 MB · Fast · 28 MB" from the engine's model list, with the SPEC sizes as fallback. */
export function modelHint(models: Array<{ id: string; label: string; downloadBytes: number }>): string {
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
  const by = (id: string, fallbackLabel: string, fallbackMB: number) => {
    const m = models.find((x) => x.id === id);
    return `${m?.label ?? fallbackLabel} · ${m && m.downloadBytes > 0 ? mb(m.downloadBytes) : `${fallbackMB} MB`}`;
  };
  return `${by("best", "Best", 208)} · ${by("fast", "Fast", 28)}`;
}

const RASTER_EXT = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"];
const THUMB_EXT = [".tif", ".tiff"];

/** True for formats that can be painted on (HEIC has no decoder outside the engine). */
export function canPaintOn(path: string): boolean {
  return RASTER_EXT.some((e) => path.toLowerCase().endsWith(e)) || needsThumb(path);
}

/** TIFF can't be shown by the webview; Go decodes it into a bounded preview (≤ 1600 px). */
export function needsThumb(path: string): boolean {
  return THUMB_EXT.some((e) => path.toLowerCase().endsWith(e));
}
