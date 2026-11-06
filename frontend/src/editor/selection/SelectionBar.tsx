/**
 * The selection bar (Phase 10 SPEC §5.5): the few top-level controls of what
 * is selected, and compact click-in chips for its constituent panels. It
 * replaces the permanent Inspector column.
 */
import { useMemo, useState } from "react";
import { IconButton, MenuButton, SegmentedControl, Select, Slider, ColorSwatchPicker, ToolClickIn, toolDrawerId, useClickIn, cx } from "@/components";
import type { EditClip } from "@/lib/api";
import { useElementSize } from "@/lib/useElementSize";
import { useModules } from "@/state/modules";
import { parseSpeed, serializeSpeed } from "@/viz/edit/schema";
import { findClip } from "../doc";
import { FIT_OPTIONS, FIT_TIPS } from "../inspector/SourceSection";
import { patchClip } from "../inspector/inspectorState";
import { isKeyed, paramBase } from "../inspector/paramOps";
import { PanelClickIn, panelDrawerId } from "../PanelClickIn";
import { useEditorProfile, useEditorWorkspace } from "../profileContext";
import { useEditStudio } from "../store";
import { clipLabel } from "../timeline/clipInfo";
import { deleteSelection, duplicateSelection } from "../timeline/actions";
import { clipToolChips, type ToolChip } from "../constituents/toolChips";
import { useReplaceClipSource } from "../constituents/useUseResult";
import { CLIP_CHIPS, clipSummary } from "./summaries";
import styles from "./SelectionBar.module.css";


const SPEED_PRESETS = [0.5, 1, 2] as const;

/** The selected clip's volume, speed preset and fit: the controls people reach for most. */
export function ClipQuickControls({ clip }: { clip: EditClip }) {
  const isVideo = clip.kind === "video";
  const speed = parseSpeed(clip.speed).value;
  const keyed = isKeyed(speed);
  const base = Math.round(paramBase(speed) * 100) / 100;
  const preset = !keyed && (SPEED_PRESETS as readonly number[]).includes(base) ? String(base) : "";
  return (
    <>
      {clip.kind === "color" && (
        <span className={styles.control} data-tip="The clip's colour">
          <ColorSwatchPicker aria-label="Clip colour" value={clip.color || "#000000"} onChange={(color) => patchClip(clip.id, { color }, `${clip.id}:color`)} />
        </span>
      )}
      {isVideo && (
        <span className={styles.volume}>
          <Slider
            data-tip="This clip's sound level in the export; 100% is the original. The preview is silent."
            aria-label="Volume"
            min={0}
            max={2}
            step={0.05}
            value={clip.volume}
            onChange={(volume) => patchClip(clip.id, { volume }, `${clip.id}:volume`)}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </span>
      )}
      {isVideo && (
        <SegmentedControl
          size="sm"
          aria-label="Speed preset"
          value={preset as "0.5" | "1" | "2" | ""}
          disabled={keyed}
          onChange={(v) => v && patchClip(clip.id, { speed: serializeSpeed(Number(v)) }, "")}
          options={[
            { value: "0.5", label: "0.5×", tip: keyed ? "The speed changes over time; edit it in Speed" : "Play at half speed" },
            { value: "1", label: "1×", tip: keyed ? "The speed changes over time; edit it in Speed" : "Play at normal speed" },
            { value: "2", label: "2×", tip: keyed ? "The speed changes over time; edit it in Speed" : "Play at double speed" },
          ]}
        />
      )}
      {(isVideo || clip.kind === "image") && (
        <Select
          size="sm"
          className={styles.fit}
          data-tip={FIT_TIPS[clip.fit || "fill"]}
          aria-label="Fit"
          value={clip.fit || "fill"}
          onChange={(fit) => patchClip(clip.id, { fit }, "")}
          options={FIT_OPTIONS}
        />
      )}
    </>
  );
}

/** The selected clip's constituent chips for the profile (own panels, then the profile's extras), each with its summary. */
export function useClipChips(clip: EditClip): { panel: string; summary: string }[] {
  const profile = useEditorProfile();
  const ws = useEditorWorkspace();
  const mattes = useEditStudio((s) => s.mattes);
  return useMemo(() => {
    const own = CLIP_CHIPS.filter((c) => c.kinds.includes(clip.kind)).map((c) => ({ panel: c.panel, summary: clipSummary(c.panel, clip, { mattes }) }));
    const extra = (profile.clipChips ?? []).filter((c) => !c.kinds || c.kinds.includes(clip.kind)).map((c) => ({ panel: c.panel, summary: c.summary?.(clip) ?? "" }));
    return [...own, ...extra].filter((c) => !!ws?.getPanel(c.panel));
  }, [clip, mattes, profile.clipChips, ws]);
}

export function SelectionBar() {
  const profile = useEditorProfile();
  const selection = useEditStudio((s) => s.selection);
  const doc = useEditStudio((s) => s.history?.present ?? null);
  const clips = useMemo(() => (doc && selection?.kind === "clips" ? selection.ids.map((id) => findClip(doc, id)?.clip).filter((c): c is EditClip => !!c) : NO_CLIPS), [doc, selection]);

  let body = <span className={styles.hint}>Select a clip on the timeline to edit it.</span>;
  if (selection?.kind === "clips" && clips.length === 1) {
    body = <SingleClip clip={clips[0] as EditClip} />;
  } else if (selection?.kind === "clips" && clips.length > 1) {
    body = (
      <>
        <span className={styles.name}>{`${clips.length} clips selected`}</span>
        <IconButton size="sm" icon="copy" label="Duplicate" data-tip="Copy the selected clips right after themselves" onClick={() => void duplicateSelection()} />
        <IconButton size="sm" icon="trash-2" label="Delete" data-tip="Remove the selected clips from the edit (you can undo it)" onClick={() => void deleteSelection()} />
      </>
    );
  } else if (selection?.kind === "track") {
    body = (
      <>
        <PanelClickIn panel="track" className={styles.chip} summary={profileTrackName(selection.id)} />
      </>
    );
  } else if (selection?.kind === "song") {
    body = <OpenPanel label="Music" panel={profile.songPanel ?? "music"} />;
  } else if (selection?.kind === "markers" && profile.markersPanel) {
    body = <OpenPanel label={`${selection.ids.length} ${selection.ids.length === 1 ? "marker" : "markers"} selected`} panel={profile.markersPanel} />;
  }

  return (
    <div className={styles.bar} role="group" aria-label="Selection">
      {body}
    </div>
  );
}

