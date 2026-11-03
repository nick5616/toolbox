/**
 * The Sources panel's selected paths, isolated here so the dialog depends on a
 * single import. WP-ES2 is building `useSelectedSources()` in `../sources/`; until
 * it is merged this returns nothing (the dialog then offers "All sources" only).
 * Merge step: replace the body with `export { useSelectedSources } from "../sources/<file>"`.
 */
const NONE: readonly string[] = [];

export function useSelectedSources(): readonly string[] {
  return NONE;
}
