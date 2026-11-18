import { useCallback } from "react";
import { pickFromLibrary } from "@/blocks/library-picker";
import { toast } from "@/components";
import { FilesService, type FileInfo } from "@/lib/api";
import { useEmbed, useToolHandoff } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { useModules } from "@/state/modules";
import { acceptsPath } from "./accepts";
import { fileInputsKey, useFileInputsStore } from "./fileInputsStore";

const NONE: FileInfo[] = [];

export interface FileInputs {
  /** Current inputs (deduped, in add order). */
  files: FileInfo[];
  /** Adds paths: stats them, drops unsupported/duplicate/over-limit ones (toast). */
  add: (paths: string[]) => Promise<void>;
  remove: (path: string) => void;
  clear: () => void;
  /** Opens the native picker for this module and adds the result. */
  pick: () => Promise<void>;
  /** Opens the Library picker (files Toolbox made that this module accepts) and adds the result. */
  pickLibrary: () => Promise<void>;
}

/** Manages a file tool's inputs, including handoffs (drop/paste/Send to). */
export function useFileInputs(moduleId: string): FileInputs {
  const embed = useEmbed();
  const key = fileInputsKey(moduleId, embed ? { host: embed.host, placement: embed.placement, token: embed.handoff.embed?.token } : null);
  const files = useFileInputsStore((s) => s.lists[key]) ?? NONE;

  const commit = useCallback((next: FileInfo[]) => useFileInputsStore.getState().set(key, next), [key]);
  const latest = useCallback(() => useFileInputsStore.getState().lists[key] ?? NONE, [key]);

  const add = useCallback(
    async (paths: string[]) => {
      const mod = useModules.getState().byId[moduleId];
      const exts = mod?.accepts.extensions ?? [];
      const maxInputs = mod?.maxInputs ?? 0;

      const supported = paths.filter((p) => acceptsPath(exts, p));
      const unsupported = paths.length - supported.length;
      const have = new Set(latest().map((f) => f.path));
      const fresh: string[] = [];
      for (const p of supported) {
        if (!have.has(p)) {
          have.add(p);
          fresh.push(p);
        }
      }
      if (unsupported > 0) {
        toast({ title: `Skipped ${unsupported} unsupported ${unsupported === 1 ? "file" : "files"}`, tone: "warn" });
      }
      if (fresh.length === 0) return;

      let infos: FileInfo[];
      try {
        infos = (await FilesService.Stat(fresh)) ?? [];
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
        return;
      }
      // Re-check against the latest list: another add may have landed meanwhile.
      const current = latest();
      const seen = new Set(current.map((f) => f.path));
      let accepted = infos.filter((i) => i.exists && !i.isDir && !seen.has(i.path));
      if (maxInputs > 0 && current.length + accepted.length > maxInputs) {
        accepted = accepted.slice(0, Math.max(0, maxInputs - current.length));
        toast({ title: `At most ${maxInputs} files at a time`, tone: "warn" });
      }
      if (accepted.length > 0) commit([...current, ...accepted]);
    },
    [moduleId, commit, latest],
  );

  const remove = useCallback((path: string) => commit(latest().filter((f) => f.path !== path)), [commit, latest]);
  const clear = useCallback(() => commit([]), [commit]);

  const pick = useCallback(async () => {
    try {
      const paths = (await FilesService.Pick(moduleId)) ?? [];
      if (paths.length > 0) await add(paths);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [moduleId, add]);

  const pickLibrary = useCallback(async () => {
    const mod = useModules.getState().byId[moduleId];
    const paths = await pickFromLibrary({
      exts: mod?.accepts.extensions ?? null,
      multiple: (mod?.maxInputs ?? 0) !== 1,
      have: latest().map((f) => f.path),
    });
    if (paths.length > 0) await add(paths);
  }, [moduleId, add, latest]);

  // Dropped/pasted/Send to files; embedded, the embed's own handoff.
  useToolHandoff(moduleId, (h) => void add(h.inputs));

  return { files, add, remove, clear, pick, pickLibrary };
}
