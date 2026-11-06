import { useRef, useState, type PointerEvent } from "react";
import { cx } from "@/components/cx";
import { DEFAULT_PALETTES, harmonyColors, hexToHsv, hexToRgb, hsvToHex, hsvToRgb, hueGradient, isHex, rgbToHex, rgbToHsv, squareGradient, type Harmony, type Hsv } from "../color";
import { useEditor } from "../context";
import { usePaintUI } from "../store";
import { HSlider, IconButton, Segmented } from "../ui";
import styles from "./panels.module.css";

const HARMONIES: Array<{ value: Harmony; label: string; tip: string }> = [
  { value: "complementary", label: "Comp", tip: "The opposite colour" },
  { value: "analogous", label: "Analog", tip: "Neighbours on the wheel" },
  { value: "triadic", label: "Triad", tip: "Three colours spaced evenly" },
  { value: "split", label: "Split", tip: "The two colours beside the opposite" },
  { value: "tetradic", label: "Tetrad", tip: "Four colours spaced evenly" },
];

function Swatch({ hex, onPick, pressed }: { hex: string; onPick(): void; pressed?: boolean }) {
  return <button type="button" className={styles.swatch} style={{ ["--sw" as string]: hex }} aria-label={`Colour ${hex}`} aria-pressed={pressed} data-tip={hex} onClick={onPick} />;
}

