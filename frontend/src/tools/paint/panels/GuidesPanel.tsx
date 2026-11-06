import { runtime, type GuidesState } from "../engine-adapter";
import { useEditor } from "../context";
import { usePaintUI } from "../store";
import { Segmented, Stepper, Toggle } from "../ui";
import styles from "./panels.module.css";

/** Drawing guides: symmetry, grid, perspective, isometric. Saved with the painting. */
export function GuidesPanel() {
  const { engine } = useEditor();
  const g = usePaintUI((s) => s.guides);
  const setGuides = usePaintUI((s) => s.setGuides);
  const change = (p: Partial<GuidesState>) => {
    setGuides(p);
    runtime.applyGuides(engine, { ...usePaintUI.getState().guides });
  };
  return (
    <div className={styles.stack} data-testid="guides-panel">
      <div className={styles.section}>
        <h4 className={styles.h}>Symmetry</h4>
        <Segmented
          label="Symmetry"
          value={g.symmetry}
          options={[
            { value: "off", label: "Off", tip: "No symmetry" },
            { value: "vertical", label: "Vertical", tip: "Mirror left and right" },
            { value: "horizontal", label: "Horizontal", tip: "Mirror top and bottom" },
            { value: "quadrant", label: "Quadrant", tip: "Mirror both ways" },
            { value: "radial", label: "Radial", tip: "Repeat around the centre" },
          ]}
          onChange={(symmetry) => change({ symmetry })}
        />
        {g.symmetry === "radial" ? <Stepper label="Segments" value={g.radialCount} min={2} max={16} onChange={(radialCount) => change({ radialCount })} /> : null}
      </div>
      <div className={styles.section}>
        <h4 className={styles.h}>Grid and perspective</h4>
        <Toggle label="2D grid" tip="Show a square grid" checked={g.grid} onChange={(grid) => change({ grid })} />
        <Toggle label="Isometric" tip="Show isometric guide lines" checked={g.isometric} onChange={(isometric) => change({ isometric })} />
        <Segmented
          label="Perspective"
          value={String(g.perspective) as "0" | "1" | "2" | "3"}
          options={[
            { value: "0", label: "Off", tip: "No perspective guide" },
            { value: "1", label: "1 point", tip: "One vanishing point" },
            { value: "2", label: "2 points", tip: "Two vanishing points" },
            { value: "3", label: "3 points", tip: "Three vanishing points" },
          ]}
          onChange={(v) => change({ perspective: Number(v) as GuidesState["perspective"] })}
        />
      </div>
    </div>
  );
}
