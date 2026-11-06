/** Editor chrome: header, the two top islands, the left edge, the Lab strip and the transform bar. */
import { useMemo, useState, type RefObject } from "react";
import { useEditor, useEngineEvents } from "./context";
import { runtime } from "./engine-adapter";
import { hsvToHex } from "./color";
import { fracFromSize, sizeFromFrac, usePaintUI, type BrushToolId, type PanelId } from "./store";
import { Badge, ColorPuck, IconButton, Island, IslandDivider, Menu, MenuButton, Segmented, TextButton, VerticalSlider, head, item, sep, type MenuEntry } from "./ui";
import ed from "./editor.module.css";

export interface ChromeActions {
  onBack(): void;
  onImportImage(): void;
  onCopyImage(): void;
  onShowLibrary(): void;
  onDuplicate(): void;
  onClose(): void;
}

function useAnchor() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return [el, setEl] as const;
}

export function SaveStatus({ onRetry }: { onRetry(): void }) {
  const state = usePaintUI((s) => s.saveState);
  const error = usePaintUI((s) => s.saveError);
  const text = state === "saved" ? "Saved" : state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : "Couldn't save";
  return (
    <span className={`${ed.saveState} ${state === "error" ? ed.saveError : ""}`} role="status" aria-live="polite" data-testid="save-state" data-state={state} data-tip={error || "Paint+ saves 2 seconds after your last change"}>
      {text}
      {state === "error" ? (
        <TextButton tip="Try saving again" onClick={onRetry}>
          Retry
        </TextButton>
      ) : null}
    </span>
  );
}

/** Project name (editable), save state, undo/redo, Studio, Export and More. */
export function HeaderContent({ name, onName, studio, onToggleStudio, actions, onRetry }: { name: string; onName(n: string): void; studio: boolean; onToggleStudio(): void; actions: ChromeActions; onRetry(): void }) {
  const { engine, openDialog } = useEditor();
  useEngineEvents(engine, ["history"]);
  const [draft, setDraft] = useState<string | null>(null);
  const more: MenuEntry[] = [
    item("exportas", "Export as…", () => openDialog("export"), { icon: "export" }),
    item("copy", "Copy image", actions.onCopyImage, { icon: "copy" }),
    sep(),
    item("canvas", "Canvas size…", () => openDialog("canvasSize"), { icon: "canvas" }),
    item("image", "Image size…", () => openDialog("imageSize"), { icon: "size" }),
    item("extend", "Extend canvas…", () => openDialog("extend"), { icon: "extend" }),
    item("upscale", "Upscale canvas…", () => openDialog("upscale"), { icon: "enhance" }),
    sep(),
    item("dup", "Duplicate painting", actions.onDuplicate, { icon: "duplicate" }),
    item("lib", "Show exports in Library", actions.onShowLibrary, { icon: "gallery" }),
    item("close", "Close", actions.onClose, { icon: "close" }),
  ];
  return (
    <div className={ed.header} data-testid="paint-header">
      <input
        className={ed.nameInput}
        aria-label="Painting name"
        data-tip="Rename this painting"
        value={draft ?? name}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft.trim() && draft.trim() !== name) onName(draft.trim());
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <SaveStatus onRetry={onRetry} />
      <span className={ed.spacer} />
      <IconButton icon="undo" label="Undo" kbd="Mod+Z" size="sm" disabled={engine.history().length === 0} reason="Nothing to undo" onClick={() => void engine.undo()} />
      <IconButton icon="redo" label="Redo" kbd="Mod+Shift+Z" size="sm" onClick={() => void engine.redo()} />
      <IconButton icon={studio ? "shrink" : "expand"} label={studio ? "Leave Studio mode" : "Studio mode"} kbd="F" size="sm" pressed={studio} onClick={onToggleStudio} />
      <TextButton primary icon="export" tip="Export this painting (PNG, JPG, WebP or layered ORA)" onClick={() => openDialog("export")}>
        Export
      </TextButton>
      <MenuButton icon="more" label="More" title="More" size="sm" entries={more} placement="below-end" />
    </div>
  );
}

