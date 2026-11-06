import { useEffect } from "react";
import { Icon, toast } from "@/components";
import type { LibraryFolder, LibraryProject, LibrarySavedMask } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { openTool } from "@/lib/openTool";
import { useLibrary } from "@/state/library";
import { useModules } from "@/state/modules";
import { ItemThumb } from "./previews/ItemThumb";
import { fromPath } from "./items";
import styles from "./Library.module.css";

export const ERASER_ID = "object-eraser";

/** Opens a project's tool. There is no shared "open project X" hand-off yet, so the tool opens and says which one to pick. */
export function openProject(p: LibraryProject): void {
  const name = useModules.getState().byId[p.moduleId]?.name ?? p.moduleId;
  void openTool(p.moduleId);
  toast({ title: `Opened ${name}`, description: `Pick "${p.name}" from its projects.` });
}

export function openMask(m: LibrarySavedMask): void {
  void openTool(ERASER_ID);
  toast({ title: "Opened Object Eraser", description: `Your saved mask "${m.name}" is in its masks.` });
}

/** The Received folder's children (one per sending device) with their counts. */
export function receivedDevices(root: LibraryFolder | null): LibraryFolder[] {
  const received = (root?.children ?? []).find((c) => c.name === "Received");
  return received?.children ?? [];
}

export interface PlacesProps {
  root: LibraryFolder | null;
  /** Jump to a folder in the Folders view. */
  onFolder: (rel: string) => void;
}

/**
 * Things the user made that live outside the library (projects, saved masks)
 * and what arrived from other devices, grouped by device.
 */
export function Places({ root, onFolder }: PlacesProps) {
  const places = useLibrary((s) => s.places);
  const unavailable = useLibrary((s) => s.placesUnavailable);
  const modules = useModules((s) => s.byId);
  useEffect(() => {
    void useLibrary.getState().loadPlaces().catch(() => undefined);
  }, []);
  const projects = places?.projects ?? [];
  const masks = places?.savedMasks ?? [];
  const devices = receivedDevices(root);
  if (unavailable) {
    return (
      <section className={styles.places} aria-label="Other places">
        <h3 className={styles.placesTitle}>Other places</h3>
        <p className={styles.note}>Projects and saved masks can't be listed yet.</p>
      </section>
    );
  }
  if (projects.length === 0 && masks.length === 0 && devices.length === 0) return null;
  return (
    <section className={styles.places} aria-label="Other places">
      <h3 className={styles.placesTitle}>Other places</h3>
      {projects.length > 0 ? (
        <>
          <h4 className={styles.placesSub}>Projects</h4>
          <div className={styles.placeGrid}>
            {projects.map((p) => (
              <button key={p.id} type="button" className={styles.place} aria-label={`Open project ${p.name}`} onClick={() => openProject(p)} data-tip={`Open in ${modules[p.moduleId]?.name ?? p.moduleId}`}>
                <span className={styles.placeThumb}>
                  <ItemThumb item={{ ...fromPath(p.thumb || p.render || `${p.id}.none`), at: p.updatedAt }} />
                </span>
                <span className={styles.cardName}>{p.name}</span>
                <span className={styles.cardMeta}>
                  <span>{modules[p.moduleId]?.name ?? p.moduleId}</span>
                  {p.updatedAt ? <span>{formatRelativeTime(p.updatedAt)}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      {masks.length > 0 ? (
        <>
          <h4 className={styles.placesSub}>Saved masks</h4>
          <ul className={styles.maskList}>
            {masks.map((m) => (
              <li key={m.id}>
                <button type="button" className={styles.maskBtn} aria-label={`Open saved mask ${m.name}`} onClick={() => openMask(m)} data-tip="Open Object Eraser">
                  <Icon name="eraser" size={14} />
                  <span>{m.name}</span>
                  <span className={styles.mono}>
                    {m.width}×{m.height}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {devices.length > 0 ? (
        <>
          <h4 className={styles.placesSub}>Received</h4>
          <ul className={styles.maskList}>
            {devices.map((d) => (
              <li key={d.rel}>
                <button type="button" className={styles.maskBtn} aria-label={`Received from ${d.name}`} onClick={() => onFolder(d.rel)} data-tip={d.path}>
                  <Icon name="folder" size={14} />
                  <span>{d.name}</span>
                  <span className={styles.mono}>{d.files}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
