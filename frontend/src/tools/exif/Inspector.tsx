import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, Spinner, TextField, toast } from "@/components";
import { FilesService, type MetaGroup, type MetadataView } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { canThumbnail, formatCoordinates } from "./options";
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
    <img className={styles.thumb} src={src} alt="" />
  ) : (
    <span className={styles.thumb} aria-hidden="true">
      <Icon name="image" size={24} />
    </span>
  );
}

async function copyCoordinates(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: "Coordinates copied" });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
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
      <button type="button" className={styles.groupBtn} aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        <span className={styles.groupName}>{group.name}</span>
        <span className={styles.count}>{shown.length}</span>
      </button>
      {expanded && (
        <dl id={bodyId} className={styles.fields}>
          {shown.map((f, i) => (
            <div key={`${f.tag}:${i}`} className={styles.field}>
              <dt title={f.tag}>{f.label}</dt>
              <dd>{f.value}</dd>
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
          <h4 className={styles.insName} title={view.path}>
            {view.name}
          </h4>
          <span className={styles.insMeta}>{formatBytes(view.sizeBytes)}</span>
          {camera && <span className={styles.insMeta}>{camera}</span>}
          {view.dateTaken && <span className={styles.insMeta}>{view.dateTaken}</span>}
        </div>
      </header>

      {view.hasLocation && view.location && (
        <div className={styles.location}>
          <Icon name="map" size={16} />
          <span className={styles.locationText}>
            Contains location: {formatCoordinates(view.location.lat, view.location.lon)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="copy"
            onClick={() => view.location && void copyCoordinates(formatCoordinates(view.location.lat, view.location.lon))}
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
      {!state.view.editable && <p className={styles.rawNote}>RAW files are read-only here.</p>}
      <Loaded key={state.view.path} view={state.view} />
    </>
  );
}
