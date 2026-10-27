import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components";
import { FilesService, type FileInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { acceptsPath } from "./accepts";

export interface FileInputs {
  /** Current inputs (deduped, in add order). */
  files: FileInfo[];
  /** Adds paths: stats them, drops unsupported/duplicate/over-limit ones (toast). */
  add: (paths: string[]) => Promise<void>;
  remove: (path: string) => void;
  clear: () => void;
  /** Opens the native picker for this module and adds the result. */
  pick: () => Promise<void>;
}

/** Manages a file tool's inputs, including handoffs (drop/paste/Send to). */
export function useFileInputs(moduleId: string): FileInputs {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const ref = useRef<FileInfo[]>([]);

  const commit = useCallback((next: FileInfo[]) => {
    ref.current = next;
    setFiles(next);
  }, []);

  const add = useCallback(
    async (paths: string[]) => {
      const mod = useModules.getState().byId[moduleId];
      const exts = mod?.accepts.extensions ?? [];
      const maxInputs = mod?.maxInputs ?? 0;

      const supported = paths.filter((p) => acceptsPath(exts, p));
      const unsupported = paths.length - supported.length;
      const have = new Set(ref.current.map((f) => f.path));
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
      const current = ref.current;
      const seen = new Set(current.map((f) => f.path));
      let accepted = infos.filter((i) => i.exists && !i.isDir && !seen.has(i.path));
      if (maxInputs > 0 && current.length + accepted.length > maxInputs) {
        accepted = accepted.slice(0, Math.max(0, maxInputs - current.length));
        toast({ title: `At most ${maxInputs} files at a time`, tone: "warn" });
      }
      if (accepted.length > 0) commit([...current, ...accepted]);
    },
    [moduleId, commit],
  );

  const remove = useCallback((path: string) => commit(ref.current.filter((f) => f.path !== path)), [commit]);
  const clear = useCallback(() => commit([]), [commit]);

  const pick = useCallback(async () => {
    try {
      const paths = (await FilesService.Pick(moduleId)) ?? [];
      if (paths.length > 0) await add(paths);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  }, [moduleId, add]);

  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (handoff?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    if (h) void add(h.inputs);
  }, [handoff, moduleId, add]);

  return { files, add, remove, clear, pick };
}