/** Drag inside an element, reporting 0..1 positions. */
function useDrag(onMove: (x: number, y: number) => void, onEnd?: () => void) {
  const el = useRef<HTMLDivElement>(null);
  const on = useRef(false);
  const at = (e: PointerEvent) => {
    const r = el.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    onMove(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  return {
    ref: el,
    onPointerDown: (e: PointerEvent) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      on.current = true;
      at(e);
    },
    onPointerMove: (e: PointerEvent) => on.current && at(e),
    onPointerUp: () => {
      on.current = false;
      onEnd?.();
    },
  };
}

/** Colour: value square + hue bar, classic sliders, hex, harmony, palettes, recent, eyedropper. */
export function ColorPanel() {
  const { engine } = useEditor();
  const color = usePaintUI((s) => s.color);
  const secondary = usePaintUI((s) => s.secondary);
  const recent = usePaintUI((s) => s.recentColors);
  const setColor = usePaintUI((s) => s.setColor);
  const setColorHex = usePaintUI((s) => s.setColorHex);
  const commit = usePaintUI((s) => s.commitColor);
  const swap = usePaintUI((s) => s.swapColors);
  const setTool = usePaintUI((s) => s.setTool);
  const [harmony, setHarmony] = useState<Harmony>("complementary");
  const [tab, setTab] = useState<"sliders" | "palettes">("sliders");
  const hex = hsvToHex(color);
  const [r, g, b] = hsvToRgb(color).map(Math.round) as [number, number, number];
  const [hexText, setHexText] = useState<string | null>(null);
  const docPalette = engine.doc.palette ?? [];

  const sv = useDrag((x, y) => setColor({ ...color, s: x, v: 1 - y }), commit);
  const hue = useDrag((x) => setColor({ ...color, h: x * 360 }), commit);
  const set = (c: Hsv) => setColor(c);
  const setRgb = (nr: number, ng: number, nb: number) => set(rgbToHsv(nr, ng, nb));
  const pick = (h: string) => {
    setColorHex(h);
    commit();
  };

  return (
    <div className={styles.stack} data-testid="color-panel">
      <div className={styles.row}>
        <span className={styles.current} style={{ ["--p-current" as string]: hex }} aria-hidden="true" />
        <input
          className={styles.nameField}
          aria-label="Hex colour"
          data-tip="The colour as #rrggbb; type to set it"
          value={hexText ?? hex}
          onChange={(e) => {
            setHexText(e.target.value);
            if (isHex(e.target.value)) setColorHex(e.target.value);
          }}
          onBlur={() => {
            setHexText(null);
            commit();
          }}
        />
        <IconButton icon="eyedropper" label="Pick a colour from the canvas" kbd="I" onClick={() => setTool("eyedropper")} />
        <IconButton icon="undo" label="Swap with the second colour" onClick={swap} />
        <span className={styles.swatches}>
          <Swatch hex={hsvToHex(secondary)} onPick={swap} />
        </span>
      </div>

      <div
        ref={sv.ref}
        className={styles.sv}
        style={{ background: squareGradient(color.h) }}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(color.s * 100)}%, brightness ${Math.round(color.v * 100)}%`}
        data-tip="Drag: left to right is saturation, bottom to top is brightness"
        onPointerDown={sv.onPointerDown}
        onPointerMove={sv.onPointerMove}
        onPointerUp={sv.onPointerUp}
        onKeyDown={(e) => {
          const d = e.shiftKey ? 0.1 : 0.02;
          const m: Record<string, Hsv> = { ArrowRight: { ...color, s: Math.min(1, color.s + d) }, ArrowLeft: { ...color, s: Math.max(0, color.s - d) }, ArrowUp: { ...color, v: Math.min(1, color.v + d) }, ArrowDown: { ...color, v: Math.max(0, color.v - d) } };
          const n = m[e.key];
          if (n) {
            e.preventDefault();
            set(n);
          }
        }}
      >
        <span className={styles.svDot} style={{ left: `${color.s * 100}%`, top: `${(1 - color.v) * 100}%` }} />
      </div>
      <div
        ref={hue.ref}
        className={styles.hue}
        style={{ background: hueGradient() }}
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(color.h)}
        data-tip="Hue"
        onPointerDown={hue.onPointerDown}
        onPointerMove={hue.onPointerMove}
        onPointerUp={hue.onPointerUp}
        onKeyDown={(e) => {
          const d = e.shiftKey ? 15 : 3;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") set({ ...color, h: (color.h + d) % 360 });
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set({ ...color, h: (color.h - d + 360) % 360 });
          else return;
          e.preventDefault();
        }}
      >
        <span className={styles.hueDot} style={{ left: `${(color.h / 360) * 100}%` }} />
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Colour views">
        {(["sliders", "palettes"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={styles.tab} data-tip={t === "sliders" ? "Classic sliders and harmony" : "Palettes and recent colours"} onClick={() => setTab(t)}>
            {t === "sliders" ? "Classic" : "Palettes"}
          </button>
        ))}
      </div>

      {tab === "sliders" ? (
        <>
          <div className={styles.section}>
            <HSlider label="Hue" min={0} max={360} step={1} value={Math.round(color.h)} onChange={(h) => set({ ...color, h })} />
            <HSlider label="Saturation" min={0} max={100} step={1} value={Math.round(color.s * 100)} onChange={(s) => set({ ...color, s: s / 100 })} />
            <HSlider label="Brightness" min={0} max={100} step={1} value={Math.round(color.v * 100)} onChange={(v) => set({ ...color, v: v / 100 })} />
            <HSlider label="Red" min={0} max={255} step={1} value={r} onChange={(v) => setRgb(v, g, b)} />
            <HSlider label="Green" min={0} max={255} step={1} value={g} onChange={(v) => setRgb(r, v, b)} />
            <HSlider label="Blue" min={0} max={255} step={1} value={b} onChange={(v) => setRgb(r, g, v)} />
          </div>
          <div className={styles.section}>
            <h4 className={styles.h}>Harmony</h4>
            <Segmented<Harmony> label="Harmony" value={harmony} options={HARMONIES} onChange={setHarmony} />
            <span className={styles.swatches}>
              {[hex, ...harmonyColors(color, harmony)].map((c, i) => (
                <Swatch key={`${c}${i}`} hex={c} pressed={c === hex} onPick={() => pick(c)} />
              ))}
            </span>
          </div>
        </>
      ) : (
        <>
          {recent.length ? (
            <div className={styles.section}>
              <h4 className={styles.h}>Recent</h4>
              <span className={styles.swatches}>
                {recent.map((c) => (
                  <Swatch key={c} hex={c} pressed={c === hex} onPick={() => pick(c)} />
                ))}
              </span>
            </div>
          ) : null}
          {docPalette.length ? (
            <div className={styles.section}>
              <h4 className={styles.h}>This painting</h4>
              <span className={styles.swatches}>
                {docPalette.map((c) => (
                  <Swatch key={c} hex={c} pressed={c === hex} onPick={() => pick(c)} />
                ))}
              </span>
            </div>
          ) : null}
          {DEFAULT_PALETTES.map((p) => (
            <div key={p.name} className={cx(styles.section)}>
              <h4 className={styles.h}>{p.name}</h4>
              <span className={styles.swatches}>
                {p.colors.map((c) => (
                  <Swatch key={c} hex={c} pressed={c === hex} onPick={() => pick(c)} />
                ))}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export { hexToRgb, rgbToHex, hexToHsv };
