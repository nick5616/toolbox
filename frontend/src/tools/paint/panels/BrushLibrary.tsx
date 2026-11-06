import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { PaintService, type BrushImportResult, type BrushSet } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { BrushPreset } from "@/paint/brushes/schema";
import { runtime } from "../engine-adapter";
import { usePaintUI, type BrushToolId } from "../store";
import { TextButton } from "../ui";
import { LabPanel } from "./LabPanel";
import styles from "./panels.module.css";

/** A small canvas with a stroke of the brush, drawn by the engine (or the stand-in). */
export function BrushPreview({ brush }: { brush: BrushPreset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ink = getComputedStyle(c).getPropertyValue("color") || undefined;
    runtime.renderBrushStroke(brush, c, ink ? { color: ink } : {});
  }, [brush]);
  return <canvas ref={ref} className={styles.preview} width={264} height={72} aria-hidden="true" />;
}

interface Entry {
  key: string;
  brush: BrushPreset | null;
  name: string;
  set: string;
  setName: string;
  load(): Promise<BrushPreset | null>;
}

const toolForBrush = (b: BrushPreset, current: string): BrushToolId => (b.blend === "erase" ? "eraser" : current === "smudge" ? "smudge" : current === "eraser" ? "eraser" : "brush");

/** Brush library: sets and brushes with stroke previews, import, and a Lab tab. */
export function BrushLibrary({ onEdit, initialTab = "brushes" }: { onEdit(b: BrushPreset): void; initialTab?: "brushes" | "lab" }) {
  const [tab, setTab] = useState<"brushes" | "lab">(initialTab);
  const [setId, setSetId] = useState("all");
  const [userSets, setUserSets] = useState<BrushSet[]>([]);
  const [notes, setNotes] = useState<BrushImportResult[]>([]);
  const [busy, setBusy] = useState(false);
  const tool = usePaintUI((s) => s.tool);
  const current = usePaintUI((s) => s.brushes);
  const setBrush = usePaintUI((s) => s.setBrush);
  const lib = useMemo(() => runtime.brushLibrary(), []);
  const names = useMemo(() => runtime.brushSetNames(), []);

  const reload = useCallback(() => {
    PaintService.BrushSets().then(
      (s) => setUserSets((s ?? []).filter((x) => x.id !== "lab-devices")),
      () => undefined,
    );
  }, []);
  useEffect(reload, [reload]);

  const entries: Entry[] = useMemo(() => {
    const own: Entry[] = lib.map((b) => ({ key: `lib:${b.set}/${b.id}`, brush: b, name: b.name, set: b.set, setName: names[b.set] ?? b.set, load: async () => b }));
    const user: Entry[] = userSets.flatMap((s) =>
      (s.brushes ?? []).map((b) => ({
        key: `set:${s.id}/${b.id}`,
        brush: null,
        name: b.name,
        set: s.id,
        setName: s.name,
        load: async () => JSON.parse(await PaintService.Brush(s.id, b.id)) as BrushPreset,
      })),
    );
    return [...own, ...user];
  }, [lib, names, userSets]);

  const sets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) if (!seen.has(e.set)) seen.set(e.set, e.setName);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [entries]);
  const shown = setId === "all" ? entries : entries.filter((e) => e.set === setId);

  const choose = async (e: Entry) => {
    try {
      const b = e.brush ?? (await e.load());
      if (b) setBrush(toolForBrush(b, tool), b);
    } catch (err) {
      toast({ title: `Couldn't load ${e.name}`, description: toAppError(err).message, tone: "danger" });
    }
  };

  const importFiles = async () => {
    setBusy(true);
    try {
      const paths = (await PaintService.PickBrushFiles()) ?? [];
      if (paths.length === 0) return;
      const res = (await PaintService.ImportBrushes(paths)) ?? [];
      setNotes(res);
      reload();
      const ok = res.filter((r) => !r.error).length;
      if (ok) toast({ title: `Imported ${ok} brush ${ok === 1 ? "file" : "files"}`, tone: "success" });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const active = tool === "smudge" ? current.smudge : tool === "eraser" ? current.eraser : current.brush;

  return (
    <div className={styles.stack} data-testid="brush-library">
      <div className={styles.tabs} role="tablist" aria-label="Brush library views">
        <button type="button" role="tab" aria-selected={tab === "brushes"} className={styles.tab} data-tip="Brushes and brush sets" onClick={() => setTab("brushes")}>
          Brushes
        </button>
        <button type="button" role="tab" aria-selected={tab === "lab"} className={styles.tab} data-tip="Lab tools: algorithmic and perception tools that paint like brushes" onClick={() => setTab("lab")}>
          Lab
        </button>
      </div>
      {tab === "lab" ? (
        <LabPanel />
      ) : (
        <>
          <div className={styles.row}>
            <TextButton icon="import" tip="Import Procreate, MyPaint, Photoshop or Krita brushes you own" disabled={busy} reason="Importing…" onClick={() => void importFiles()}>
              Import
            </TextButton>
            <TextButton icon="plus" tip="Make a new brush in the Brush Studio" onClick={() => active && onEdit(active)} disabled={!active} reason="Pick a brush first">
              Edit brush
            </TextButton>
          </div>
          {notes.length ? (
            <div className={styles.section} data-testid="import-notes">
              {notes.map((r, i) => (
                <div key={`${r.file}${i}`} className={styles.section}>
                  <span className={r.error ? styles.fail : undefined}>
                    {r.error ? `${r.file.split(/[\\/]/).pop()}: ${r.error}` : `${r.set.name} (${(r.set.brushes ?? []).length} brushes)`}
                  </span>
                  {(r.fidelity ?? []).length ? (
                    <ul className={styles.fidelity} aria-label="Fidelity notes">
                      {(r.fidelity ?? []).map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
              <TextButton tip="Hide these notes" onClick={() => setNotes([])}>
                Dismiss
              </TextButton>
            </div>
          ) : null}
          <div className={styles.setList} role="group" aria-label="Brush sets">
            {[{ id: "all", name: "All" }, ...sets].map((s) => (
              <button key={s.id} type="button" className={styles.listBtn} aria-pressed={setId === s.id} data-tip={`Show ${s.name}`} onClick={() => setSetId(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
          <div className={styles.brushList} role="list" aria-label="Brushes">
            {shown.map((e) => (
              <div key={e.key} role="listitem">
                <button type="button" className={styles.brushBtn} aria-pressed={active?.id === e.key.split("/").pop() && active?.set === e.set} data-tip={`Use ${e.name} (${e.setName})`} onClick={() => void choose(e)}>
                  <span>{e.name}</span>
                  {e.brush ? <BrushPreview brush={e.brush} /> : <span />}
                </button>
              </div>
            ))}
            {shown.length === 0 ? <p className={styles.layerMeta}>No brushes in this set yet.</p> : null}
          </div>
        </>
      )}
    </div>
  );
}