const NO_CLIPS: EditClip[] = [];

function profileTrackName(id: string): string {
  return useEditStudio.getState().history?.present.tracks.find((t) => t.id === id)?.name ?? "";
}

/** A label and a button that opens a panel whose launcher lives elsewhere (the rail). */
function OpenPanel({ label, panel }: { label: string; panel: string }) {
  const { open } = useClickIn();
  const def = useEditorWorkspace()?.getPanel(panel);
  return (
    <>
      <span className={styles.name}>{label}</span>
      {def && (
        <button type="button" className={cx(styles.link)} data-tip={def.tip} onClick={() => open(panelDrawerId(panel))}>
          {def.title} settings
        </button>
      )}
    </>
  );
}

/** Estimated widths (px) of a chip with icon and label, the summary text and the "More…" button. */
const CHIP_PX = (title: string) => 38 + 6.5 * title.length;
const SUMMARY_PX = (summary: string) => (summary ? 8 + 6 * summary.length : 0);
const MORE_PX = 72;

/** Which chips fit in `width` px: all with summaries, else all without, else as many as fit plus "More…". Unknown width (0) shows everything. */
export function fitChips(chips: { panel: string; summary: string; title?: string }[], width: number, titleOf: (panel: string) => string | undefined = () => undefined): { shown: number; summaries: boolean } {
  if (width <= 0) return { shown: chips.length, summaries: true };
  const label = (c: { panel: string; title?: string }) => CHIP_PX(c.title ?? titleOf(c.panel) ?? c.panel);
  const withSummary = chips.reduce((n, c) => n + label(c) + SUMMARY_PX(c.summary) + 4, 0);
  if (withSummary <= width) return { shown: chips.length, summaries: true };
  let used = 0;
  let shown = 0;
  for (const c of chips) {
    const next = used + label(c) + 4;
    const rest = chips.length - shown - 1;
    if (next + (rest > 0 ? MORE_PX : 0) > width) break;
    used = next;
    shown++;
  }
  return { shown, summaries: false };
}

/** A launcher chip in the bar: an editor panel, or a constituent tool (Upscale, Clean audio). */
type BarChip = { panel: string; summary: string; title?: string; tool?: ToolChip };

function SingleClip({ clip }: { clip: EditClip }) {
  const profile = useEditorProfile();
  const ws = useEditorWorkspace();
  const titleOf = (panel: string): string | undefined => ws?.getPanel(panel)?.title;
  const panelChips = useClipChips(clip);
  const known = useModules((s) => s.byId);
  const { onUse, dialog } = useReplaceClipSource(clip.id);
  const { open } = useClickIn();
  const [box, setBox] = useState<HTMLSpanElement | null>(null);
  const { width } = useElementSize(box);
  const chips = useMemo<BarChip[]>(() => {
    const tools = clipToolChips(clip)
      .filter((t) => !!known[t.module])
      .map((t): BarChip => ({ panel: toolDrawerId(t.module), summary: "", title: t.title, tool: t }));
    return [...panelChips, ...tools];
  }, [panelChips, clip, known]);
  const { shown: n, summaries } = fitChips(chips, width, titleOf);
  const shown = chips.slice(0, n);
  const overflow = chips.slice(n);
  const chipView = (c: BarChip, compact: boolean) =>
    c.tool ? (
      <ToolClickIn
        key={c.panel}
        host={profile.moduleId}
        module={c.tool.module}
        title={c.tool.title}
        icon={c.tool.icon}
        tip={c.tool.tip}
        inputs={clip.path ? [clip.path] : []}
        useLabel="Use for this clip"
        onUse={onUse}
        className={styles.chip}
      />
    ) : (
      <PanelClickIn key={c.panel} panel={c.panel} summary={c.summary} showSummary={!compact && summaries} className={styles.chip} />
    );
  return (
    <>
      <span className={styles.name} title={clip.path || undefined}>
        {clipLabel(clip)}
      </span>
      <ClipQuickControls clip={clip} />
      <span className={styles.chips} ref={setBox}>
        {shown.map((c) => chipView(c, false))}
        {overflow.length > 0 && (
          <>
            <MenuButton
              label="More…"
              size="sm"
              variant="ghost"
              data-tip="The rest of this clip's settings"
              items={() =>
                overflow.map((c) => ({
                  id: c.panel,
                  label: `${c.title ?? titleOf(c.panel) ?? c.panel}${c.summary ? ` · ${c.summary}` : ""}`,
                  onSelect: () => open(c.tool ? toolDrawerId(c.tool.module) : panelDrawerId(c.panel)),
                }))
              }
            />
            {/* Their drawers stay mounted; the menu opens them. */}
            <span hidden>{overflow.map((c) => chipView(c, true))}</span>
          </>
        )}
      </span>
      <IconButton size="sm" icon="trash-2" label="Delete" data-tip="Remove the selected clip from the edit (you can undo it)" onClick={() => void deleteSelection()} />
      {dialog}
    </>
  );
}
