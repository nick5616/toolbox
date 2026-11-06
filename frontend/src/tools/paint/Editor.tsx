/**
 * The Paint+ editor (SPEC §1.5, §1.6): the canvas edge to edge, floating
 * islands, docked or popover panels, autosave, Studio mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolHeader } from "@/components/ToolHeader";
import { toast } from "@/components/toast";
import { FilesService, PaintService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useCommands } from "@/lib/commands";
import { useMediaQuery } from "@/lib/media";
import { openLibrary } from "@/lib/openLibrary";
import { useBeforePopOut } from "@/lib/popout";
import { matches, useShortcut } from "@/lib/shortcuts";
import { PaintGLError, type PaintEngine, type PaintDoc, type TileSource } from "@/paint/engine/types";
import type { BrushPreset } from "@/paint/brushes/schema";
import type { PaintEngineExt } from "@/paint/engine/engine";
import type { PerceptionToolInfo } from "@/paint/lab/types";
import { actionCombos, buildActions } from "./actions";
import type { InputController, OverlayShape } from "./canvasInput";
import { HeaderContent, LabStrip, LeftEdge, TopLeftIsland, TopRightIsland, TransformBar, type ChromeActions } from "./chrome";
import { EditorContext, useEngineEvents, type EditorDialog } from "./context";
import { EditorDialogs } from "./dialogs";
import { DEFAULT_GUIDES, runtime } from "./engine-adapter";
import { copyImage, ExportResult } from "./exportFlow";
import { BrushHud, PendingRegions, ShapeOverlay } from "./overlays";
import { BrushLibrary } from "./panels/BrushLibrary";
import { BrushStudio } from "./panels/BrushStudio";
import { ColorPanel } from "./panels/ColorPanel";
import { GenerationsStrip } from "./panels/GenerationsStrip";
import { GuidesPanel } from "./panels/GuidesPanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { LabPanel, LAB_ACTIONS } from "./panels/LabPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { loadPrefs, usePrefsSaver } from "./prefs";
import { Saver } from "./save";
import { buildToolState, defaultParams, strokeSeed, usePaintUI, DOCK_FROM, type PanelId } from "./store";
import { hsvToHex, rgbaToHex } from "./color";
import { Popover } from "./ui";
import ed from "./editor.module.css";

export const MODULE_ID = "paint";

const PANEL_TITLES: Record<PanelId, string> = { brushes: "Brushes", brushstudio: "Brush Studio", color: "Colour", layers: "Layers", history: "History", lab: "Lab", guides: "Guides" };
const PANEL_WIDTH: Record<PanelId, number> = { brushes: 340, brushstudio: 360, color: 320, layers: 320, history: 320, lab: 360, guides: 320 };
const PANEL_ANCHOR: Record<PanelId, string> = { brushes: "brush", brushstudio: "brush", color: "color", layers: "layers", history: "layers", lab: "layers", guides: "layers" };

function tileSource(projectId: string, onFail: (layerId: string, keys: string[]) => void): TileSource {
  return {
    async load(layerId, keys) {
      const out = new Map<string, ImageBitmap>();
      for (let i = 0; i < keys.length; i += 64) {
        const chunk = keys.slice(i, i + 64);
        try {
          const urls = (await PaintService.Tiles(projectId, layerId, chunk)) ?? {};
          for (const [k, url] of Object.entries(urls)) {
            if (!url) continue;
            const blob = await (await fetch(url)).blob();
            out.set(k, await createImageBitmap(blob));
          }
        } catch {
          onFail(layerId, chunk);
        }
      }
      return out;
    },
  };
}

/** What the real engine offers beyond the frozen contract (absent on the stand-in engine). */
type Ext = PaintEngine & Partial<PaintEngineExt>;

function guidesJSON(): string {
  const g = usePaintUI.getState().guides;
  return JSON.stringify(g) === JSON.stringify(DEFAULT_GUIDES) ? "" : JSON.stringify(g);
}

export interface EditorProps {
  projectId: string;
  initialName: string;
  studio: boolean;
  onToggleStudio(): void;
  onBack(): void;
  onOpen(id: string): void;
  /** Pictures dropped or sent while this painting is open: they become new layers. */
  imports: string[];
  onImportsDone(): void;
}