/** Gallery, Actions, Adjustments, Select, Transform. */
export function TopLeftIsland({ actions, compact }: { actions: ChromeActions; compact: boolean }) {
  const { engine, openDialog } = useEditor();
  const setTool = usePaintUI((s) => s.setTool);
  const togglePanel = usePaintUI((s) => s.togglePanel);
  const settings = usePaintUI((s) => s.settings);
  const setSettings = usePaintUI((s) => s.setSettings);
  const dockMode = usePaintUI((s) => s.dockMode);
  const setDock = usePaintUI((s) => s.setDockMode);
  const adj = useMemo(() => runtime.adjustments(), []);
  const [menu, setMenu] = useState<null | "actions" | "adjust" | "select" | "transform">(null);
  const [aActions, setA] = useAnchor();
  const [aAdjust, setB] = useAnchor();
  const [aSelect, setC] = useAnchor();
  const [aTransform, setD] = useAnchor();
  const close = () => setMenu(null);
  const toggle = (m: NonNullable<typeof menu>) => setMenu((c) => (c === m ? null : m));
  const begin = (m: "free" | "uniform" | "distort" | "warp") => {
    setTool("transform");
    engine.transform.begin(m);
  };
  const sz = compact ? 16 : 20;

  const entries: Record<NonNullable<typeof menu>, MenuEntry[]> = {
    actions: [
      head("Add"),
      item("img", "Add image as layer…", actions.onImportImage, { icon: "image" }),
      head("Canvas"),
      item("cs", "Canvas size…", () => openDialog("canvasSize"), { icon: "canvas" }),
      item("is", "Image size…", () => openDialog("imageSize"), { icon: "size" }),
      item("ext", "Extend canvas with fill…", () => openDialog("extend"), { icon: "extend" }),
      item("up", "Upscale canvas…", () => openDialog("upscale"), { icon: "enhance" }),
      head("Share"),
      item("exp", "Export…", () => openDialog("export"), { icon: "export", kbd: "Ctrl+Shift+E" }),
      item("copy", "Copy image", actions.onCopyImage, { icon: "copy" }),
      head("Guides"),
      item("guides", "Drawing guides…", () => togglePanel("guides" satisfies PanelId), { icon: "guides" }),
      head("Preferences"),
      item("press", "Simulate pressure with a mouse", () => setSettings({ simulatePressure: !settings.simulatePressure }), { checked: settings.simulatePressure }),
      item("palm", "Touch only navigates when a pen is used", () => setSettings({ palmRejection: !settings.palmRejection }), { checked: settings.palmRejection }),
      item("dock-auto", "Panels dock on wide windows", () => setDock("auto"), { checked: dockMode === "auto" }),
      item("dock-dock", "Always dock panels", () => setDock("dock"), { checked: dockMode === "dock" }),
      item("dock-pop", "Panels always float", () => setDock("pop"), { checked: dockMode === "pop" }),
    ],
    adjust: adj.map((a) => item(a.id, a.label, () => undefined, { icon: a.icon, disabled: !a.available, ...(a.reason ? { reason: a.reason } : {}) })),
    select: [
      item("rect", "Rectangle", () => setTool("rect"), { icon: "rect", kbd: "M" }),
      item("ellipse", "Ellipse", () => setTool("ellipse"), { icon: "ellipse" }),
      item("lasso", "Lasso", () => setTool("lasso"), { icon: "lasso", kbd: "L" }),
      item("wand", "Magic wand", () => setTool("wand"), { icon: "wand", kbd: "W" }),
      sep(),
      item("all", "Select all", () => engine.selection.rect({ x: 0, y: 0, w: engine.doc.width, h: engine.doc.height }), { kbd: "Ctrl+A" }),
      item("none", "Deselect", () => engine.selection.clear(), { kbd: "Ctrl+D", disabled: !engine.selection.active, reason: "Nothing is selected" }),
      item("inv", "Invert", () => engine.selection.invert(), { kbd: "Ctrl+Shift+I", disabled: !engine.selection.active, reason: "Nothing is selected" }),
      item("grow", "Grow by 4 px", () => engine.selection.grow(4), { disabled: !engine.selection.active, reason: "Nothing is selected" }),
      item("shrink", "Shrink by 4 px", () => engine.selection.grow(-4), { disabled: !engine.selection.active, reason: "Nothing is selected" }),
      item("feather", "Feather 8 px", () => engine.selection.feather(8), { disabled: !engine.selection.active, reason: "Nothing is selected" }),
    ],
    transform: [
      item("free", "Freeform", () => begin("free"), { icon: "transform", kbd: "V" }),
      item("uniform", "Uniform", () => begin("uniform")),
      item("distort", "Distort", () => begin("distort")),
      item("warp", "Warp", () => begin("warp")),
      sep(),
      item("fh", "Flip horizontal", () => { begin("free"); engine.transform.flip("h"); }),
      item("fv", "Flip vertical", () => { begin("free"); engine.transform.flip("v"); }),
      item("rl", "Rotate 90° left", () => { begin("free"); engine.transform.rotate90(-1); }),
      item("rr", "Rotate 90° right", () => { begin("free"); engine.transform.rotate90(1); }),
    ],
  };
  return (
    <Island label="Tools and actions" className={ed.topLeft} data-testid="top-left">
      <IconButton icon="gallery" label="Gallery" onClick={actions.onBack} iconSize={sz} />
      <IslandDivider />
      <IconButton ref={setA} icon="wrench" label="Actions" pressed={menu === "actions"} onClick={() => toggle("actions")} iconSize={sz} aria-haspopup="menu" />
      <IconButton ref={setB} icon="adjust" label="Adjustments" pressed={menu === "adjust"} onClick={() => toggle("adjust")} iconSize={sz} aria-haspopup="menu" />
      <IconButton ref={setC} icon="select" label="Select" pressed={menu === "select"} onClick={() => toggle("select")} iconSize={sz} aria-haspopup="menu" />
      <IconButton ref={setD} icon="transform" label="Transform" kbd="V" pressed={menu === "transform"} onClick={() => toggle("transform")} iconSize={sz} aria-haspopup="menu" />
      <Menu open={menu === "actions"} title="Actions" anchor={aActions} entries={entries.actions} onClose={close} width={280} />
      <Menu open={menu === "adjust"} title="Adjustments" anchor={aAdjust} entries={entries.adjust} onClose={close} width={260} />
      <Menu open={menu === "select"} title="Select" anchor={aSelect} entries={entries.select} onClose={close} />
      <Menu open={menu === "transform"} title="Transform" anchor={aTransform} entries={entries.transform} onClose={close} />
    </Island>
  );
}

