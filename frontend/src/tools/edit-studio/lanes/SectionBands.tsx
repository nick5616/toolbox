/**
 * Section bands across lanes and tracks (§14.4), positioned with the store's
 * pps and scrollMs. The shell gives the container a full-size absolute box with
 * pointer-events: none; only the label chips take clicks.
 */
import { useEffect, useMemo, useState } from "react";
import { MenuButton } from "@/components";
import { laneSettings } from "@/viz/edit/defaults";
import { MAX_SECTION_LABEL, renameSection } from "./laneLogic";
import { msToX } from "../geometry";
import { useSectionStyle } from "../sectionstyle/useSectionStyle";
import { useEditStudio, useMarkers, useProject } from "../store";
import styles from "./SectionBands.module.css";

export interface SectionBandsProps {
  className?: string;
}

export function SectionBands({ className }: SectionBandsProps) {
  const project = useProject();
  const markers = useMarkers();
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const selection = useEditStudio((s) => s.selection);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  useEffect(() => {
    if (!host) return;
    setWidth(host.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);

  const sections = useMemo(() => markers.filter((m) => m.lane === "section" && m.endMs !== undefined), [markers]);
  const shown = !!project && laneSettings(project.markers, "section").visible;
  if (!project || !shown) return null;

  const commit = () => {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const p = useEditStudio.getState().history?.present;
    if (p) useEditStudio.getState().edit(renameSection(p, r.id, r.value));
  };

  return (
    <div className={`${styles.layer} ${className ?? ""}`} ref={setHost} aria-label="Sections">
      {sections.map((m, i) => {
        const end = m.endMs as number;
        const x0 = msToX(m.ms, pps, scrollMs);
        const x1 = msToX(end, pps, scrollMs);
        if (x1 < 0 || x0 > width) return null;
        const selected = selection?.kind === "range" && selection.fromMs === m.ms && selection.toMs === end;
        const name = m.label ?? "";
        const select = () => useEditStudio.getState().select({ kind: "range", fromMs: m.ms, toMs: end });
        return (
          <div key={m.id} className={styles.band} data-alt={i % 2 === 1} data-selected={selected} style={{ left: x0, width: Math.max(1, x1 - x0) }}>
            <div className={styles.chip} style={{ left: Math.max(2, -x0 + 2) }}>
              {renaming?.id === m.id ? (
                <input
                  className={styles.rename}
                  autoFocus
                  aria-label="Section name"
                  data-tip="Name for this section; Enter saves, Esc cancels"
                  maxLength={MAX_SECTION_LABEL}
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: m.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") setRenaming(null);
                    e.stopPropagation();
                  }}
                  onBlur={commit}
                />
              ) : (
                <button type="button" className={styles.chipLabel} data-tip={`Select this section's time range (${name || "Section"}) to auto-fill it or edit inside it`} onClick={select}>
                  {name || "Section"}
                </button>
              )}
              <MenuButton
                label={`${name || "Section"} options`}
                icon="ellipsis"
                variant="ghost"
                size="sm"
                items={() => [
                  { id: "rename", label: "Rename section", onSelect: () => setRenaming({ id: m.id, value: name }) },
                  { id: "select", label: "Select range", onSelect: select },
                  { id: "style", label: "Style this section…", tip: "Choose what this part cuts on, which footage it uses and what it reacts to", onSelect: () => useSectionStyle.getState().open({ fromMs: m.ms, toMs: end }) },
                  {
                    id: "autofill",
                    label: "Auto-fill this section",
                    onSelect: () => {
                      select();
                      useEditStudio.getState().openDialog({ kind: "autofill", range: { fromMs: m.ms, toMs: end } });
                    },
                  },
                ]}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
