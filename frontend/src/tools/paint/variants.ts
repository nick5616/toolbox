/**
 * Saved Lab device variants. Stored through the brush storage as a brush-set
 * entry in the user set "lab-devices": `PaintService.SaveBrush("lab-devices",
 * json)` where json = `{version, id: "<toolId>.<slug>", name, set, toolId,
 * params, seed}`. Go keeps brush JSON opaque, so the extra fields round-trip;
 * brushes of the set whose id starts with `<toolId>.` are that tool's variants.
 */
import { useCallback, useEffect, useState } from "react";
import { PaintService } from "@/lib/api";
import type { LabParams } from "@/paint/lab/types";
import type { DeviceVariant } from "./deviceLogic";

export const VARIANT_SET = "lab-devices";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "variant";

export async function listVariants(toolId: string): Promise<Array<{ id: string; name: string }>> {
  const sets = (await PaintService.BrushSets()) ?? [];
  const set = sets.find((s) => s.id === VARIANT_SET);
  return (set?.brushes ?? []).filter((b) => b.id.startsWith(`${toolId}.`)).map((b) => ({ id: b.id, name: b.name }));
}

export async function saveVariant(toolId: string, name: string, params: LabParams, seed: number): Promise<void> {
  const v: DeviceVariant & { version: number } = { version: 1, id: `${toolId}.${slug(name)}`, name, set: VARIANT_SET, toolId, params, seed };
  await PaintService.SaveBrush(VARIANT_SET, JSON.stringify(v));
}

export async function loadVariant(id: string): Promise<{ params: LabParams; seed: number } | null> {
  const raw = await PaintService.Brush(VARIANT_SET, id);
  try {
    const v = JSON.parse(raw) as Partial<DeviceVariant>;
    if (!v.params || typeof v.params !== "object") return null;
    return { params: v.params, seed: typeof v.seed === "number" ? v.seed : 1 };
  } catch {
    return null;
  }
}

/** A tool's saved variants, reloaded after a save. Failures leave the list empty (the set may not exist yet). */
export function useVariants(toolId: string): { variants: Array<{ id: string; name: string }>; refresh(): void } {
  const [variants, setVariants] = useState<Array<{ id: string; name: string }>>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    let off = false;
    listVariants(toolId).then(
      (v) => !off && setVariants(v),
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [toolId, n]);
  return { variants, refresh: useCallback(() => setN((v) => v + 1), []) };
}
