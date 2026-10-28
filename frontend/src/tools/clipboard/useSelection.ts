import { useCallback, useEffect, useState } from "react";
import type { ClipItem } from "@/lib/api";

/** Selection by id (survives re-sorting); defaults to the first item. */
export function useSelection(items: readonly ClipItem[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const found = items.findIndex((i) => i.id === selectedId);
  const index = found >= 0 ? found : items.length > 0 ? 0 : -1;
  const selected = index >= 0 ? (items[index] ?? null) : null;

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = Math.min(items.length - 1, Math.max(0, index + delta));
      setSelectedId(items[next]?.id ?? null);
    },
    [items, index],
  );

  /** Selection to land on after `id` is removed: the next row, else the previous. */
  const neighbourOf = useCallback(
    (id: string): string | null => {
      const i = items.findIndex((x) => x.id === id);
      return items[i + 1]?.id ?? items[i - 1]?.id ?? null;
    },
    [items],
  );

  const reset = useCallback(() => setSelectedId(null), []);

  // Keep the selected row visible.
  useEffect(() => {
    if (!selected) return;
    document.getElementById(`clip-${selected.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  return { selected, index, selectedId: selected?.id ?? null, setSelectedId, move, neighbourOf, reset };
}