const BRUSH_TOOLS: Array<{ id: BrushToolId; icon: string; label: string; kbd: string }> = [
  { id: "brush", icon: "brush", label: "Brush", kbd: "B" },
  { id: "smudge", icon: "smudge", label: "Smudge", kbd: "S" },
  { id: "eraser", icon: "eraser", label: "Eraser", kbd: "E" },
];

/** Brush, smudge, eraser, layers and the colour puck. */
export function TopRightIsland({ anchors, compact }: { anchors: RefObject<Record<string, HTMLElement | null>>; compact: boolean }) {
  const tool = usePaintUI((s) => s.tool);
  const setTool = usePaintUI((s) => s.setTool);
  const panels = usePaintUI((s) => s.panels);
  const togglePanel = usePaintUI((s) => s.togglePanel);
  const openPanel = usePaintUI((s) => s.openPanel);
  const color = usePaintUI((s) => hsvToHex(s.color));
  const reg = (k: string) => (el: HTMLElement | null) => {
    if (anchors.current) anchors.current[k] = el;
  };
  const sz = compact ? 16 : 20;
  return (
    <Island label="Brushes, layers and colour" className={ed.topRight} data-testid="top-right">
      {BRUSH_TOOLS.map((b) => (
        <IconButton
          key={b.id}
          ref={reg(b.id)}
          icon={b.icon}
          label={tool === b.id ? `${b.label} library` : b.label}
          kbd={b.kbd}
          pressed={tool === b.id}
          iconSize={sz}
          onClick={() => (tool === b.id ? openPanel("brushes") : setTool(b.id))}
        />
      ))}
      <IslandDivider />
      <IconButton ref={reg("layers")} icon="layers" label="Layers" pressed={panels.includes("layers")} iconSize={sz} onClick={() => togglePanel("layers")} />
      <span ref={reg("color")} style={{ display: "contents" }}>
        <ColorPuck color={color} pressed={panels.includes("color")} onClick={() => togglePanel("color")} />
      </span>
    </Island>
  );
}

