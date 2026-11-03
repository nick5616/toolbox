/** The Auto-fill dialog (Phase 9 SPEC §13.4). */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Banner, Button, Field, IconButton, SegmentedControl, Select, TextField, toast, cx } from "@/components";
import { formatMs } from "@/components/media";
import type { EditClip } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength } from "@/viz/edit/types";
import { newTrack } from "../doc";
import { useEditStudio, useMarkers, useProject } from "../store";
import { autofill, validateShape } from "./autofill";
import { RECIPES } from "./recipes";
import { useSelectedSources } from "./selection";
import type { AutofillOptions, AutofillSource } from "./types";
import styles from "./AutofillDialog.module.css";

export interface AutofillDialogProps {
  open: boolean;
  /** A preselected range (timeline ms), or null for the whole edit. */
  range: { fromMs: number; toMs: number } | null;
  onClose(): void;
}

export function AutofillDialog(props: AutofillDialogProps) {
  if (!props.open) return null;
  return <Body range={props.range} onClose={props.onClose} />;
}

type SourceMode = "all" | "selected" | "tags";
type Order = AutofillOptions["order"];

const ORDERS: ReadonlyArray<{ value: Order; label: string }> = [
  { value: "recipe", label: "Recipe's own" },
  { value: "sequential", label: "In order" },
  { value: "shuffleNoRepeat", label: "Shuffled" },
  { value: "byTag", label: "By tag" },
];

const FALLBACK_SEED = 1;

function savedOptions(p: NormalProject): Partial<AutofillOptions> {
  if (!p.recipe) return {};
  try {
    const v = JSON.parse(p.recipe.options) as Partial<AutofillOptions>;
    return typeof v === "object" && v ? v : {};
  } catch {
    return {};
  }
}

