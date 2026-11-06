import { useState } from "react";
import { toast } from "@/components/toast";
import { toAppError } from "@/lib/errors";
import { useEditor, type EditorDialog } from "./context";
import { runtime } from "./engine-adapter";
import { sizeProblem } from "./limits";
import { Dialog, FieldRow, Segmented, Stepper, TextButton, Toggle } from "./ui";
import { ExportDialog } from "./exportFlow";

const ANCHORS: Array<{ id: string; x: number; y: number }> = [0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => ({ id: `${x}-${y}`, x, y })));

function SizeDialog({ kind, onClose }: { kind: "canvas" | "image"; onClose(): void }) {
  const { engine } = useEditor();
  const [w, setW] = useState(engine.doc.width);
  const [h, setH] = useState(engine.doc.height);
  const [lock, setLock] = useState(true);
  const [anchor, setAnchor] = useState("0.5-0.5");
  const ratio = engine.doc.width / Math.max(1, engine.doc.height);
  const problem = sizeProblem(w, h);
  const apply = () => {
    if (problem) return;
    if (kind === "canvas") {
      const a = ANCHORS.find((x) => x.id === anchor) ?? { x: 0.5, y: 0.5 };
      engine.resizeCanvas(w, h, { x: a.x, y: a.y });
    } else engine.resample(w, h);
    onClose();
  };
  return (
    <Dialog
      title={kind === "canvas" ? "Canvas size" : "Image size"}
      onClose={onClose}
      actions={
        <>
          <TextButton tip="Close without changing" onClick={onClose}>
            Cancel
          </TextButton>
          <TextButton primary tip={kind === "canvas" ? "Change the canvas; the picture stays at the anchor" : "Scale the whole picture to this size"} disabled={!!problem} reason={problem} onClick={apply}>
            Apply
          </TextButton>
        </>
      }
    >
      <FieldRow label="Width">
        <Stepper label="Width" value={w} min={1} max={8192} step={10} unit="px" onChange={(v) => { setW(v); if (lock) setH(Math.max(1, Math.round(v / ratio))); }} />
      </FieldRow>
      <FieldRow label="Height">
        <Stepper label="Height" value={h} min={1} max={8192} step={10} unit="px" onChange={(v) => { setH(v); if (lock) setW(Math.max(1, Math.round(v * ratio))); }} />
      </FieldRow>
      <Toggle label="Keep proportions" tip="Change width and height together" checked={lock} onChange={setLock} />
      {kind === "canvas" ? (
        <FieldRow label="Anchor">
          <div role="radiogroup" aria-label="Anchor" style={{ display: "grid", gridTemplateColumns: "repeat(3, 22px)", gap: 4 }}>
            {ANCHORS.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={anchor === a.id} aria-label={`Anchor ${a.id}`} data-tip="Where the existing picture sits on the new canvas" onClick={() => setAnchor(a.id)} style={{ width: 22, height: 22, borderRadius: 5, border: 0, background: anchor === a.id ? "var(--p-accent)" : "var(--p-track)", cursor: "pointer" }} />
            ))}
          </div>
        </FieldRow>
      ) : null}
      {problem ? <p style={{ margin: 0, color: "var(--p-warn)" }}>{problem}</p> : <p style={{ margin: 0 }}>{((w * h) / 1e6).toFixed(1)} megapixels (limit 40)</p>}
    </Dialog>
  );
}

function ExtendDialog({ onClose }: { onClose(): void }) {
  const { engine, queue } = useEditor();
  const [px, setPx] = useState(512);
  const [sides, setSides] = useState({ left: false, right: true, top: false, bottom: false });
  const [model, setModel] = useState<"fast" | "best">("fast");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await runtime.extendCanvas({ engine, queue, model, sides: { left: sides.left ? px : 0, right: sides.right ? px : 0, top: sides.top ? px : 0, bottom: sides.bottom ? px : 0 } });
      onClose();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Extend canvas with fill"
      onClose={onClose}
      actions={
        <>
          <TextButton tip="Close without extending" onClick={onClose}>
            Cancel
          </TextButton>
          <TextButton primary tip="Grow the canvas and fill the new margins from the edges" disabled={busy || !Object.values(sides).some(Boolean)} reason={busy ? "Working…" : "Choose a side"} onClick={() => void run()}>
            Extend
          </TextButton>
        </>
      }
    >
      <FieldRow label="Grow by">
        <Stepper label="Pixels" value={px} min={16} max={2048} step={64} unit="px" onChange={setPx} />
      </FieldRow>
      {(["left", "right", "top", "bottom"] as const).map((s) => (
        <Toggle key={s} label={s[0]?.toUpperCase() + s.slice(1)} tip={`Add ${px} px on the ${s}`} checked={sides[s]} onChange={(v) => setSides({ ...sides, [s]: v })} />
      ))}
      <Segmented<"fast" | "best"> label="Quality" value={model} options={[{ value: "fast", label: "Fast", tip: "Quicker" }, { value: "best", label: "Best", tip: "Cleaner seams" }]} onChange={setModel} />
    </Dialog>
  );
}

function UpscaleDialog({ onClose }: { onClose(): void }) {
  const { engine } = useEditor();
  const [scale, setScale] = useState<"2" | "4">("2");
  const [inPlace, setInPlace] = useState(true);
  const [busy, setBusy] = useState(false);
  const w = engine.doc.width * Number(scale);
  const h = engine.doc.height * Number(scale);
  const problem = sizeProblem(w, h);
  const run = async () => {
    setBusy(true);
    try {
      await runtime.upscaleCanvas({ engine, scale: Number(scale) as 2 | 4, inPlace });
      onClose();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Upscale canvas"
      onClose={onClose}
      actions={
        <>
          <TextButton tip="Close without upscaling" onClick={onClose}>
            Cancel
          </TextButton>
          <TextButton primary tip="Enlarge the whole canvas with the upscaler" disabled={busy || !!problem} reason={problem || "Working…"} onClick={() => void run()}>
            Upscale
          </TextButton>
        </>
      }
    >
      <Segmented<"2" | "4"> label="Scale" value={scale} options={[{ value: "2", label: "×2", tip: "Double the size" }, { value: "4", label: "×4", tip: "Four times the size" }]} onChange={setScale} />
      <Toggle label="Replace this painting" tip="Off makes a new project and leaves this one alone" checked={inPlace} onChange={setInPlace} />
      <p style={{ margin: 0 }}>{problem || `${w} × ${h} px`}</p>
    </Dialog>
  );
}

export function EditorDialogs({ open, name, onClose, onExportJob }: { open: EditorDialog | null; name: string; onClose(): void; onExportJob(id: string): void }) {
  switch (open) {
    case "export":
      return <ExportDialog name={name} onClose={onClose} onJob={onExportJob} />;
    case "canvasSize":
      return <SizeDialog kind="canvas" onClose={onClose} />;
    case "imageSize":
      return <SizeDialog kind="image" onClose={onClose} />;
    case "extend":
      return <ExtendDialog onClose={onClose} />;
    case "upscale":
      return <UpscaleDialog onClose={onClose} />;
    default:
      return null;
  }
}
