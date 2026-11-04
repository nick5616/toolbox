/** The Section style dialog (SPEC §24.2): cuts, footage and what the section reacts to, applied as one edit. */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Banner, Button, Field, Select, SegmentedControl, Slider, Switch, TextField, toast, cx } from "@/components";
import { formatMs } from "@/components/media";
import { TRANSITION_KINDS } from "@/viz/edit/schema";
import { editLength } from "@/viz/edit/types";
import { useSelectedSources } from "../autofill/selection";
import { HIT_LANES, HIT_LANE_TIPS } from "../beatsync/hits";
import { readySources } from "../beatsync/cutLogic";
import { FX_STACKS } from "../inspector/FxStacks";
import { TRANSITION_LABELS } from "../inspector/TransitionField";
import { useEditStudio, useMarkers, useProject } from "../store";
import { DISTRIBUTIONS, STYLE_CUT_LANES, cutDensity, planStyle, resolveHitLane, resolveSources, snapToGrid, type Distribution, type Range, type SourceMode, type StyleSettings } from "./styleLogic";
import { savedSettings, useSectionStyle } from "./useSectionStyle";
import styles from "./SectionStyleDialog.module.css";

const EVERY = [1, 2, 4, 8].map((n) => ({ value: String(n), label: n === 1 ? "Every one" : `Every ${n}` }));
const MIN_CLIPS = [100, 150, 250, 400, 600, 1000].map((n) => ({ value: String(n), label: n < 1000 ? `${n} ms` : `${n / 1000} s` }));
const HIT_LANE_OPTIONS = [{ value: "cut", label: "The cut lane" }, ...HIT_LANES.map((l) => ({ value: l.value as string, label: l.label }))];

export function SectionStyleDialog() {
  const range = useSectionStyle((s) => s.range);
  if (!range) return null;
  return <Body range={range} onClose={() => useSectionStyle.getState().close()} />;
}

