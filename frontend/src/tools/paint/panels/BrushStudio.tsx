import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { toast } from "@/components/toast";
import { PaintService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { BrushPreset, Curve, Dynamics } from "@/paint/brushes/schema";
import { cloneBrush, DYNAMICS_INPUTS, DYNAMICS_TARGETS } from "../brushDefaults";
import { hsvToHex } from "../color";
import { runtime } from "../engine-adapter";
import { usePaintUI } from "../store";
import { HSlider, IconButton, TextButton, Toggle } from "../ui";
import styles from "./panels.module.css";
import { STUDIO_GROUPS, STUDIO_PARAMS, getPath, normaliseCurve, setPath } from "./studioParams";

export const USER_SET = "my-brushes";

/** A curve editor: drag points, click to add one, double-click a point to remove it. */
export function CurveEditor({ curve, onChange, label }: { curve: Curve; onChange(c: Curve): void; label: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pos = (e: PointerEvent): [number, number] => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !r.width) return [0, 0];
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const pts = normaliseCurve(curve);
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x * 100} ${(1 - y) * 100}`).join(" ");
  return (
    <svg
      ref={ref}
      className={styles.curve}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="group"
      aria-label={label}
      data-tip="Drag points to shape the response; click to add a point; double-click a point to remove it"
      onPointerDown={(e) => {
        if ((e.target as Element).tagName === "circle") return;
        const [x, y] = pos(e);
        const next = normaliseCurve([...pts, [x, y]]);
        onChange(next);
        setDrag(next.findIndex((p) => Math.abs(p[0] - x) < 0.002));
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const [x, y] = pos(e);
        const next = pts.map((p, i) => (i === drag ? ([i === 0 ? 0 : i === pts.length - 1 ? 1 : x, y] as [number, number]) : p));
        onChange(drag === 0 || drag === pts.length - 1 ? next : normaliseCurve(next));
      }}
      onPointerUp={() => setDrag(null)}
    >
      <path d={path} className={styles.curveLine} vectorEffect="non-scaling-stroke" />
      {pts.map(([x, y], i) => (
        <circle
          key={i}
          cx={x * 100}
          cy={(1 - y) * 100}
          r="3"
          className={styles.curvePt}
          tabIndex={0}
          role="slider"
          aria-label={`${label} point ${i + 1}`}
          aria-valuenow={Math.round(y * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-tip="Arrow keys move this point up or down"
          onPointerDown={(e) => {
            e.stopPropagation();
            setDrag(i);
            ref.current?.setPointerCapture?.(e.pointerId);
          }}
          onDoubleClick={() => pts.length > 2 && i !== 0 && i !== pts.length - 1 && onChange(pts.filter((_, j) => j !== i))}
          onKeyDown={(e) => {
            const d = e.key === "ArrowUp" ? 0.02 : e.key === "ArrowDown" ? -0.02 : 0;
            if (!d) return;
            e.preventDefault();
            onChange(pts.map((p, j) => (j === i ? ([p[0], Math.min(1, Math.max(0, p[1] + d))] as [number, number]) : p)));
          }}
        />
      ))}
    </svg>
  );
}

/** The live drawing pad: scribble with the brush being edited. */
function Pad({ brush }: { brush: BrushPreset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pts = useRef<Array<{ x: number; y: number; pressure: number }>>([]);
  const down = useRef(false);
  const draw = () => {
    const c = ref.current;
    if (!c) return;
    const ink = hsvToHex(usePaintUI.getState().color);
    runtime.renderBrushStroke(brush, c, { color: ink, ...(pts.current.length ? { points: pts.current } : {}) });
  };
  useEffect(draw);
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / (r.width || 1)) * e.currentTarget.width, y: ((e.clientY - r.top) / (r.height || 1)) * e.currentTarget.height, pressure: e.pointerType === "mouse" ? 0.7 : e.pressure || 0.5 };
  };
  return (
    <canvas
      ref={ref}
      className={styles.pad}
      width={560}
      height={240}
      aria-label="Drawing pad: scribble to try the brush"
      data-tip="Scribble here to try the brush; it redraws as you change settings"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        down.current = true;
        pts.current = [at(e)];
      }}
      onPointerMove={(e) => {
        if (!down.current) return;
        pts.current.push(at(e));
        draw();
      }}
      onPointerUp={() => (down.current = false)}
      onDoubleClick={() => {
        pts.current = [];
        draw();
      }}
    />
  );
}

/** Brush Studio: every schema parameter, grouped, with a live pad and curve editors for dynamics. */
export function BrushStudio({ initial, onClose }: { initial: BrushPreset; onClose(): void }) {
  const [b, setB] = useState<BrushPreset>(() => cloneBrush(initial));
  const kind = usePaintUI((s) => (s.tool === "smudge" ? "smudge" : s.tool === "eraser" ? "eraser" : "brush"));
  const setBrush = usePaintUI((s) => s.setBrush);
  const [saving, setSaving] = useState(false);
  const tipChoices = useMemo(() => runtime.assetChoices("tip"), []);
  const grainChoices = useMemo(() => runtime.assetChoices("grain"), []);

  const update = (next: BrushPreset) => {
    setB(next);
    setBrush(kind, next); // the brush in hand changes live
  };
  const set = (path: string, v: unknown) => update(setPath(b, path, v));

  const save = async () => {
    setSaving(true);
    try {
      const fresh = b.set === USER_SET ? b : { ...b, set: USER_SET, id: `${b.id}-${Date.now().toString(36)}` };
      await PaintService.SaveBrush(USER_SET, JSON.stringify(fresh));
      setB(fresh);
      setBrush(kind, fresh);
      toast({ title: `Saved “${fresh.name}” to My brushes`, tone: "success" });
    } catch (e) {
      toast({ title: "Couldn't save the brush", description: toAppError(e).message, tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const dyn = (i: number, p: Partial<Dynamics>) => set("dynamics", b.dynamics.map((d, j) => (j === i ? { ...d, ...p } : d)));

  return (
    <div className={styles.stack} data-testid="brush-studio">
      <div className={styles.row}>
        <input className={styles.nameField} aria-label="Brush name" data-tip="Name of this brush" value={b.name} onChange={(e) => set("name", e.target.value)} />
      </div>
      <Pad brush={b} />
      <div className={styles.row}>
        <TextButton primary icon="check" tip="Save to the My brushes set (a copy if this brush came from another set)" disabled={saving} reason="Saving…" onClick={() => void save()}>
          Save
        </TextButton>
        <TextButton tip="Throw away the changes made in this session" onClick={() => update(cloneBrush(initial))}>
          Revert
        </TextButton>
        <span className={styles.grow} />
        <TextButton tip="Back to the brush library" onClick={onClose}>
          Done
        </TextButton>
      </div>

      {STUDIO_GROUPS.map((g) => (
        <section key={g} className={styles.section} aria-label={g}>
          <h4 className={styles.h}>{g}</h4>
          {STUDIO_PARAMS.filter((p) => p.group === g).map((p) => {
            const v = getPath(b, p.path);
            if (p.kind === "number")
              return <HSlider key={p.path} label={p.label} tip={p.tip} min={p.min ?? 0} max={p.max ?? 1} step={p.step ?? 0.01} value={typeof v === "number" ? v : 0} onChange={(x) => set(p.path, x)} />;
            if (p.kind === "toggle") return <Toggle key={p.path} label={p.label} tip={p.tip} checked={v === true} onChange={(x) => set(p.path, x)} />;
            const choices = p.assets === "tip" ? tipChoices : p.assets === "grain" ? grainChoices : (p.choices ?? []);
            return (
              <label key={p.path} className={styles.row}>
                <span className={styles.grow}>{p.label}</span>
                <select className={styles.select} aria-label={p.label} data-tip={p.tip} value={String(v ?? "")} onChange={(e) => set(p.path, e.target.value)}>
                  {!choices.some((c) => c.value === v) ? <option value={String(v ?? "")}>{String(v || "None")}</option> : null}
                  {choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {g === "Shape" ? (
            <Toggle label="Dual tip" tip="A second tip masks the first, as in Photoshop's dual brush" checked={b.dual !== null} onChange={(on) => set("dual", on ? { ...b.tip } : null)} />
          ) : null}
        </section>
      ))}

      <section className={styles.section} aria-label="Dynamics">
        <h4 className={styles.h}>Dynamics</h4>
        {b.dynamics.map((d, i) => (
          <div key={i} className={styles.dyn} data-testid={`dynamics-${i}`}>
            <div className={styles.row}>
              <select className={styles.select} aria-label="Dynamics input" data-tip="What drives it" value={d.input} onChange={(e) => dyn(i, { input: e.target.value as Dynamics["input"] })}>
                {DYNAMICS_INPUTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <span>→</span>
              <select className={styles.select} aria-label="Dynamics target" data-tip="What it changes" value={d.target} onChange={(e) => dyn(i, { target: e.target.value as Dynamics["target"] })}>
                {DYNAMICS_TARGETS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <span className={styles.grow} />
              <IconButton icon="trash" label="Remove this dynamic" size="sm" onClick={() => set("dynamics", b.dynamics.filter((_, j) => j !== i))} />
            </div>
            <HSlider label="Amount" tip="Fraction of the target's range the input can move it" min={0} max={1} step={0.01} value={d.amount} onChange={(x) => dyn(i, { amount: x })} />
            <CurveEditor label={`${d.input} to ${d.target} curve`} curve={d.curve} onChange={(c) => dyn(i, { curve: c })} />
          </div>
        ))}
        <TextButton icon="plus" tip="Make another input drive a setting" onClick={() => set("dynamics", [...b.dynamics, { input: "pressure", target: "size", amount: 0.5, curve: [[0, 0], [1, 1]] }])}>
          Add dynamic
        </TextButton>
      </section>

      {b.credit || b.license ? (
        <p className={styles.layerMeta}>
          {b.credit} {b.license ? `· ${b.license}` : ""}
        </p>
      ) : null}
      {b.fidelity.length ? (
        <ul className={styles.fidelity} aria-label="Fidelity notes">
          {b.fidelity.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
