/** The Inspector when nothing is selected: aspect, fps, background, Look, export size, seed (§14.8). */
import { useMemo } from "react";
import { Button, ColorSwatchPicker, Section, Select, Stepper } from "@/components";
import { LOOK_POST_TYPES, parseLook, serializeLook } from "@/viz/edit/schema";
import { ASPECTS } from "@/viz/edit/types";
import { EffectsStack } from "./EffectsStack";
import { editDoc } from "./inspectorState";
import { applyLook, currentLook, LOOKS, type LookId } from "./templates";
import { useProject } from "../store";
import styles from "./inspector.module.css";

const FPS_OPTIONS = [
  { value: "30", label: "30 fps" },
  { value: "60", label: "60 fps" },
];
const EXPORT_OPTIONS = [
  { value: "720", label: "720p" },
  { value: "1080", label: "1080p" },
  { value: "1440", label: "1440p" },
];

export const MAX_SEED = 2_147_483_647;

export function ProjectInspector() {
  const project = useProject();
  const lookRaw = project?.look ?? "";
  const look = useMemo(() => parseLook(lookRaw).value, [lookRaw]);
  if (!project) return null;
  const set = (patch: Partial<typeof project>, key = "") => editDoc((p) => ({ ...p, ...patch }), key);
  const preset = currentLook(look);
  return (
    <div className={styles.root} aria-label="Project inspector">
      <div className={styles.head}>
        <h2 className={styles.title}>Edit settings</h2>
      </div>
      <Section label="Frame">
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.label}>Aspect</span>
            <Select size="sm" aria-label="Aspect" value={project.aspect} onChange={(aspect) => set({ aspect })} options={ASPECTS.map((a) => ({ value: a, label: a }))} />
          </div>
          <p className={styles.hint}>Changing the aspect keeps your clips; the preview re-fits them.</p>
          <div className={styles.row}>
            <span className={styles.label}>Frame rate</span>
            <Select size="sm" aria-label="Frame rate" value={String(project.fps)} onChange={(v) => set({ fps: Number(v) })} options={FPS_OPTIONS} />
          </div>
          <p className={styles.warn}>Changing the frame rate prepares every source video again.</p>
          <div className={styles.colorRow}>
            <span className={styles.label}>Background</span>
            <ColorSwatchPicker aria-label="Background colour" value={project.background || "#000000"} onChange={(background) => set({ background }, "background")} />
          </div>
        </div>
      </Section>

      <Section label="Look">
        <div className={styles.row}>
          <span className={styles.label}>Preset</span>
          <Select
            size="sm"
            aria-label="Look preset"
            value={preset}
            onChange={(id) => {
              if (id !== "custom") set({ look: serializeLook(applyLook(look, id as LookId)) });
            }}
            options={[...LOOKS.map((l) => ({ value: l.id as string, label: l.label })), ...(preset === "custom" ? [{ value: "custom", label: "Custom" }] : [])]}
          />
        </div>
      </Section>
      <EffectsStack
        label="Look effects"
        posts={look}
        types={LOOK_POST_TYPES}
        templates={false}
        allowKeys={false}
        clipTimeMs={0}
        onChange={(next, key) => set({ look: serializeLook(next) }, key ? `look:${key}` : "")}
      />

      <Section label="Export">
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.label}>Size</span>
            <Select size="sm" aria-label="Export size" value={String(project.exportHeight)} onChange={(v) => set({ exportHeight: Number(v) })} options={EXPORT_OPTIONS} />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Seed</span>
            <Stepper aria-label="Seed" min={0} max={MAX_SEED} step={1} value={project.seed} onChange={(seed) => set({ seed: Math.round(seed) }, "seed")} />
          </div>
          <Button size="sm" icon="refresh-cw" onClick={() => set({ seed: Math.floor(Math.random() * MAX_SEED) })}>
            New seed
          </Button>
          <p className={styles.hint}>The seed decides the random-looking parts of effects, so the same seed gives the same frames.</p>
        </div>
      </Section>
    </div>
  );
}