export default function Editor({ projectId, initialName, studio, onToggleStudio, onBack, onOpen, imports, onImportsDone }: EditorProps) {
  const [engine] = useState<PaintEngine>(() => runtime.createEngine());
  const [queue] = useState(() => runtime.createQueue(engine));
  const [name, setName] = useState(initialName);
  const nameRef = useRef(name);
  nameRef.current = name;
  const [saver] = useState(() => new Saver({ engine, projectId, getName: () => nameRef.current, getGuides: () => ((engine as Ext).setGuides ? engine.doc.guides : guidesJSON()), onState: (s, e) => usePaintUI.getState().setSave(s, e) }));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const anchors = useRef<Record<string, HTMLElement | null>>({});
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [failedTiles, setFailedTiles] = useState<Array<{ layerId: string; keys: string[] }>>([]);
  const [dialog, setDialog] = useState<EditorDialog | null>(null);
  const [exportJob, setExportJob] = useState<string | null>(null);
  const [studioBrush, setStudioBrush] = useState<BrushPreset | null>(null);
  const [shape, setShape] = useState<OverlayShape | null>(null);
  const [points, setPoints] = useState<Array<{ x: number; y: number; positive: boolean }>>([]);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const hudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const txy = useRef({ x: 0, y: 0 });
  const strokes = useRef(0);
  const lockedToast = useRef(0);

  const wide = useMediaQuery(`(min-width: ${DOCK_FROM}px)`);
  const narrow = useMediaQuery("(max-width: 1099px)");
  const short = useMediaQuery("(max-height: 659px)");
  const compact = narrow || short;
  const dockMode = usePaintUI((s) => s.dockMode);
  const docked = dockMode === "dock" || (dockMode === "auto" && wide);
  const panels = usePaintUI((s) => s.panels);
  const hidden = usePaintUI((s) => s.uiHidden);
  usePrefsSaver(ready);
  useEngineEvents(engine, ["layers"]);

  // ---- lifecycle ----
  useEffect(() => {
    let off = false;
    usePaintUI.getState().reset();
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      engine.attach(canvas);
    } catch (e) {
      setFatal(e instanceof PaintGLError ? e.message : toAppError(e).message);
      return;
    }
    void (async () => {
      await loadPrefs(runtime.brushLibrary());
      const doc: PaintDoc = await PaintService.Load(projectId);
      if (off) return;
      await engine.load(doc, tileSource(projectId, (layerId, keys) => setFailedTiles((f) => [...f, { layerId, keys }])));
      if (off) return;
      try {
        if (doc.guides && !(engine as Ext).setGuides) usePaintUI.setState({ guides: { ...DEFAULT_GUIDES, ...(JSON.parse(doc.guides) as object) } });
      } catch {
        /* unreadable guides: defaults */
      }
      if (!(engine as Ext).setGuides) runtime.applyGuides(engine, usePaintUI.getState().guides);
      (engine as Ext).setViewport?.(areaRef.current?.clientWidth ?? 0, areaRef.current?.clientHeight ?? 0);
      saver.start();
      engine.view.fit();
      setReady(true);
      if (!initialName) {
        const list = (await PaintService.Projects().catch(() => [])) ?? [];
        const n = list.find((p) => p.id === projectId)?.name;
        if (n && !off) setName(n);
      }
    })().catch((e) => !off && setFatal(toAppError(e).message));
    return () => {
      off = true;
      void saver
        .flush()
        .catch(() => undefined)
        .finally(() => saver.dispose());
      engine.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the canvas sharp when its box changes.
  useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => (engine as Ext).setViewport?.(el.clientWidth, el.clientHeight);
    fit();
    const ro = new ResizeObserver(() => {
      fit();
      engine.render();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [engine]);

  // The real engine loads a brush's tip and grain images when the brush is picked.
  useEffect(() => {
    if (!ready) return;
    const prep = (b: Record<string, BrushPreset | null>) => Object.values(b).forEach((x) => x && void (engine as Ext).prepareBrush?.(x));
    prep(usePaintUI.getState().brushes);
    return usePaintUI.subscribe((s, prev) => s.brushes !== prev.brushes && prep(s.brushes));
  }, [ready, engine]);

  // Save on blur and when the window hides.
  useEffect(() => {
    const flush = () => void saver.flush().catch(() => undefined);
    const vis = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [saver]);
  useBeforePopOut(MODULE_ID, () => saver.flush());

  // Pictures dropped, sent or picked while open become layers.
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    if (imports.length === 0) return;
    setPending((p) => [...p, ...imports]);
    onImportsDone();
  }, [imports, onImportsDone]);
  useEffect(() => {
    if (!ready || pending.length === 0) return;
    const list = pending;
    setPending([]);
    void (async () => {
      try {
        await saver.flush();
        for (const p of list) await PaintService.ImportLayer(projectId, p);
        const doc = await PaintService.Load(projectId);
        await engine.load(doc, tileSource(projectId, (layerId, keys) => setFailedTiles((f) => [...f, { layerId, keys }])));
        saver.sync();
        toast({ title: `Added ${list.length} ${list.length === 1 ? "picture" : "pictures"} as layers`, tone: "success" });
      } catch (e) {
        toast({ title: "Couldn't add the picture", description: toAppError(e).message, tone: "danger" });
      }
    })();
  }, [ready, pending, saver, projectId, engine]);

  // ---- input ----
  const labById = useCallback((id: string) => runtime.labTools().find((t) => t.id === id), []);
  const ctl = useMemo<InputController>(
    () => ({
      mode() {
        const s = usePaintUI.getState();
        switch (s.tool) {
          case "brush":
          case "smudge":
          case "eraser":
          case "history":
            return "stroke";
          case "lab": {
            const info = labById(s.labToolId);
            if (!info) return "none";
            if (info.kind === "algorithmic") return "stroke";
            if (LAB_ACTIONS.has(info.id)) return "none";
            return info.id === "select-object" ? "points" : "stroke";
          }
          default:
            return s.tool;
        }
      },
      strokeTool() {
        const s = usePaintUI.getState();
        const layer = (engine.doc.layers ?? []).find((l) => l.id === engine.doc.active);
        if (layer?.locked || layer?.hidden) {
          if (strokes.current - lockedToast.current > 0) {
            lockedToast.current = strokes.current;
            toast({ title: layer.locked ? "That layer is locked" : "That layer is hidden", description: "Pick another layer, or unlock it in the Layers panel", tone: "warn" });
          }
          return null;
        }
        const info = s.tool === "lab" ? labById(s.labToolId) : undefined;
        const seed = s.tool === "lab" ? strokeSeed(s.labToolId) : ++strokes.current;
        return buildToolState(s, seed, info?.kind === "perception");
      },
      simulatePressure: () => usePaintUI.getState().settings.simulatePressure,
      palmRejection: () => usePaintUI.getState().settings.palmRejection,
      onStrokeEnd(result, tool) {
        strokes.current++;
        if (tool.kind !== "mask") return;
        const s = usePaintUI.getState();
        const info = labById(s.labToolId) as PerceptionToolInfo | undefined;
        if (!info) return;
        runtime
          .runPerceptionStroke({ engine, queue, tool: info, params: s.labParams[info.id] ?? defaultParams(info), seed: tool.seed, result })
          .catch((e) => toast({ title: toAppError(e).message, tone: "danger" }));
      },
      onEyedrop(at) {
        void engine.readRegion({ x: Math.floor(at.x), y: Math.floor(at.y), w: 1, h: 1 }, "merged").then((img) => {
          const [r = 0, g = 0, b = 0, a = 0] = img.data;
          if (a === 0) return;
          const st = usePaintUI.getState();
          st.setColorHex(rgbaToHex({ r: r / 255, g: g / 255, b: b / 255 }));
          st.commitColor();
        });
      },
      onFill(at) {
        const s = usePaintUI.getState();
        const [r, g, b] = [hsvToHex(s.color)].map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)])[0] as [number, number, number];
        engine.fill(at, { tolerance: 24, sampleAll: false, color: { r: r / 255, g: g / 255, b: b / 255, a: s.opacity } });
      },
      onWand: (at) => engine.selection.wand(at, usePaintUI.getState().wand),
      onTransformDrag(dx, dy) {
        if (!engine.transform.active) {
          engine.transform.begin("free");
          txy.current = { x: 0, y: 0 };
        }
        txy.current = { x: txy.current.x + dx, y: txy.current.y + dy };
        engine.transform.set({ matrix: [1, 0, 0, 1, txy.current.x, txy.current.y] });
      },
      onPoint(at, positive) {
        setPoints((p) => [...p, { x: at.x, y: at.y, positive }].slice(-64));
      },
      onOverlay: setShape,
      onTwoFingerTap: () => void engine.undo(),
      onThreeFingerTap: () => void engine.redo(),
      onHover: setHover,
    }),
    [engine, queue, labById],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    return runtime.attachInput(canvas, engine, ctl);
  }, [ready, engine, ctl]);

  // ---- shortcuts ----
  const flashHud = useCallback(() => {
    usePaintUI.getState().setHud(true);
    clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => usePaintUI.getState().setHud(false), 900);
  }, []);
  useEffect(() => () => clearTimeout(hudTimer.current), []);
  const actions = buildActions({
    engine,
    openDialog: setDialog,
    toggleStudio: onToggleStudio,
    toggleHide: () => usePaintUI.getState().setUIHidden(!usePaintUI.getState().uiHidden),
    togglePanel: (p) => usePaintUI.getState().togglePanel(p),
    flashHud,
  });
  useShortcut(actionCombos(actions), (e) => actions.find((a) => matches(e, a.combo))?.run(), { when: ready });
  useShortcut("Enter", () => {
    const pts = points;
    setPoints([]);
    runtime.runLabAction("select-object", { engine, queue, points: pts }).catch((e) => toast({ title: toAppError(e).message, tone: "danger" }));
  }, { when: ready && points.length > 0 });
  useShortcut("Escape", () => {
    if (points.length) setPoints([]);
    else if (engine.transform.active) engine.transform.cancel();
    else if (usePaintUI.getState().uiHidden) usePaintUI.getState().setUIHidden(false);
  }, { when: ready });
  useCommands(
    actions.map((a) => ({ id: a.id, title: a.title, section: "Paint+", shortcut: a.combo, run: a.run })),
    [],
  );

  // ---- chrome actions ----
  const flush = () => saver.flush().catch((e) => toast({ title: "Couldn't save", description: toAppError(e).message, tone: "danger" }));
  const chromeActions: ChromeActions = {
    onBack: () => void saver.flush().catch(() => undefined).finally(onBack),
    onClose: () => void saver.flush().catch(() => undefined).finally(onBack),
    onImportImage: () =>
      void FilesService.PickWith("Add a picture as a layer", [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"], true).then((p) => {
        if (p && p.length) setPending((q) => [...q, ...p]);
      }),
    onCopyImage: () => void copyImage(engine).then(() => toast({ title: "Copied the picture", tone: "success" }), (e) => toast({ title: "Couldn't copy", description: toAppError(e).message, tone: "danger" })),
    onShowLibrary: () => openLibrary({ moduleId: MODULE_ID }),
    onDuplicate: () =>
      void (async () => {
        try {
          await saver.flush();
          const id = await PaintService.Duplicate(projectId);
          toast({ title: "Duplicated", tone: "success" });
          onOpen(id);
        } catch (e) {
          toast({ title: "Couldn't duplicate", description: toAppError(e).message, tone: "danger" });
        }
      })(),
  };

  const rename = (n: string) => {
    setName(n);
    PaintService.Rename(projectId, n).catch((e) => toast({ title: "Couldn't rename", description: toAppError(e).message, tone: "danger" }));
  };

  const ctxValue = useMemo(() => ({ engine, queue, projectId, saver, docked, compact, openDialog: setDialog }), [engine, queue, projectId, saver, docked, compact]);

  const panelNode = (id: PanelId) => {
    switch (id) {
      case "brushes":
        return (
          <BrushLibrary
            onEdit={(b) => {
              setStudioBrush(b);
              usePaintUI.getState().openPanel("brushstudio");
            }}
          />
        );
      case "brushstudio":
        return studioBrush ? <BrushStudio initial={studioBrush} onClose={() => usePaintUI.getState().closePanel("brushstudio")} /> : <p>Pick a brush, then choose Edit brush.</p>;
      case "color":
        return <ColorPanel />;
      case "layers":
        return <LayersPanel />;
      case "history":
        return <HistoryPanel />;
      case "lab":
        return <LabPanel />;
      case "guides":
        return <GuidesPanel />;
    }
  };
  const close = (id: PanelId) => usePaintUI.getState().closePanel(id);
  const visible = docked ? panels.slice(-2) : panels.slice(-1);
  const popWidth = compact ? Math.min(PANEL_WIDTH.brushes, 340) : undefined;

  const headerEl = (
    <div data-design="paint" className={ed.inToolbox}>
      <HeaderContent name={name} onName={rename} studio={false} onToggleStudio={onToggleStudio} actions={chromeActions} onRetry={() => void flush()} />
    </div>
  );

  return (
    <EditorContext.Provider value={ctxValue}>
      <div className={`${ed.root} ${hidden ? ed.hiddenUI : ""}`} data-design="paint" data-compact={compact ? "true" : "false"} data-studio={studio ? "true" : "false"} data-docked={docked ? "true" : "false"} data-testid="paint-editor" data-file-drop-target>
        {studio ? (
          <div className={ed.studioStrip} data-pinned={hidden ? "false" : undefined}>
            <HeaderContent name={name} onName={rename} studio onToggleStudio={onToggleStudio} actions={chromeActions} onRetry={() => void flush()} />
          </div>
        ) : (
          <ToolHeader aria-label="Paint+">{headerEl}</ToolHeader>
        )}
        <div className={ed.stage}>
          <div className={ed.area} ref={areaRef}>
            <canvas ref={canvasRef} className={ed.canvas} tabIndex={0} aria-label="Painting canvas" data-testid="paint-canvas" />
            {fatal ? (
              <div className={ed.glError} role="alert" data-testid="paint-fatal">
                <p>{fatal}</p>
              </div>
            ) : null}
            {ready ? (
              <>
                <ShapeOverlay shape={points.length ? { kind: "points", points } : shape} />
                <PendingRegions />
                <BrushHud at={hover} />
                <div className={ed.floats}>
                  <TopLeftIsland actions={chromeActions} compact={compact} />
                  <TopRightIsland anchors={anchors} compact={compact} />
                  <LeftEdge compact={compact} />
                  <LabStrip compact={compact} />
                  <div className={ed.bottomBar}>
                    <TransformBar />
                    <GenerationsStrip />
                    {exportJob ? <ExportResult jobId={exportJob} onDismiss={() => setExportJob(null)} /> : null}
                  </div>
                </div>
              </>
            ) : null}
            <div className={ed.banners}>
              {failedTiles.length ? (
                <div className={`${ed.banner} ${ed.bad}`} role="alert" data-testid="tile-banner">
                  <span className={ed.spacer}>Some of this layer couldn't be read ({failedTiles.reduce((n, f) => n + f.keys.length, 0)} tiles)</span>
                  <button
                    type="button"
                    data-tip="Remove the unreadable tiles from the painting (they become transparent)"
                    onClick={() => {
                      void Promise.all(failedTiles.map((f) => PaintService.SaveTiles(projectId, f.layerId, {}, f.keys))).then(() => setFailedTiles([]), (e) => toast({ title: toAppError(e).message, tone: "danger" }));
                    }}
                  >
                    Clear those tiles
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {docked && visible.length ? (
            <div className={ed.dock} data-testid="dock">
              {visible.map((id) => (
                <Popover key={id} docked open title={PANEL_TITLES[id]} anchor={null} width={PANEL_WIDTH[id]} onClose={() => close(id)}>
                  {panelNode(id)}
                </Popover>
              ))}
            </div>
          ) : null}
        </div>
        {!docked
          ? visible.map((id) => (
              <Popover key={id} open title={PANEL_TITLES[id]} anchor={anchors.current[PANEL_ANCHOR[id]] ?? null} width={popWidth ?? PANEL_WIDTH[id]} maxHeight={compact ? 520 : 640} onClose={() => close(id)} data-testid={`popover-${id}`}>
                {panelNode(id)}
              </Popover>
            ))
          : null}
        <EditorDialogs open={dialog} name={name} onClose={() => setDialog(null)} onExportJob={setExportJob} />
      </div>
    </EditorContext.Provider>
  );
}

