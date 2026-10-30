import { useMemo, useState } from "react";
import { Banner, Button, ConfirmDialog, IconButton, Spinner } from "@/components";
import { useVisualsAnalysis } from "@/components/viz";
import { parseShow } from "@/components/viz/pickerModel";
import type { TimedLine, VisualsSpec } from "@/lib/api";
import { useShortcut } from "@/lib/shortcuts";
import { useShowHistory, useUndoKeys } from "@/tools/visualizer/designer/useShowHistory";
import { VisualDesigner } from "@/tools/visualizer/designer/VisualDesigner";
import { PRESETS, showFromPreset } from "@/viz/presets";
import type { Show } from "@/viz/types";
import { CueOverlay } from "./CueOverlay";
import { activeCueIndex, type CueRow } from "./logic";
import type { Prefs } from "./options";
import { useAnalyzeOptions } from "./visuals";
import styles from "./DesignerSheet.module.css";

export interface DesignerSheetProps {
  inputPath: string;
  rows: CueRow[];
  lines: TimedLine[];
  value: VisualsSpec;
  mode: "background" | "overlay";
  aspect: number;
  prefs: Prefs;
  /** Keeps the design. */
  onDone(spec: VisualsSpec): void;
  /** Closes without keeping it. */
  onClose(): void;
}

function startShow(value: VisualsSpec): Show {
  const parsed = parseShow(value.showJson);
  if (parsed) return parsed;
  const first = PRESETS[0];
  if (!first) throw new Error("No presets are registered");
  return showFromPreset(first);
}

/** The full designer in a sheet over the Subtitles view; the cues are drawn as the burn-style text (SPEC.md 9.3). */
export function DesignerSheet({ inputPath, rows, lines, value, mode, aspect, prefs, onDone, onClose }: DesignerSheetProps) {
  const analyze = useAnalyzeOptions(value, lines);
  const listening = useVisualsAnalysis(inputPath, { analyze, auto: true });
  const initial = useMemo(() => startShow(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialJson = useMemo(() => JSON.stringify(initial), [initial]);
  const history = useShowHistory(initial);
  useUndoKeys(history);
  const [asking, setAsking] = useState(false);
  const dirty = JSON.stringify(history.show) !== initialJson;

  const close = () => {
    if (dirty) setAsking(true);
    else onClose();
  };
  useShortcut("Escape", close, { when: !asking, allowInInputs: true });

  const text = useMemo(
    () => ({
      overlay: (rect: { left: number; top: number; width: number; height: number }, timeMs: number) => (
        <CueOverlay
          rect={rect}
          text={rows[activeCueIndex(rows, timeMs)]?.text ?? ""}
          style={prefs.style}
          size={prefs.size}
          position={prefs.position}
          font={prefs.font}
        />
      ),
    }),
    [rows, prefs.style, prefs.size, prefs.position, prefs.font],
  );

  return (
    <div className={styles.sheet} role="dialog" aria-label="Visual designer">
      <div className={styles.bar}>
        <IconButton icon="undo-2" label="Undo" disabled={!history.canUndo} onClick={history.undo} />
        <IconButton icon="redo-2" label="Redo" disabled={!history.canRedo} onClick={history.redo} />
        <span className={styles.name}>{history.show.name}</span>
        <span className={styles.spacer} />
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" icon="check" onClick={() => onDone({ ...value, showJson: JSON.stringify(history.show) })}>
          Done
        </Button>
      </div>
      <div className={styles.body}>
        {listening.analysis ? (
          <VisualDesigner
            inputPath={inputPath}
            analysis={listening.analysis}
            show={history.show}
            onChange={history.set}
            aspect={aspect}
            mode={mode === "overlay" ? "overlay" : "full"}
            player={null}
            text={text}
          />
        ) : listening.status === "error" ? (
          <Banner tone="danger" title={listening.error?.message ?? "Couldn't listen to the file"} action={<Button size="sm" onClick={listening.start}>Try again</Button>}>
            {listening.error?.hint}
          </Banner>
        ) : (
          <div className={styles.loading}>
            <Spinner size={18} label="Loading" /> Listening to the file…
          </div>
        )}
      </div>
      <ConfirmDialog
        open={asking}
        title="Discard your design changes?"
        body="The design goes back to what it was when you opened the designer."
        confirmLabel="Discard"
        tone="danger"
        onConfirm={() => {
          setAsking(false);
          onClose();
        }}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}
