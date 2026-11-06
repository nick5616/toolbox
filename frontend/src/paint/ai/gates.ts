// Gates for the perception tools: which are ready and, when not, why and
// what to install. P5 shows `summarizeGates()` in the one gate banner and sets
// aria-disabled (with `reason`) on each blocked tool.

import { useCallback, useEffect, useMemo, useState } from "react";
import { PaintService, type PaintAIModelInfo } from "@/lib/api";
import { on } from "@/lib/events";
import { PERCEPTION_TOOLS } from "./tools";

export interface ToolGate {
  ready: boolean;
  /** "" when ready. */
  reason: string;
  /** Pack component IDs still missing. */
  needs: string[];
  /** Bytes to download, 0 when present. */
  modelSize: number;
}

export type GateMap = Record<string, ToolGate>;

const READY: ToolGate = { ready: true, reason: "", needs: [], modelSize: 0 };
const UNKNOWN: ToolGate = { ready: false, reason: "Checking the AI engine…", needs: [], modelSize: 0 };

/** Maps each perception tool to the status of its engine operation. `null` status = not loaded yet. */
export function mapGates(status: PaintAIModelInfo[] | null | undefined): GateMap {
  const out: GateMap = {};
  for (const t of PERCEPTION_TOOLS) {
    if (!status) {
      out[t.id] = UNKNOWN;
      continue;
    }
    const info = status.find((s) => s.tool === t.op);
    if (!info) {
      out[t.id] = { ready: false, reason: "This tool isn't available in this build", needs: [], modelSize: 0 };
    } else if (info.ready) {
      out[t.id] = READY;
    } else {
      out[t.id] = { ready: false, reason: info.reason || "A model is missing", needs: info.needs ?? [], modelSize: info.modelSize };
    }
  }
  return out;
}

export interface GateSummary {
  /** Number of blocked tools. */
  blocked: number;
  /** Distinct missing components across all tools. */
  needs: string[];
  /** Total download bytes (per operation, counted once). */
  bytes: number;
  /** Distinct reasons. */
  reasons: string[];
}

export function summarizeGates(gates: GateMap): GateSummary {
  const needs = new Set<string>();
  const reasons = new Set<string>();
  let blocked = 0;
  let bytes = 0;
  const seenOps = new Set<string>();
  for (const t of PERCEPTION_TOOLS) {
    const g = gates[t.id];
    if (!g || g.ready) continue;
    blocked++;
    g.needs.forEach((n) => needs.add(n));
    if (g.reason) reasons.add(g.reason);
    if (!seenOps.has(t.op)) {
      seenOps.add(t.op);
      bytes += g.modelSize;
    }
  }
  return { blocked, needs: [...needs], bytes, reasons: [...reasons] };
}

export interface AIStatusState {
  loaded: boolean;
  gates: GateMap;
  summary: GateSummary;
  refresh(): Promise<void>;
}

/** Polls PaintService.AIStatus on mount and whenever deps or packs change. */
export function useAIStatus(): AIStatusState {
  const [status, setStatus] = useState<PaintAIModelInfo[] | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus((await PaintService.AIStatus()) ?? []);
    } catch {
      // keep the last known state; the next event refreshes it
    }
  }, []);
  useEffect(() => {
    void refresh();
    const offs = [on("deps:changed", () => void refresh()), on("packs:changed", () => void refresh())];
    return () => offs.forEach((off) => off());
  }, [refresh]);
  const gates = useMemo(() => mapGates(status), [status]);
  const summary = useMemo(() => summarizeGates(gates), [gates]);
  return { loaded: status !== null, gates, summary, refresh };
}

let warmed = false;

/** Starts the engine and loads the fast inpaint model once per page (no download). Safe to call on every mount. */
export function warmOnce(): void {
  if (warmed) return;
  warmed = true;
  void PaintService.Warm().catch(() => {
    warmed = false; // allow a later retry, e.g. after the engine gets installed
  });
}

/** Test hook. */
export function resetWarm(): void {
  warmed = false;
}
