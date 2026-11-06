/** The song's name in the header (Phase 10 SPEC §5.5): a chip that opens the Song panel. */
import { Icon, useClickIn } from "@/components";
import { panelDrawerId } from "@/editor/PanelClickIn";
import { useProject } from "@/editor/store";
import styles from "./SongChip.module.css";

/** The file name of a path with either kind of separator. */
export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export function SongChip({ disabled }: { disabled: boolean }) {
  const project = useProject();
  const { open } = useClickIn();
  if (!project) return null;
  const path = project.song?.path;
  const name = path ? fileName(path) : undefined;
  return (
    <button type="button" className={styles.chip} disabled={disabled && !project.song} data-tip={path ? `Song: ${path}. Click for its range, analysis, volume and fades` : "Choose a song"} aria-label={`Song: ${name ?? "none"}`} onClick={() => open(panelDrawerId("song"))}>
      <Icon name="music" size={14} />
      <span className={styles.name}>{name ?? "No song"}</span>
    </button>
  );
}
