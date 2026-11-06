/**
 * The Adjustments popover (SPEC §1.1): each adjustment opens a small
 * device-style panel with its controls, shows the result live on the layer,
 * and ends with Apply or Cancel. "Pencil" paints the adjustment in with the
 * current brush instead of applying it everywhere. Liquify is a brush mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { defaultParams, usePaintUI } from "./store";
import type { AdjustEffect, AdjustHandle, AdjustmentInfo, LiquifyHandle, LiquifyMode } from "./engine-adapter";
import { Device, FieldRow, Island, Segmented, Stepper, TextButton, Toggle, HSlider } from "./ui";
import type { LabParams } from "@/paint/lab/types";
import ed from "./editor.module.css";

/** One running adjustment, owned by the editor so the canvas input can reach it. */
export interface AdjustRun {
  info: AdjustmentInfo;
  handle: AdjustHandle;
  /** Liquify's displacement field. */
  field?: LiquifyHandle;
  /** The current effect, kept fresh by the panel (Pencil mode applies it under each stroke). */
  effect: AdjustEffect | null;
}

/** Calls `fn` at most once per animation frame with the latest argument. */
export function useFrameThrottle<T>(fn: (v: T) => void): (v: T) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pending = useRef<{ v: T } | null>(null);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return useCallback((v: T) => {
    pending.current = { v };
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p) fnRef.current(p.v);
    });
  }, []);
}

const LIQUIFY_MODES: Array<{ value: LiquifyMode; label: string; tip: string }> = [
  { value: "push", label: "Push", tip: "Drag the pixels along with the brush" },
  { value: "twirl", label: "Twirl", tip: "Swirl the pixels under the brush" },
  { value: "pinch", label: "Pinch", tip: "Pull the pixels toward the brush centre" },
  { value: "expand", label: "Expand", tip: "Push the pixels away from the brush centre" },
  { value: "crystals", label: "Crystals", tip: "Shove the pixels in jagged facets" },
];

export interface AdjustPanelProps {
  run: AdjustRun;
  onApply(): void;
  onCancel(): void;
  /** Liquify's current mode and strength (the canvas drag reads them). */
  liquify: MutableRefObject<{ mode: LiquifyMode; strength: number }>;
}

export function AdjustPanel({ run, onApply, onCancel, liquify }: AdjustPanelProps) {
  const { info, handle } = run;
  const tool = usePaintUI((s) => s.tool);
  const size = usePaintUI((s) => s.size);
  const setSize = usePaintUI((s) => s.setSize);
  const setTool = usePaintUI((s) => s.setTool);
  const pencil = tool === "pencil";
  const [values, setValues] = useState<LabParams>(() => (info.tool ? defaultParams(info.tool) : {}));
  const [mode, setMode] = useState<LiquifyMode>("push");
  const [strength, setStrength] = useState(0.5);
  const before = useRef(tool);

  const effect = useMemo(() => (info.build ? info.build(values) : null), [info, values]);
  const show = useFrameThrottle<AdjustEffect>((e) => handle.preview(e));
  useEffect(() => {
    run.effect = effect;
    if (!effect) return;
    if (pencil) handle.render(effect);
    else show(effect);
  }, [effect, pencil, handle, run, show]);
  useEffect(() => {
    liquify.current = { mode, strength };
  }, [liquify, mode, strength]);

  // Pencil mode: the brush paints the adjustment in. Leaving it puts the previous tool back.
  const togglePencil = (on: boolean) => {
    if (on) {
      before.current = tool;
      handle.cancel();
      setTool("pencil");
    } else {
      setTool(before.current === "pencil" ? "brush" : before.current);
    }
  };

  if (info.liquify) {
    return (
      <Island label="Liquify" className={ed.adjust} data-testid="adjust-panel" data-adjust="liquify">
        <strong className={ed.adjustTitle}>Liquify</strong>
        <Segmented<LiquifyMode> label="Liquify mode" value={mode} options={LIQUIFY_MODES} onChange={setMode} />
        <FieldRow label="Size">
          <Stepper label="Liquify size" value={size} min={8} max={400} step={8} unit="px" onChange={setSize} />
        </FieldRow>
        <HSlider label="Strength" value={strength} min={0.05} max={1} step={0.05} tip="How far each pass moves the pixels" format={(v) => `${Math.round(v * 100)}%`} onChange={setStrength} />
        <div className={ed.adjustActions}>
          <TextButton primary tip="Keep the warp (one undo step)" onClick={onApply}>
            Apply
          </TextButton>
          <TextButton tip="Throw the warp away" onClick={onCancel}>
            Cancel
          </TextButton>
        </div>
      </Island>
    );
  }
  if (!info.tool) return null;
  return (
    <Island label={info.label} className={ed.adjust} data-testid="adjust-panel" data-adjust={info.id}>
      <Device
        info={info.tool}
        params={values}
        onParam={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
        onParams={setValues}
        seed={{ seed: 1, locked: false }}
        onToggleSeedLock={() => undefined}
        onReroll={() => undefined}
        enabled
        onToggleEnabled={() => undefined}
        origins={[]}
        extra={
          <>
            <Toggle label="Pencil" tip="Paint the adjustment in with the brush instead of changing the whole layer" checked={pencil} onChange={togglePencil} />
            <TextButton primary tip={pencil ? "Done painting this adjustment" : "Apply to the layer (one undo step)"} onClick={onApply}>
              {pencil ? "Done" : "Apply"}
            </TextButton>
            <TextButton tip="Leave the layer as it was" onClick={onCancel}>
              Cancel
            </TextButton>
          </>
        }
      />
    </Island>
  );
}