/** Size and opacity sliders, modify (eyedropper), undo/redo, history. */
export function LeftEdge({ compact }: { compact: boolean }) {
  const { engine } = useEditor();
  const size = usePaintUI((s) => s.size);
  const opacity = usePaintUI((s) => s.opacity);
  const setSize = usePaintUI((s) => s.setSize);
  const setOpacity = usePaintUI((s) => s.setOpacity);
  const setTool = usePaintUI((s) => s.setTool);
  const tool = usePaintUI((s) => s.tool);
  const panels = usePaintUI((s) => s.panels);
  const toggle = usePaintUI((s) => s.togglePanel);
  const h = compact ? 96 : 168;
  return (
    <Island label="Size and opacity" vertical className={ed.leftEdge} data-testid="left-edge">
      <VerticalSlider label="Brush size" kbd="[ ]" value={fracFromSize(size)} height={h} format={(v) => `${sizeFromFrac(v)} px`} onChange={(v) => setSize(sizeFromFrac(v))} data-testid="size-slider" />
      <VerticalSlider label="Opacity" kbd="{ }" value={opacity} height={h} onChange={setOpacity} data-testid="opacity-slider" />
      <IslandDivider />
      <IconButton icon="eyedropper" label="Modify: pick a colour" kbd="I" pressed={tool === "eyedropper"} onClick={() => setTool("eyedropper")} size="sm" />
      <IconButton icon="undo" label="Undo" kbd="Mod+Z" onClick={() => void engine.undo()} size="sm" />
      <IconButton icon="redo" label="Redo" kbd="Mod+Shift+Z" onClick={() => void engine.redo()} size="sm" />
      <IconButton icon="history" label="History" pressed={panels.includes("history")} onClick={() => toggle("history")} size="sm" />
    </Island>
  );
}

/** The last 6 Lab tools used (3 when compact), each with its predictability badge, and the full Lab panel. */
export function LabStrip({ compact, children }: { compact: boolean; children?: React.ReactNode }) {
  const recent = usePaintUI((s) => s.labRecent);
  const tool = usePaintUI((s) => s.tool);
  const labToolId = usePaintUI((s) => s.labToolId);
  const setLabTool = usePaintUI((s) => s.setLabTool);
  const panels = usePaintUI((s) => s.panels);
  const toggle = usePaintUI((s) => s.togglePanel);
  const all = useMemo(() => runtime.labTools(), []);
  const max = compact ? 3 : 6;
  const strokeTools = all.filter((t) => !["select-subject", "extend-canvas", "upscale-canvas"].includes(t.id));
  const shown = (recent.length ? recent.map((id) => all.find((t) => t.id === id)).filter((t) => !!t) : strokeTools.slice(0, max)).slice(0, max) as typeof all;
  return (
    <div className={ed.labStrip} data-testid="lab-strip">
      <Island label="Lab" vertical>
        <IconButton icon="flask" label="Lab" pressed={panels.includes("lab")} onClick={() => toggle("lab")} size="sm" />
        {shown.map((t) => (
          <div key={t.id} style={{ display: "grid", justifyItems: "center", gap: 1 }}>
            <IconButton icon={t.icon} label={`${t.label}: ${t.description}`} pressed={tool === "lab" && labToolId === t.id} size="sm" onClick={() => setLabTool(t)} />
            <Badge value={t.predictability} compact />
          </div>
        ))}
      </Island>
      {children}
    </div>
  );
}

/** Apply / cancel for an active transform. */
export function TransformBar() {
  const { engine } = useEditor();
  useEngineEvents(engine, ["change", "history"]);
  const [mode, setMode] = useState<"free" | "uniform" | "distort" | "warp">("free");
  const [res, setRes] = useState<"bilinear" | "bicubic">("bicubic");
  if (!engine.transform.active) return null;
  return (
    <Island label="Transform" data-testid="transform-bar">
      <Segmented
        label="Transform mode"
        value={mode}
        options={[
          { value: "free", label: "Free", tip: "Move, scale and rotate" },
          { value: "uniform", label: "Uniform", tip: "Scale keeping proportions" },
          { value: "distort", label: "Distort", tip: "Move the corners" },
          { value: "warp", label: "Warp", tip: "Bend with a mesh" },
        ]}
        onChange={(m) => {
          setMode(m);
          engine.transform.begin(m);
        }}
      />
      <Segmented<"bilinear" | "bicubic"> label="Resampling" value={res} options={[{ value: "bilinear", label: "Bilinear", tip: "Faster" }, { value: "bicubic", label: "Bicubic", tip: "Smoother" }]} onChange={setRes} />
      <TextButton primary tip="Apply the transform" onClick={() => engine.transform.commit(res)}>
        Apply
      </TextButton>
      <TextButton tip="Cancel the transform" onClick={() => engine.transform.cancel()}>
        Cancel
      </TextButton>
    </Island>
  );
}
