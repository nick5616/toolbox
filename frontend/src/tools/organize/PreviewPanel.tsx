import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Icon, Spinner } from "@/components";
import { FilesService, OrganizeService, type OrganizeOptions, type OrganizePreview, type OrganizePreviewFile } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { buildTree, isThumbable } from "./options";
import styles from "./OrganizeView.module.css";

const GROUPS_PER_PAGE = 20;

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; preview: OrganizePreview };

function Thumb({ file, keep }: { file: OrganizePreviewFile; keep?: boolean }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!isThumbable(file.path)) return;
    let live = true;
    FilesService.ImageThumb(file.path, 160).then(
      (url) => live && setSrc(url),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [file.path]);
  return (
    <li className={keep ? `${styles.thumb} ${styles.thumbKeep}` : styles.thumb}>
      <span className={styles.thumbBox} data-tip={file.path}>
        {src ? <img className={styles.thumbImg} src={src} alt={file.name} /> : <Icon name="file" size={24} />}
      </span>
      <span className={styles.thumbLabel} data-tip={file.path}>
        {keep && (
          <Badge tone="ok" tip="This copy stays in its folder: the largest picture, then the oldest">
            Keeps
          </Badge>
        )}{" "}
        {file.name}
      </span>
      <span className={styles.thumbMeta}>
        {file.width > 0 ? `${file.width}×${file.height} · ` : ""}
        {formatBytes(file.sizeBytes)}
      </span>
    </li>
  );
}

/** The planned folder tree and the duplicate groups, computed without copying anything. */
export function PreviewPanel({ paths, opts }: { paths: readonly string[]; opts: OrganizeOptions }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [shown, setShown] = useState(GROUPS_PER_PAGE);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    setShown(GROUPS_PER_PAGE);
    OrganizeService.Preview([...paths], opts).then(
      (preview) => live && setState({ kind: "ready", preview }),
      (e: unknown) => live && setState({ kind: "error", message: toAppError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [paths, opts, nonce]);

  const preview = state.kind === "ready" ? state.preview : null;
  const tree = useMemo(() => buildTree(preview?.folders ?? []), [preview]);

  if (state.kind === "loading") {
    return (
      <p className={styles.hint} role="status">
        <Spinner size={14} /> Looking at {paths.length} {paths.length === 1 ? "file" : "files"}…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className={styles.preview}>
        <p className={styles.problem} role="alert">
          {state.message}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  const p = state.preview;
  const groups = p.groups ?? [];
  const copied = p.total - p.skipped;
  return (
    <div className={styles.preview}>
      <p className={styles.previewSummary}>
        {copied} {copied === 1 ? "file" : "files"} would be copied into {p.folders?.length ?? 0} {(p.folders?.length ?? 0) === 1 ? "folder" : "folders"}
        {p.duplicates > 0 ? `; ${p.duplicates} ${p.duplicates === 1 ? "is a duplicate" : "are duplicates"}` : ""}
        {p.skipped > 0 ? ` (${p.skipped} left out)` : ""}.
      </p>
      <p className={styles.hint}>{p.dateSource === "exif" ? "Dates come from the photos' metadata, falling back to the modified date." : "ExifTool isn't installed, so dates come from the files' modified dates."}</p>

      <section aria-label="Folders">
        <h4 className={styles.previewHead}>Folders</h4>
        <ul className={styles.tree}>
          {tree.map((r) => (
            <li key={r.path || "(root)"} className={styles.treeRow} style={{ paddingLeft: `${r.depth * 16}px` }}>
              <Icon name="folder" size={14} />
              <span className={styles.treeName} data-tip={r.path || "The result folder"}>
                {r.name}
              </span>
              <span className={styles.count}>{r.count}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Duplicates">
        <h4 className={styles.previewHead}>Duplicates</h4>
        {groups.length === 0 ? (
          <p className={styles.hint}>No duplicates found.</p>
        ) : (
          <ul className={styles.groups}>
            {groups.slice(0, shown).map((g) => (
              <li key={g.keep.path} className={styles.group} aria-label={`Duplicates of ${g.keep.name}`}>
                <ul className={styles.groupRow}>
                  <Thumb file={g.keep} keep />
                  {(g.others ?? []).map((o) => (
                    <Thumb key={o.path} file={o} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {groups.length > shown && (
          <Button size="sm" variant="ghost" className={styles.more} onClick={() => setShown((n) => n + GROUPS_PER_PAGE)}>
            Show more
          </Button>
        )}
        {p.moreGroups > 0 && groups.length <= shown && <p className={styles.hint}>And {p.moreGroups} more groups not shown.</p>}
      </section>
    </div>
  );
}
