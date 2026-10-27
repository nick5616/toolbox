import { useCallback, type Ref } from "react";

/** Joins truthy class names. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Merges several refs (callback or object) into one callback ref. */
export function useMergedRef<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(
    (node: T | null) => {
      for (const ref of refs) {
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as { current: T | null }).current = node;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    refs,
  );
}
