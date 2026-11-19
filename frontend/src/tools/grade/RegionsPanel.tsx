/**
 * Rail ▸ Regions (Phase 21 SPEC §E1, §E5, §E6): the depth, subject and people
 * maps of the open input as thumbnails. Click one to see it larger, "View this
 * map" puts it in the preview, and a map that isn't made yet can be made here
 * (depth for video says how long the CPU needs). A missing model shows its
 * install button.
 */
import { useEffect, useState } from "react";
import { Banner, Button, Spinner } from "@/components";
import type { GradeMapInfo } from "@/lib/api";
import { loadThumb } from "@/lib/thumbs";
import { depthSeconds, estimateLabel, installForMap, prepareMaps } from "./actions";
import { useGrade } from "./store";
import styles from "./Grade.module.css";

type Kind = "depth" | "subject" | "people";

const TILES: ReadonlyArray<{ kind: Kind; label: string; tip: string; what: string }> = [
  { kind: "depth", label: "Depth", tip: "How near or far each part of the picture is; used by Near and Far regions", what: "near and far" },
  { kind: "subject", label: "Subject", tip: "What the picture is about, cut out from the background", what: "subject and background" },
  { kind: "people", label: "People", tip: "Where the people are", what: "people" },
];

function useMapThumb(path: string, max: number): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    setUrl("");
    if (path) void loadThumb(path, max).then((u) => live && setUrl(u ?? ""));
    return () => {
      live = false;
    };
  }, [path, max]);
  return url;
}

function Tile({ kind, label, tip, what, info, preparing }: { kind: Kind; label: string; tip: string; what: string; info: GradeMapInfo | undefined; preparing: boolean }) {
  const video = useGrade((s) => s.src?.info.kind === "video");
  const duration = useGrade((s) => s.src?.info.durationMs ?? 0);
  const fps = useGrade((s) => s.src?.info.fps ?? 30);
  const viewing = useGrade((s) => s.mapView === kind);
  const [big, setBig] = useState(false);
  const preview = info?.ready ? info.preview || info.still : "";
  const thumb = useMapThumb(preview, big ? 480 : 120);
  const missing = info?.missing ?? "";
  const estimate = kind === "depth" && video ? estimateLabel(depthSeconds(duration, fps)) : "";
  return (
    <li className={styles.mapTile} data-testid={`map-${kind}`}>
      <div className={styles.mapHead}>
        <strong>{label}</strong>
        <span className={styles.stopsNote}>{info?.ready ? "Ready" : preparing ? "Preparing…" : missing ? "Not installed" : "Not made yet"}</span>
      </div>
      {info?.ready ? (
        <>
          <button type="button" className={styles.mapThumb} aria-pressed={big} data-tip={big ? "Show smaller" : `Show the ${label.toLowerCase()} map larger`} onClick={() => setBig(!big)}>
            {thumb ? <img src={thumb} alt={`${label} map`} /> : <Spinner />}
          </button>
          <Button size="sm" variant={viewing ? "primary" : "secondary"} icon="eye" data-tip="Show this map in the preview instead of the picture" onClick={() => useGrade.getState().setMapView(viewing ? "" : kind)}>
            {viewing ? "Viewing this map" : "View this map"}
          </Button>
        </>
      ) : missing ? (
        <>
          <p className={styles.note}>
            {tip}. It needs {missing} to be installed.
          </p>
          <Button size="sm" variant="primary" icon="download" data-tip={`Download what the ${label.toLowerCase()} map needs`} onClick={() => void installForMap(missing)}>
            Install {missing}
          </Button>
        </>
      ) : preparing ? (
        <span className={styles.busy} role="status">
          <Spinner /> Making the {label.toLowerCase()} map…
        </span>
      ) : (
        <>
          <p className={styles.note}>
            {tip}.{estimate ? ` For this clip it takes ${estimate} on this computer.` : ""}
          </p>
          <Button size="sm" variant="secondary" icon="layers" data-tip={`Make the ${label.toLowerCase()} map once; it's kept for next time`} onClick={() => void prepareMaps([kind])}>
            Make the {what} map
          </Button>
        </>
      )}
    </li>
  );
}

export function RegionsPanel() {
  const maps = useGrade((s) => s.maps);
  const selected = useGrade((s) => s.selected);
  const preparing = maps?.preparing ?? [];
  if (!selected) return <div className={styles.panel}><p className={styles.note}>Open a picture or a video to see its regions.</p></div>;
  return (
    <div className={styles.panel}>
      <p className={styles.note}>An op can apply to just the subject, the background, people, or what's near or far. Maps are made once per file and kept.</p>
      {!maps && (
        <Banner tone="info" title="Checking what's available">
          Region maps appear here as soon as they're known.
        </Banner>
      )}
      <ul className={styles.mapList} aria-label="Region maps">
        {TILES.map((t) => (
          <Tile key={t.kind} {...t} info={maps?.[t.kind]} preparing={preparing.includes(t.kind)} />
        ))}
      </ul>
    </div>
  );
}
