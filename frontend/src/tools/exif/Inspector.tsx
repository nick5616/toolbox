import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, Spinner, TextField } from "@/components";
import { FilesService, type MetaGroup, type MetadataView } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { displayText } from "@/lib/displayPath";
import { formatBytes } from "@/lib/format";
import { TextActions } from "@/tools/_kit";
import { canThumbnail, formatCoordinates, metadataText } from "./options";
import type { MetaState } from "./useMetadata";
import styles from "./ExifView.module.css";

function Thumbnail({ path, sizeBytes }: { path: string; sizeBytes: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    setSrc("");
    if (!canThumbnail(path, sizeBytes)) return;
    let cancelled = false;
    FilesService.ImageDataURL(path)
      .then((u) => !cancelled && setSrc(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, sizeBytes]);
  return src ? (
    <img className={styles.thumb} src={src} alt="" data-tip="Preview of the photo" />
  ) : (
    <span className={styles.thumb} aria-hidden="true">
      <Icon name="image" size={24} />
    </span>
  );
}

function Group({
  path,
  group,
  filter,
  open,
  onToggle,
}: {
  path: string;
  group: MetaGroup;
  filter: string;
  open: boolean;
  onToggle: () => void;
}) {
  const fields = group.fields ?? [];
  const shown = filter
    ? fields.filter((f) => `${f.label} ${f.tag} ${f.value}`.toLowerCase().includes(filter))
    : fields;
  if (filter && shown.length === 0) return null;
  const expanded = filter ? true : open;
  const bodyId = `${path}:${group.name}`;
  return (
    <section className={styles.group}>
      <button type="button" className={styles.groupBtn} aria-expanded={expanded} aria-controls={bodyId} data-tip={expanded ? "Hide this group of tags" : "Show this group of tags"} onClick={onToggle}>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        <span className={styles.groupName}>{group.name}</span>
        <span className={styles.count} data-tip="Number of tags in this group">
          {shown.length}
        </span>
      </button>
      {expanded && (
        <dl id={bodyId} className={styles.fields}>
          {shown.map((f, i) => (
            <div key={`${f.tag}:${i}`} className={styles.field}>
              <dt data-tip={`Tag name: ${f.tag}`}>{f.label}</dt>
              <dd>{displayText(f.value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Loaded({ view }: { view: MetadataView }) {
  const [filter, setFilter] = useState("");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => view.groups ?? [], [view]);
  const q = filter.trim().toLowerCase();
  const camera = [view.make, view.model].filter(Boolean).join(" ");

  return (
    <div className={styles.inspector}>
      <header className={styles.insHead}>
        <Thumbnail path={view.path} sizeBytes={view.sizeBytes} />
        <div className={styles.insInfo}>
          <h4 className={styles.insName} data-tip={view.path}>
            {view.name}
          </h4>
          <span className={styles.insMeta} data-tip="File size on disk">
            {formatBytes(view.sizeBytes)}
          </span>
          {camera && (
            <span className={styles.insMeta} data-tip="Camera make and model recorded in the photo">
              {camera}
            </span>
          )}
          {view.dateTaken && (
            <span className={styles.insMeta} data-tip="When the photo was taken, from its metadata">
              {view.dateTaken}
            </span>
          )}
        </div>
        <span className={styles.insActions}>
          <TextActions
            text={() => metadataText(view)}
            filename={`${view.name.replace(/\.[^.]*$/, "") || "photo"}.metadata.txt`}
            what="metadata"
            disabled={groups.length === 0}
          />
        </span>
      </header>

      {view.hasLocation && view.location && (
        <div className={styles.location} data-tip="GPS position stored in this photo; anyone you share the file with can see it">
          <Icon name="map-pin" size={16} />
          <span className={styles.locationText}>
            Contains location: {formatCoordinates(view.location.lat, view.location.lon)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="copy"
            data-tip="Copy latitude and longitude as text"
            onClick={() => view.location && void copyText(formatCoordinates(view.location.lat, view.location.lon), { what: "coordinates" })}
          >
            Copy coordinates
          </Button>
        </div>
      )}

      <TextField
        size="sm"
        icon="search"
        placeholder="Filter tags"
        aria-label="Filter tags"
        data-tip="Type to show only tags whose name or value contains this text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {groups.length === 0 ? (
        <p className={styles.note}>No metadata found.</p>
      ) : (
        groups.map((g) => (
          <Group
            key={g.name}
            path={view.path}
            group={g}
            filter={q}
            open={toggled[g.name] ?? !g.collapsed}
            onToggle={() => setToggled((t) => ({ ...t, [g.name]: !(t[g.name] ?? !g.collapsed) }))}
          />
        ))
      )}
    </div>
  );
}

/** Right pane: metadata of the selected file. */
export function Inspector({ state }: { state: MetaState | undefined }) {
  if (!state || state.status === "loading") return <Spinner label="Reading metadata" />;
  if (state.status === "error") {
    return (
      <Banner tone="danger" title="Couldn't read metadata">
        {state.message}
      </Banner>
    );
  }
  return (
    <>
      {!state.view.editable && <p className={styles.rawNote} data-tip="Metadata of RAW camera files can be read but not edited here">RAW files are read-only here.</p>}
      <Loaded key={state.view.path} view={state.view} />
    </>
  );
}
