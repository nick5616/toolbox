/** What the inspector shows. */
export type Selection = { kind: "clip"; id: string } | { kind: "title"; id: string } | { kind: "music" } | null;

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "music" || (a as { id: string }).id === (b as { id: string }).id;
}
