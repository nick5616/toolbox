/** Handoffs and page drops for Edit Studio (§14.13). Wave 0 stub (owned by WP-ES2); the props are frozen. */
/**
 * Takes `useUI().takeHandoff(moduleId)` handoffs and files dropped on the page:
 * an audio file starts a new edit (or offers to replace the song); videos and
 * photos go to the open edit's Sources. `open` opens a project by ID.
 */
export function useEditHandoff(moduleId: string, open: (id: string) => void): void {
  void moduleId;
  void open;
}
