import { useEffect, useState } from "react";
import { ExifService, type MetadataView } from "@/lib/api";
import { toAppError } from "@/lib/errors";

export type MetaState = { status: "loading" } | { status: "ok"; view: MetadataView } | { status: "error"; message: string };

/** Reads metadata for each path once (cached per path while it stays an input). */
export function useMetadata(paths: readonly string[]): Record<string, MetaState> {
  const [byPath, setByPath] = useState<Record<string, MetaState>>({});
  const key = paths.join("\u0000");

  useEffect(() => {
    const wanted = key ? key.split("\u0000") : [];
    let cancelled = false;
    setByPath((prev) => {
      const next: Record<string, MetaState> = {};
      for (const p of wanted) next[p] = prev[p] ?? { status: "loading" };
      return next;
    });
    for (const p of wanted) {
      ExifService.Read(p)
        .then((view) => {
          if (!cancelled) setByPath((prev) => (p in prev ? { ...prev, [p]: { status: "ok", view } } : prev));
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setByPath((prev) => (p in prev ? { ...prev, [p]: { status: "error", message: toAppError(e).message } } : prev));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return byPath;
}
