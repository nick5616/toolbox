/**
 * The look gallery (Phase 21 SPEC §E1): the bottom strip with tabs
 * Film / Bold / Bonkers / Mine (+ ✦ AI suggestions) and live thumbnails of
 * the user's own picture in every look. Clicking a card applies the look.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, Icon, IconButton, SegmentedControl, TextField } from "@/components";
import type { BuiltInLook, GradeRecipe } from "@/grade/types";
import { deleteSavedLook, renameSavedLook } from "./actions";
import { builtInLooks, lookKey } from "./builtins";
import { THUMB_WIDTH, useLookThumb } from "./lookThumbs";
import { buildInputs, previewReady, sourceSize, type FrameSize } from "./previewInputs";
import { mapReady, rename } from "./recipe";
import { useGrade, type GalleryTab } from "./store";
import { useReplicaFlag } from "./replica";
import styles from "./Grade.module.css";

type TabId = GalleryTab | "ai";

interface Item {
  key: string;
  name: string;
  recipe: GradeRecipe;
  lookId: string;
  blurb: string;
  saved?: boolean;
  why?: string;
}

function thumbSize(src: ReturnType<typeof sourceSize>): FrameSize {
  const w = THUMB_WIDTH;
  const h = Math.min(220, Math.max(60, Math.round(((w * src.height) / src.width) / 2) * 2));
  return { width: w, height: h };
}

function useVisible(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "0px 120px 0px 120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return [setEl, visible];
}

function Card({ item, selected, size, replica }: { item: Item; selected: boolean; size: FrameSize; replica: boolean }) {
  const [setEl, visible] = useVisible();
  const path = useGrade((s) => s.selected);
  const src = useGrade((s) => s.src);
  const urls = useGrade((s) => s.urls);
  const wild = useGrade((s) => s.wild);
  const maps = useGrade((s) => s.maps);
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const aux = mapReady(maps);
  const ready = previewReady(src, urls);
  const sig = src?.preview?.stream ?? src?.image ?? "";
  const key = `${path}|${sig}|${item.key}|${wild.toFixed(2)}|${aux.depth ? "d" : ""}${aux.subject ? "s" : ""}${aux.people ? "p" : ""}|${size.width}x${size.height}`;
  const req = useMemo(
    () => (ready ? { key, width: size.width, height: size.height, build: () => buildInputs({ path, src, urls, recipe: item.recipe, wild, aux, maps, size }) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, key],
  );
  const { url, pending } = useLookThumb(req, visible && !replica);
  const apply = () => useGrade.getState().setRecipe(item.recipe, item.lookId);
  return (
    <div ref={setEl} className={styles.card} data-selected={selected || undefined} data-testid="look-card">
      <button type="button" className={styles.cardButton} aria-pressed={selected} data-tip={item.why ? `${item.name}: ${item.why}` : `${item.name}: ${item.blurb}`} onClick={apply}>
        <span className={styles.thumb} style={{ width: size.width, height: size.height }}>
          {url ? <img src={url} alt="" width={size.width} height={size.height} draggable={false} /> : <span className={pending ? styles.thumbPending : styles.thumbEmpty} aria-hidden />}
          {item.recipe.tier === "ai" && <span className={styles.aiMark}>✦</span>}
        </span>
        <span className={styles.cardName}>{item.name}</span>
      </button>
      {item.saved && !replica && (
        <span className={styles.cardActions}>
          <IconButton label={`Rename “${item.name}”`} icon="pencil" size="sm" onClick={() => setEditing(item.name)} />
          <IconButton label={`Delete “${item.name}”`} icon="trash-2" size="sm" variant="danger" onClick={() => setAsking(true)} />
        </span>
      )}
      {editing !== null && (
        <div className={styles.cardRename}>
          <TextField
            size="sm"
            value={editing}
            maxLength={40}
            aria-label="New name"
            data-tip="Type a new name and press Enter"
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null);
              if (e.key === "Enter" && editing.trim() && editing.trim() !== item.name) {
                void renameSavedLook(item.name, rename(item.recipe, editing.trim()).name);
                setEditing(null);
              } else if (e.key === "Enter") setEditing(null);
            }}
          />
        </div>
      )}
      <ConfirmDialog open={asking} title={`Delete “${item.name}”?`} body="It disappears from Mine. Files you already graded with it stay as they are." confirmLabel="Delete" tone="danger" onConfirm={() => { setAsking(false); void deleteSavedLook(item.name); }} onCancel={() => setAsking(false)} />
    </div>
  );
}

const tierItems = (looks: BuiltInLook[]): Item[] => looks.map((l) => ({ key: l.id, name: l.recipe.name, recipe: l.recipe, lookId: l.id, blurb: l.blurb }));

export function Gallery() {
  const tab = useGrade((s) => s.tab);
  const mine = useGrade((s) => s.mine);
  const suggestions = useGrade((s) => s.suggestions);
  const lookId = useGrade((s) => s.lookId);
  const recipeName = useGrade((s) => s.recipe.name);
  const recipeTier = useGrade((s) => s.recipe.tier);
  const src = useGrade((s) => s.src);
  const setTab = useGrade((s) => s.setTab);
  const replica = useReplicaFlag();
  const [aiTab, setAiTab] = useState(false);
  const size = useMemo(() => thumbSize(sourceSize(src)), [src]);
  const active: TabId = aiTab && suggestions.length > 0 ? "ai" : tab;

  // New suggestions open their tab once.
  const seen = useRef(0);
  useEffect(() => {
    if (suggestions.length > 0 && seen.current !== suggestions.length) setAiTab(true);
    seen.current = suggestions.length;
  }, [suggestions]);

  const items = useMemo<Item[]>(() => {
    const all = builtInLooks();
    switch (active) {
      case "film":
      case "bold":
      case "bonkers":
        return tierItems(all.filter((l) => l.recipe.tier === active));
      case "mine":
        return mine.map((r) => ({ key: lookKey(r), name: r.name, recipe: r, lookId: "", blurb: "A look you saved", saved: true }));
      case "ai":
        return suggestions.map((s) => ({ key: `ai:${s.name}:${s.recipe.ops.length}:${s.recipe.seed}`, name: s.name, recipe: s.recipe, lookId: "", blurb: s.why, why: s.why }));
    }
  }, [active, mine, suggestions]);

  const options = [
    { value: "film" as const, label: "Film", tip: "Natural film looks: tasteful at any Wildness" },
    { value: "bold" as const, label: "Bold", tip: "Strong looks with a point of view" },
    { value: "bonkers" as const, label: "Bonkers", tip: "False colour, glitch and other absolutely unhinged looks" },
    { value: "mine" as const, label: mine.length > 0 ? `Mine (${mine.length})` : "Mine", tip: "Looks you saved, and looks the AI wrote that you kept" },
    ...(suggestions.length > 0 ? [{ value: "ai" as const, label: "✦ For this picture", tip: "Looks the vision model picked for this picture" }] : []),
  ];

  return (
    <div className={styles.gallery} role="region" aria-label="Look gallery">
      <div className={styles.galleryTabs}>
        <SegmentedControl
          size="sm"
          aria-label="Look groups"
          value={active}
          options={options}
          onChange={(v) => {
            if (v === "ai") setAiTab(true);
            else {
              setAiTab(false);
              setTab(v);
            }
          }}
        />
      </div>
      <div className={styles.galleryStrip}>
        {items.length === 0 ? (
          <p className={styles.galleryEmpty}>
            <Icon name="palette" size={14} />{" "}
            {active === "mine" ? "Looks you save show up here. Use Save look in the Export panel." : "No looks to show yet."}
          </p>
        ) : (
          items.map((it) => (
            <Card key={it.key} item={it} size={size} replica={replica} selected={(it.lookId !== "" && it.lookId === lookId) || (it.lookId === "" && lookId === "" && recipeTier === it.recipe.tier && recipeName === it.name)} />
          ))
        )}
      </div>
    </div>
  );
}
