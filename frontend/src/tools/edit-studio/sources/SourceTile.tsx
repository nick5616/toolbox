/** One source in the Sources panel (Phase 9 SPEC §14.6). */
import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Badge, Button, Icon, MenuButton, cx, type MenuItem } from "@/components";
import type { EditSourceState } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useThumb } from "@/tools/video-editor/useThumbs";
import { TAG_PRESETS, toggleTag } from "./tags";
import styles from "./SourcesPanel.module.css";

export type TileStatus = "checking" | "missing" | "error" | "preparing" | "notReady" | "ready";

/** What the tile says about a source file. */
export function tileStatus(state: EditSourceState | undefined): TileStatus {
  if (!state) return "checking";
  if (state.info.error || state.info.kind === "") return "missing";
  if (state.preparing) return "preparing";
  if (state.error) return "error";
  const ready = state.info.kind === "video" ? !!state.preview : state.image !== "";
  return ready ? "ready" : "notReady";
}

export interface SourceTileProps {
  path: string;
  tags: readonly string[];
  state: EditSourceState | undefined;
  used: number;
  selected: boolean;
  /** 0..1 while this source's prepare job runs, else -1. */
  progress: number;
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>, path: string): void;
  onClick(e: React.MouseEvent<HTMLDivElement>, path: string): void;
  onDoubleClick(path: string): void;
  onTags(path: string, tags: string[]): void;
  onNewTag(path: string): void;
  onRelink(path: string): void;
  onPrepare(path: string): void;
}

const PHOTO_EXT = /\.(jpe?g|png|webp|bmp|tiff?|heic|heif|gif)$/i;

function Thumb({ path, kind }: { path: string; kind: string }) {
  const url = useThumb(path, kind === "image" ? "image" : "video");
  if (!url) return <Icon name={kind === "image" ? "image" : "film"} size={20} />;
  const style: CSSProperties =
    kind === "image"
      ? { backgroundImage: `url("${url}")`, backgroundSize: "cover", backgroundPosition: "center" }
      : { backgroundImage: `url("${url}")`, backgroundSize: "1000% 100%", backgroundPosition: "0 0" };
  return <div className={styles.thumbImg} style={style} aria-hidden="true" />;
}

function TileImpl(p: SourceTileProps) {
  const status = tileStatus(p.state);
  // Until the source is probed, the extension decides (a photo must never ask for a filmstrip).
  const kind = p.state?.info.kind || (PHOTO_EXT.test(p.path) ? "image" : "video");
  const name = p.path.split(/[\\/]/).pop() ?? p.path;
  const tagItems = (): MenuItem[] => [
    ...TAG_PRESETS.map((t) => ({
      id: t,
      label: `${p.tags.includes(t) ? "✓ " : ""}${t}`,
      onSelect: () => {
        const next = toggleTag(p.tags, t);
        if (next) p.onTags(p.path, next);
      },
    })),
    ...p.tags
      .filter((t) => !(TAG_PRESETS as readonly string[]).includes(t))
      .map((t) => ({ id: `x-${t}`, label: `✓ ${t}`, onSelect: () => p.onTags(p.path, p.tags.filter((x) => x !== t)) })),
    { id: "new", label: "New tag…", icon: "plus", onSelect: () => p.onNewTag(p.path) },
  ];
  return (
    <div
      className={cx(styles.tile, p.selected && styles.tileSelected, status === "missing" && styles.tileMissing)}
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      aria-label={name}
      title={p.path}
      data-source-path={p.path}
      onPointerDown={(e) => p.onPointerDown(e, p.path)}
      onClick={(e) => p.onClick(e, p.path)}
      onDoubleClick={() => p.onDoubleClick(p.path)}
    >
      <div className={styles.thumb}>
        <Thumb path={p.path} kind={kind} />
        {p.state && kind === "video" && <span className={styles.duration}>{formatDuration(p.state.info.durationMs / 1000)}</span>}
        <Icon name={kind === "image" ? "image" : "film"} size={12} className={styles.kindIcon} />
        {p.used > 0 && (
          <span className={styles.used} title={`Used in ${p.used} ${p.used === 1 ? "clip" : "clips"}`}>
            {p.used}
          </span>
        )}
      </div>
      <div className={styles.tileName}>{name}</div>
      <div className={styles.status}>
        {status === "checking" && <span className={styles.muted}>Checking…</span>}
        {status === "ready" && <span className={styles.muted}>Ready</span>}
        {status === "preparing" && <Badge tone="warn">{p.progress >= 0 ? `Preparing ${Math.round(p.progress * 100)}%` : "Preparing"}</Badge>}
        {status === "missing" && (
          <>
            <Badge tone="danger">Missing</Badge>
            <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), p.onRelink(p.path))}>
              Relink
            </Button>
          </>
        )}
        {status === "error" && (
          <>
            <span title={p.state?.error}>
              <Badge tone="danger">Error</Badge>
            </span>
            <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), p.onPrepare(p.path))}>
              Retry
            </Button>
          </>
        )}
        {status === "notReady" && (
          <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), p.onPrepare(p.path))}>
            Prepare
          </Button>
        )}
      </div>
      <div className={styles.tags} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {p.tags.map((t) => (
          <button key={t} type="button" className={styles.chip} aria-label={`Remove tag ${t}`} onClick={() => p.onTags(p.path, p.tags.filter((x) => x !== t))}>
            {t}
          </button>
        ))}
        <MenuButton label={`Tags for ${name}`} icon="hash" variant="ghost" size="sm" items={tagItems} />
      </div>
    </div>
  );
}

export const SourceTile = memo(TileImpl);
