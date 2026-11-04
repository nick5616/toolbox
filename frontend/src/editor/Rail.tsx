/**
 * The left rail (Phase 10 SPEC §5.5): one icon click-in launcher per panel
 * the tool puts at the top level, with the panel's name under its icon. It
 * never scrolls: what doesn't fit in the height goes into a "⋯" item.
 */
import { useState } from "react";
import { MenuButton, useClickIn } from "@/components";
import { useElementSize } from "@/lib/useElementSize";
import { getEditorPanel } from "./panels";
import { PanelClickIn, panelDrawerId } from "./PanelClickIn";
import { useEditorProfile } from "./profileContext";
import { useProject } from "./store";
import styles from "./Rail.module.css";

/** The Video Editor's rail: Media, Text, Music, Project. Profiles replace it with `profile.rail`. */
export const DEFAULT_RAIL: readonly string[] = ["media", "text", "music", "project"];

const ITEM_PX = 44;
const PAD_PX = 16;

/** How many of `count` items show in `height` px (all when unknown); one slot is the "⋯" item when some must go. */
export function railFit(count: number, height: number): number {
  if (height <= 0) return count;
  const slots = Math.max(1, Math.floor((height - PAD_PX) / ITEM_PX));
  return slots >= count ? count : Math.max(0, slots - 1);
}

export function Rail() {
  const profile = useEditorProfile();
  const project = useProject();
  const { open } = useClickIn();
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const { height } = useElementSize(nav);
  const ids = (profile.rail ?? DEFAULT_RAIL).filter((id) => !!getEditorPanel(id));
  const n = railFit(ids.length, height);
  const rest = ids.slice(n);
  const item = (id: string, launcher = true) => (
    <div key={id} className={styles.item}>
      <PanelClickIn panel={id} variant="icon" badge={id === "media" ? (project?.sources.length ?? 0) : undefined} />
      {launcher && <span className={styles.caption}>{getEditorPanel(id)?.title}</span>}
    </div>
  );
  return (
    <nav className={styles.rail} aria-label="Panels" ref={setNav}>
      {ids.slice(0, n).map((id) => item(id))}
      {rest.length > 0 && (
        <>
          <div className={styles.item}>
            <MenuButton
              label="More panels"
              icon="ellipsis"
              variant="ghost"
              data-tip="The other panels of this tool"
              items={() => rest.map((id) => ({ id, label: getEditorPanel(id)?.title ?? id, icon: getEditorPanel(id)?.icon, tip: getEditorPanel(id)?.tip, onSelect: () => open(panelDrawerId(id)) }))}
            />
            <span className={styles.caption}>More</span>
          </div>
          {/* Their drawers stay mounted; the menu opens them. */}
          <span hidden>{rest.map((id) => item(id, false))}</span>
        </>
      )}
    </nav>
  );
}