function Body({ range: initial, onClose }: { range: Range; onClose: () => void }) {
  const project = useProject();
  const markers = useMarkers();
  const analysis = useEditStudio((s) => s.analysis);
  const sourceStates = useEditStudio((s) => s.sources);
  const projectId = useEditStudio((s) => s.projectId);
  const selection = useEditStudio((s) => s.selection);
  const moments = useSectionStyle((s) => s.moments);
  const selected = useSelectedSources();
  const titleId = useId();

  const [s, setS] = useState<StyleSettings>(() => savedSettings(projectId));
  const [range, setRange] = useState<Range>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<StyleSettings>) => setS((cur) => ({ ...cur, ...patch }));

  const sources = useMemo(() => (project ? readySources(project, sourceStates) : []), [project, sourceStates]);
  const allTags = useMemo(() => [...new Set(sources.flatMap((x) => x.tags))].sort(), [sources]);
  const pool = useMemo(() => resolveSources(sources, s.sourceMode, selected, s.tags), [sources, s.sourceMode, selected, s.tags]);
  const videos = useMemo(() => pool.filter((x) => x.kind === "video"), [pool]);
  const fps = project?.fps ?? 30;

  // Footage moments for the modes that use them.
  const needsMoments = s.cutLane !== "keep" && (s.distribution === "best" || s.distribution === "oneClip");
  const videoPaths = videos.map((v) => v.path).join("\n");
  useEffect(() => {
    if (needsMoments && videoPaths) void useSectionStyle.getState().loadMoments(videoPaths.split("\n"), fps);
  }, [needsMoments, videoPaths, fps]);
  const waiting = needsMoments && videos.some((v) => !(v.path in moments));

  const seed = project?.seed ?? 1;
  const targetId = useMemo(() => {
    if (!project) return "new";
    const ids = selection?.kind === "clips" ? new Set(selection.ids) : null;
    const t = ids ? project.tracks.find((x) => x.kind === "video" && x.clips.some((c) => ids.has(c.id))) : undefined;
    return (t ?? project.tracks.find((x) => x.kind === "video" && !x.locked))?.id ?? "new";
  }, [project, selection]);

  const plan = useMemo(() => {
    if (!project || !analysis) return null;
    return planStyle({ project, markers, analysis, sources, selectedPaths: selected, moments, range, settings: s, seed, trackId: targetId });
  }, [project, analysis, markers, sources, selected, moments, range, s, seed, targetId]);

  const D = project ? editLength(project) : 0;
  const ticks = useMemo(() => {
    if (s.cutLane === "keep") return (project?.tracks.find((t) => t.id === targetId)?.clips ?? []).filter((c) => c.startMs >= range.fromMs && c.startMs < range.toMs).map((c) => c.startMs);
    return cutDensity(markers, s.cutLane, s.every, s.minClipMs, range);
  }, [project, markers, s.cutLane, s.every, s.minClipMs, range, targetId]);

  if (!project) return null;
  const invalidRange = range.toMs - range.fromMs < 1000 / fps;
  const canApply = !!analysis && !!plan && !plan.problem && !invalidRange;

  const apply = () => {
    if (!plan?.project) {
      setProblem(plan?.problem ?? "Nothing to apply");
      return;
    }
    useEditStudio.getState().edit(plan.project);
    if (projectId) useSectionStyle.getState().save(projectId, s);
    toast({ title: plan.summary, tone: "success" });
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const commitRange = (key: keyof Range, seconds: string) => {
    const ms = snapToGrid(Math.max(0, Math.min(D, Number(seconds) * 1000 || 0)), markers);
    setRange((r) => ({ ...r, [key]: ms }));
  };

  const hitLane = resolveHitLane(s);
  const stackOptions = [{ value: "none", label: "None" }, ...FX_STACKS.map((f) => ({ value: f.id, label: f.label }))];
  const oneValue = videos.find((v) => v.path === s.oneSource)?.path ?? videos[0]?.path ?? "";
  const shown = (p: string) => p.split(/[\\/]/).pop() ?? p;

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 id={titleId} className={styles.title}>
          Section style
        </h2>

        {!analysis && (
          <Banner tone="warn" title="No analysis yet">
            Analyze the song first so there are beats to cut on.
          </Banner>
        )}

        <div className={styles.rangeRow}>
          <Field label="From (s)">
            {(c) => <TextField id={c.id} size="sm" mono type="number" step={0.1} data-tip="Where the section starts, in seconds; it snaps to section edges and bar starts" key={range.fromMs} defaultValue={String(range.fromMs / 1000)} onBlur={(e) => commitRange("fromMs", e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />}
          </Field>
          <Field label="To (s)">
            {(c) => <TextField id={c.id} size="sm" mono type="number" step={0.1} data-tip="Where the section ends, in seconds; it snaps to section edges and bar starts" key={range.toMs} defaultValue={String(range.toMs / 1000)} onBlur={(e) => commitRange("toMs", e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />}
          </Field>
          <span className={styles.rangeText} data-tip="The part of the edit that gets this style">
            {formatMs(range.fromMs)} to {formatMs(range.toMs)}
          </span>
        </div>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Cuts</legend>
          <div className={styles.chips} role="group" aria-label="Switch clips on" data-tip="The musical moment where clips switch">
            {STYLE_CUT_LANES.map((l) => (
              <button
                key={l.value}
                type="button"
                className={cx(styles.chip, s.cutLane === l.value && styles.chipOn)}
                aria-pressed={s.cutLane === l.value}
                data-tip={l.value === "keep" ? "Leave the clips as they are and only add the transition and the effects" : HIT_LANE_TIPS[l.value]}
                onClick={() => set({ cutLane: l.value })}
              >
                {l.label}
              </button>
            ))}
          </div>
          {s.cutLane !== "keep" && (
            <div className={styles.grid}>
              <Field label="How often">{(c) => <Select id={c.id} size="sm" data-tip="Cut on every marker, or only every 2nd, 4th or 8th for a slower pace" value={String(s.every)} onChange={(v) => set({ every: Number(v) })} options={EVERY} />}</Field>
              <Field label="Min clip length">{(c) => <Select id={c.id} size="sm" data-tip="Cuts closer together than this are merged, so clips never flicker" value={String(s.minClipMs)} onChange={(v) => set({ minClipMs: Number(v) })} options={MIN_CLIPS} />}</Field>
            </div>
          )}
          <Strip ticks={ticks} range={range} />
        </fieldset>

        {s.cutLane !== "keep" && (
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Footage</legend>
            <Field label="Sources">
              <SegmentedControl<SourceMode>
                aria-label="Sources"
                size="sm"
                value={s.sourceMode}
                onChange={(v) => set({ sourceMode: v })}
                options={[
                  { value: "all", label: "All", tip: "Use every video and photo in the Sources panel" },
                  { value: "selected", label: `Selected (${selected.length})`, disabled: selected.length === 0, tip: selected.length === 0 ? "Select sources in the Sources panel first" : "Use only the sources selected in the Sources panel" },
                  { value: "tags", label: "By tag", disabled: allTags.length === 0, tip: allTags.length === 0 ? "Tag some sources first to use this" : "Use only sources with the tags you choose below" },
                ]}
              />
            </Field>
            {s.sourceMode === "tags" && (
              <div className={styles.chips}>
                {allTags.map((t) => (
                  <button key={t} type="button" className={cx(styles.chip, s.tags.includes(t) && styles.chipOn)} aria-pressed={s.tags.includes(t)} data-tip={s.tags.includes(t) ? `Stop using sources tagged "${t}"` : `Use sources tagged "${t}"`} onClick={() => set({ tags: s.tags.includes(t) ? s.tags.filter((x) => x !== t) : [...s.tags, t] })}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            <Field label="Distribute them">
              {(c) => <Select<Distribution> id={c.id} size="sm" data-tip="How the footage is handed out to the cuts" value={s.distribution} onChange={(v) => set({ distribution: v })} options={DISTRIBUTIONS.map((d) => ({ value: d.value, label: d.label }))} />}
            </Field>
            <span className={styles.note}>{DISTRIBUTIONS.find((d) => d.value === s.distribution)?.tip}</span>
            {s.distribution === "oneClip" && (
              <Field label="Which clip">
                {(c) => <Select id={c.id} size="sm" data-tip="The one video every cut comes from" value={oneValue} disabled={videos.length === 0} onChange={(v) => set({ oneSource: v })} options={videos.length ? videos.map((v) => ({ value: v.path, label: shown(v.path) })) : [{ value: "", label: "No videos" }]} />}
              </Field>
            )}
            {waiting && <span className={styles.note}>Finding the moments in your footage…</span>}
            <Switch checked={s.mirror} onChange={(v) => set({ mirror: v })} label="Mirror edges" tip="Where a zoomed or moved clip leaves the frame, show the picture mirrored instead of empty space" />
          </fieldset>
        )}

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Reacts to</legend>
          <div className={styles.grid}>
            <Field label="Effects">{(c) => <Select id={c.id} size="sm" data-tip="A set of effects that pulse with the music across this section; they live on a 'Section styles' adjustment track" value={s.stackId} onChange={(v) => set({ stackId: v })} options={stackOptions} />}</Field>
            <Field label="Follows">{(c) => <Select id={c.id} size="sm" data-tip="Which hits the effects pulse on" disabled={s.stackId === "none"} value={s.hitLane} onChange={(v) => set({ hitLane: v as StyleSettings["hitLane"] })} options={HIT_LANE_OPTIONS} />}</Field>
          </div>
          {s.stackId !== "none" && (
            <>
              <span className={styles.note}>Pulsing on {HIT_LANES.find((l) => l.value === hitLane)?.label.toLowerCase()}.</span>
              <Field label="Strength">{(c) => <Slider id={c.id} aria-label="Strength" data-tip="How hard the effects hit, from subtle to full" min={0.1} max={1} step={0.05} value={s.strength} onChange={(v) => set({ strength: v })} format={(v) => `${Math.round(v * 100)}%`} />}</Field>
            </>
          )}
          <Field label="Transition between cuts">
            {(c) => <Select id={c.id} size="sm" data-tip="How each new clip arrives from the one before it" value={s.transition} onChange={(v) => set({ transition: v as StyleSettings["transition"] })} options={TRANSITION_KINDS.map((k) => ({ value: k, label: TRANSITION_LABELS[k] }))} />}
          </Field>
          {s.transition !== "cut" && (
            <Field label="Transition length">{(c) => <Slider id={c.id} aria-label="Transition length" data-tip="How long the transition lasts; keep it short for fast cuts" min={50} max={600} step={10} value={s.transitionMs} onChange={(v) => set({ transitionMs: v })} format={(v) => `${v} ms`} />}</Field>
          )}
        </fieldset>

        {plan?.problem && (
          <Banner tone="info" title="Heads up">
            {plan.problem}.
          </Banner>
        )}
        {problem && (
          <Banner tone="danger" title="Couldn't apply">
            {problem}
          </Banner>
        )}

        <div className={styles.footer}>
          <span className={styles.summary} aria-live="polite" data-tip="What Apply will do; pinned clips stay and one Undo reverts it">
            {plan && !plan.problem ? plan.summary : "Nothing to apply yet"}
          </span>
          <Button variant="secondary" data-tip="Close without changing the edit" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-tip={canApply ? "Cut this part, add the effects and set the transitions; pinned clips stay (you can undo)" : (plan?.problem ?? "Analyze the song first")} onClick={apply} disabled={!canApply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A cut-density strip over the range: one tick per cut. */
function Strip({ ticks, range }: { ticks: number[]; range: Range }) {
  const span = Math.max(1, range.toMs - range.fromMs);
  const xs = useMemo(() => [...new Set(ticks.map((t) => Math.min(299, Math.floor(((t - range.fromMs) / span) * 300))))], [ticks, range.fromMs, span]);
  return (
    <svg className={styles.strip} viewBox="0 0 300 10" preserveAspectRatio="none" role="img" aria-label={`${ticks.length} cuts`} data-tip={`${ticks.length} cuts across this part`}>
      {xs.map((x) => (
        <rect key={x} className={styles.tick} x={x} y={0} width={0.9} height={10} />
      ))}
    </svg>
  );
}
