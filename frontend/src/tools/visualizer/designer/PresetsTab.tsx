/** Presets (SPEC.md §8.3, §6.10): live cards, "My presets" first, and Save as my preset. */
import { useEffect, useMemo, useState } from "react";
import { Button, TextField } from "@/components";
import { PresetThumbs, type ThumbItem } from "@/components/viz";
import type { Analysis } from "@/viz/analysis";
import { PRESETS } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { applyTemplate } from "./model";
import { useMyPresets } from "./myPresets";
import styles from "./designer.module.css";

export interface PresetsTabProps {
  show: Show;
  onChange(show: Show): void;
  analysis: Analysis;
  mode: "full" | "overlay";
  aspect: number;
  playheadMs: number;
  /** Engine text on (the Visualizer) or drawn by the host. */
  engineText: boolean;
  onSavePreset?(show: Show): void;
}

export function PresetsTab({ show, onChange, analysis, mode, aspect, playheadMs, engineText, onSavePreset }: PresetsTabProps) {
  const mine = useMyPresets((s) => s.items);
  const load = useMyPresets((s) => s.load);
  const rename = useMyPresets((s) => s.rename);
  const remove = useMyPresets((s) => s.remove);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo<ThumbItem[]>(() => {
    const presets = PRESETS.slice().sort((a, b) => (mode === "overlay" ? Number(!!b.overlayFirst) - Number(!!a.overlayFirst) : 0));
    const out: ThumbItem[] = [
      ...mine.map((p): ThumbItem => ({ id: `mine:${p.id}`, name: p.name, description: "Your saved design", show: p.show, kind: "mine" })),
      ...presets.map((p): ThumbItem => ({ id: p.id, name: p.name, description: p.description, show: p.show, kind: "preset" })),
    ];
    if (!show.presetId) out.unshift({ id: "custom", name: show.name || "Current design", description: "What you are editing now", show, kind: "custom" });
    return out;
  }, [mine, mode, show]);

  const selectedId = show.presetId ?? "custom";

  return (
    <div className={styles.tabBody}>
      {onSavePreset && (
        <div className={styles.saveRow}>
          {naming ? (
            <>
              <TextField
                size="sm"
                aria-label="Preset name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) {
                    onSavePreset({ ...show, name: name.trim() });
                    setNaming(false);
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setNaming(false);
                  }
                }}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!name.trim()}
                onClick={() => {
                  onSavePreset({ ...show, name: name.trim() });
                  setNaming(false);
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              icon="plus"
              onClick={() => {
                setName(show.name && !PRESETS.some((p) => p.name === show.name) ? show.name : "My preset");
                setNaming(true);
              }}
            >
              Save as my preset
            </Button>
          )}
        </div>
      )}
      <PresetThumbs
        items={items}
        analysis={analysis}
        timeMs={playheadMs}
        aspect={aspect}
        mode={mode === "overlay" ? "overlay" : "opaque"}
        selectedId={selectedId}
        onSelect={(item) => {
          if (item.id === "custom") return;
          const applied = applyTemplate(item.show, { mode, engineText, keepText: show.text });
          onChange({ ...applied, name: item.name, presetId: item.kind === "preset" ? item.id : null });
        }}
        onRename={(item, n) => item.kind === "mine" && void rename(item.id.replace(/^mine:/, ""), n)}
        onDelete={(item) => item.kind === "mine" && void remove(item.id.replace(/^mine:/, ""))}
      />
      {PRESETS.length === 0 && <p className={styles.hint}>No presets are available yet.</p>}
    </div>
  );
}
