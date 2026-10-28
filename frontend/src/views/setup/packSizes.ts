import {
  PackComponentKind,
  PackComponentState,
  PackState,
  type PackComponentStatus,
  type PackStatus,
  type PackUnlock,
} from "@/lib/api";

/** A pack with Go's nullable slices normalised to arrays. */
export type PackView = Omit<PackStatus, "components" | "unlocks"> & {
  components: PackComponentStatus[];
  unlocks: PackUnlock[];
};

export function normalizePack(p: PackStatus): PackView {
  return { ...p, components: p.components ?? [], unlocks: p.unlocks ?? [] };
}

/** How a component row is accounted for in the current selection. */
export type ComponentCostKind = "counted" | "with" | "installed" | "system" | "unsupported";

export interface ComponentCost {
  kind: ComponentCostKind;
  download: number;
  disk: number;
  /** Name of the selected pack that pays for a shared component (kind "with"). */
  withPack?: string;
}

export interface PackSize {
  download: number;
  disk: number;
  components: Record<string, ComponentCost>;
}

export interface PackSizes {
  byPack: Record<string, PackSize>;
  /** Sum over the selected packs only (each shared component once). */
  totalDownload: number;
  totalDisk: number;
}

/** Packs that can be ticked on the setup screen. */
export function isSelectable(p: PackView): boolean {
  return p.state === PackState.PackMissing || p.state === PackState.PackPartial || p.state === PackState.PackOutdated;
}

function isPresent(c: PackComponentStatus): boolean {
  return c.state === PackComponentState.ComponentInstalled || c.state === PackComponentState.ComponentSystem;
}

/**
 * Sizes for the current selection (SPEC 7.1). `packs` is in catalog order. A
 * shared component is paid for by the first selected pack (in catalog order)
 * that contains it; every other pack lists it as "with <pack>". Installed and
 * system components cost 0. Unselected packs show what they would add now.
 */
export function packSizes(packs: readonly PackView[], selected: Iterable<string>): PackSizes {
  const sel = new Set(selected);
  const owner = new Map<string, PackView>();
  for (const p of packs) {
    if (!sel.has(p.id)) continue;
    for (const c of p.components) if (!owner.has(c.id) && !isPresent(c)) owner.set(c.id, p);
  }

  const byPack: Record<string, PackSize> = {};
  let totalDownload = 0;
  let totalDisk = 0;
  for (const p of packs) {
    const size: PackSize = { download: 0, disk: 0, components: {} };
    for (const c of p.components) {
      let cost: ComponentCost;
      if (c.state === PackComponentState.ComponentUnsupported) {
        cost = { kind: "unsupported", download: 0, disk: 0 };
      } else if (isPresent(c)) {
        cost = { kind: c.state === PackComponentState.ComponentSystem ? "system" : "installed", download: 0, disk: 0 };
      } else {
        const o = owner.get(c.id);
        if (o && o.id !== p.id) cost = { kind: "with", download: 0, disk: 0, withPack: o.name };
        else cost = { kind: "counted", download: c.downloadBytes, disk: c.diskBytes };
      }
      size.components[c.id] = cost;
      size.download += cost.download;
      size.disk += cost.disk;
    }
    byPack[p.id] = size;
    if (sel.has(p.id)) {
      totalDownload += size.download;
      totalDisk += size.disk;
    }
  }
  return { byPack, totalDownload, totalDisk };
}

/** Decimal sizes as the catalog states them: "311 MB", "1.1 GB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1e9) {
    const gb = bytes / 1e9;
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Packs selected when the setup screen first shows. */
export function initialSelection(packs: readonly PackView[]): string[] {
  const updates = packs.filter((p) => p.state === PackState.PackOutdated).map((p) => p.id);
  if (updates.length > 0) return updates;
  const fresh = packs.every((p) => p.state !== PackState.PackInstalled && p.state !== PackState.PackPartial);
  const media = packs.find((p) => p.id === "media");
  return fresh && media && isSelectable(media) ? [media.id] : [];
}

/** Dep IDs (descriptor `requires`) to the catalog component that provides them. */
const DEP_TO_COMPONENT: Record<string, string> = {
  "audio-engine": "engine",
  upscayl: "upscaler",
  "llama-runtime": "chat-engine",
  ffprobe: "ffmpeg",
};

export interface ModuleNeeds {
  /** The pack that unlocks the module, if any. */
  pack: PackView | undefined;
  /** Missing components the module itself needs. */
  download: number;
  disk: number;
}

/**
 * What `InstallFor(moduleId)` would fetch: the missing components of the
 * module's pack that match its `requires`, plus the pack's missing models.
 * (The bound PackUnlock doesn't list components, so this is an estimate.)
 */
export function moduleNeeds(packs: readonly PackView[], moduleId: string, requires: readonly string[]): ModuleNeeds {
  const pack = packs.find((p) => p.unlocks.some((u) => u.moduleId === moduleId));
  if (!pack) return { pack, download: 0, disk: 0 };
  const wanted = new Set(requires.map((r) => DEP_TO_COMPONENT[r] ?? r));
  let download = 0;
  let disk = 0;
  for (const c of pack.components) {
    if (isPresent(c) || c.state === PackComponentState.ComponentUnsupported) continue;
    if (wanted.has(c.id) || c.kind === PackComponentKind.ComponentModel) {
      download += c.downloadBytes;
      disk += c.diskBytes;
    }
  }
  return { pack, download, disk };
}