function Body({ range, onClose }: { range: AutofillDialogProps["range"]; onClose: () => void }) {
  const project = useProject();
  const markers = useMarkers();
  const analysis = useEditStudio((s) => s.analysis);
  const sourceStates = useEditStudio((s) => s.sources);
  const selected = useSelectedSources();
  const titleId = useId();

  const saved = useMemo(() => (project ? savedOptions(project) : {}), [project]);
  const [recipeId, setRecipeId] = useState(RECIPES.some((r) => r.id === saved.recipeId) ? (saved.recipeId as string) : (RECIPES[0]?.id ?? "downbeat"));
  const [order, setOrder] = useState<Order>(saved.order ?? "recipe");
  const [mode, setMode] = useState<SourceMode>("all");
  const [tagSel, setTagSel] = useState<string[]>([]);
  const videoTracks = useMemo(() => (project?.tracks ?? []).filter((t) => t.kind === "video" && !t.locked), [project]);
  const [trackId, setTrackId] = useState<string>(videoTracks[0]?.id ?? "new");
  const [seed, setSeed] = useState<number>(saved.seed ?? project?.recipe?.seed ?? project?.seed ?? FALLBACK_SEED);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "selected" && selected.length === 0) setMode("all");
  }, [mode, selected.length]);

  // The sources the engine may use, in Sources-panel order, with what the preview pipeline learned.
  const sources = useMemo<AutofillSource[]>(() => {
    const out: AutofillSource[] = [];
    for (const s of project?.sources ?? []) {
      const st = sourceStates[s.path];
      if (!st || st.error) continue;
      const kind = st.info.kind === "video" || st.info.kind === "image" ? st.info.kind : null;
      if (!kind) continue;
      out.push({ path: s.path, kind, durationMs: st.info.durationMs, tags: s.tags ?? [], shots: st.shots });
    }
    return out;
  }, [project, sourceStates]);

  const allTags = useMemo(() => [...new Set(sources.flatMap((s) => s.tags))].sort(), [sources]);

  const sourceOption = useMemo<AutofillOptions["sources"]>(() => {
    if (mode === "selected") return [...selected];
    if (mode === "tags") return sources.filter((s) => s.tags.some((t) => tagSel.includes(t))).map((s) => s.path);
    return "all";
  }, [mode, selected, sources, tagSel]);

  const D = project ? editLength(project) : 0;
  const rangeLabel = range ? `Selection ${formatMs(range.fromMs)} to ${formatMs(range.toMs)}` : `Whole edit (${formatMs(D)})`;

  const base = useMemo(
    () => ({ seed, order, sources: sourceOption, trackId, range }),
    [seed, order, sourceOption, trackId, range],
  );

  // One autofill per recipe on the current project: the strips, and the summary for the chosen one.
  const runs = useMemo(() => {
    if (!project || !analysis) return null;
    return RECIPES.map((recipe) => autofill({ project, markers, analysis, sources, recipe, options: { ...base, recipeId: recipe.id } }));
  }, [project, analysis, markers, sources, base]);

  const idx = Math.max(0, RECIPES.findIndex((r) => r.id === recipeId));
  const current = runs?.[idx] ?? null;
  const keptCount = useMemo(() => {
    const t = project?.tracks.find((x) => x.id === trackId);
    const a = range?.fromMs ?? 0;
    const b = range?.toMs ?? D;
    return (t?.clips ?? []).filter((c) => (c.pinned || !c.auto) && c.startMs < b && c.endMs > a).length;
  }, [project, trackId, range, D]);
  const usedSources = useMemo(() => new Set(current?.clips.filter((c) => c.path).map((c) => c.path)).size, [current]);

  if (!project) return null;

  const noSourcesChosen = Array.isArray(sourceOption) && sourceOption.length === 0;
  const canApply = !!analysis && !!current && sources.length > 0 && !noSourcesChosen && current.clips.length > 0;

  const apply = () => {
    if (!analysis || !project) return;
    const store = useEditStudio.getState();
    let next: NormalProject = project;
    let target = trackId;
    if (trackId === "new") {
      const t = { ...newTrack("video", "Auto"), clips: [] as EditClip[] };
      next = { ...project, tracks: [...project.tracks, t] };
      target = t.id;
    }
    const recipe = RECIPES[idx];
    if (!recipe) return;
    const options: AutofillOptions = { ...base, recipeId: recipe.id, trackId: target };
    const res = autofill({ project: next, markers, analysis, sources, recipe, options });
    const gone = new Set(res.removed);
    const tr = next.tracks.find((t) => t.id === target);
    if (!tr) return;
    const clips = [...tr.clips.filter((c) => !gone.has(c.id)), ...res.clips].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
    const bad = validateShape(clips, new Set(res.clips.map((c) => c.id)), D);
    if (bad) {
      setProblem(`Auto-fill made an invalid layout, so nothing was changed. ${bad}.`);
      return;
    }
    const run = (project.recipe?.run ?? 0) + 1;
    store.edit({
      ...next,
      tracks: next.tracks.map((t) => (t.id === target ? { ...t, clips } : t)),
      recipe: { recipeId: recipe.id, seed, run, options: JSON.stringify(options) },
    });
    toast({ title: `Auto-fill added ${res.clips.length} clips`, description: res.removed.length ? `${res.removed.length} earlier auto-fill clips replaced` : undefined, tone: "success" });
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const trackOptions = [...videoTracks.map((t) => ({ value: t.id, label: t.name })), { value: "new", label: "New track (Auto)" }];

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 id={titleId} className={styles.title}>
          Auto-fill
        </h2>

        {!analysis && (
          <Banner tone="warn" title="No analysis yet">
            Analyze the song first so there are beats to cut on.
          </Banner>
        )}
        {analysis && sources.length === 0 && (
          <Banner tone="warn" title="No sources">
            Add videos or photos to Sources first.
          </Banner>
        )}

        <div className={styles.cards} role="radiogroup" aria-label="Recipe">
          {RECIPES.map((r, i) => (
            <button key={r.id} type="button" role="radio" aria-checked={r.id === recipeId} className={cx(styles.card, r.id === recipeId && styles.cardOn)} onClick={() => setRecipeId(r.id)}>
              <span className={styles.cardName}>{r.name}</span>
              <span className={styles.cardText}>{r.description}</span>
              <Strip starts={runs?.[i]?.clips.map((c) => c.startMs) ?? []} durationMs={D} />
            </button>
          ))}
        </div>

        <div className={styles.grid}>
          <Field label="Media order">
            <SegmentedControl<Order> aria-label="Media order" size="sm" value={order} onChange={setOrder} options={ORDERS} />
          </Field>
          <Field label="Sources">
            <SegmentedControl<SourceMode>
              aria-label="Sources"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "all", label: "All" },
                { value: "selected", label: `Selected (${selected.length})`, disabled: selected.length === 0 },
                { value: "tags", label: "By tag", disabled: allTags.length === 0 },
              ]}
            />
          </Field>
          {mode === "tags" && (
            <div className={styles.chips}>
              {allTags.map((t) => (
                <button key={t} type="button" aria-pressed={tagSel.includes(t)} className={cx(styles.chip, tagSel.includes(t) && styles.chipOn)} onClick={() => setTagSel((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <Field label="Target track">{(c) => <Select id={c.id} size="sm" value={trackId} onChange={setTrackId} options={trackOptions} />}</Field>
          <Field label="Range">
            <span className={styles.readonly}>{rangeLabel}</span>
          </Field>
          <Field label="Seed" hint="The same seed and inputs give the same clips.">
            {(c) => (
              <TextField
                id={c.id}
                size="sm"
                mono
                type="number"
                value={String(seed)}
                onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
                trailing={<IconButton label="New random seed" icon="refresh-cw" size="sm" onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))} />}
              />
            )}
          </Field>
        </div>

        {current && current.warnings.length > 0 && (
          <Banner tone="info" title="Heads up">
            {current.warnings.join(". ")}.
          </Banner>
        )}
        {problem && (
          <Banner tone="danger" title="Couldn't apply">
            {problem}
          </Banner>
        )}

        <div className={styles.footer}>
          <span className={styles.summary} aria-live="polite">
            {current ? `≈ ${current.clips.length} cuts · ${usedSources} sources · ${keptCount} pinned clips kept` : "Nothing to preview yet"}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} disabled={!canApply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A mini cut-density strip: one tick per clip start across the edit. */
function Strip({ starts, durationMs }: { starts: number[]; durationMs: number }) {
  const ticks = useMemo(() => {
    if (durationMs <= 0) return [];
    // At most one tick per 1/200 of the width.
    const seen = new Set<number>();
    for (const s of starts) seen.add(Math.min(199, Math.floor((s / durationMs) * 200)));
    return [...seen];
  }, [starts, durationMs]);
  return (
    <svg className={styles.strip} viewBox="0 0 200 10" preserveAspectRatio="none" aria-hidden>
      {ticks.map((x) => (
        <rect key={x} className={styles.tick} x={x} y={0} width={0.8} height={10} />
      ))}
    </svg>
  );
}
