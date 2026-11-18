import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ToolHeader } from "@/components/ToolHeader";
import { Banner, Button, ClickIn, ClickInHost, CompareSlider, DropZone, IconButton, MenuButton, Meter, SegmentedControl, Slider, cx, toast } from "@/components";
import { EraserModel, EraserService, FilesService, JobsService, OutputKind, type EraserModelInfo, type EraserSavedMask } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { releaseImageUrl, wholeImageUrl } from "@/lib/wholeImage";
import { formatBytes } from "@/lib/format";
import { useShortcut } from "@/lib/shortcuts";
import { isActive, useJob } from "@/state/jobs";
import { DepsGate, RecentResults, useDepsGate, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { FileActions } from "@/tools/_kit/FileActions";
import { useEmbedFocus } from "@/tools/_kit/useEmbedFocus";
import type { ToolViewProps } from "../index";
import { onEraserAction } from "./commands";
import { canvasIsEmpty, exportMaskPNG } from "./exportMask";
import {
  FIT_VIEW,
  MaskHistory,
  actualSizeZoom,
  brushToMask,
  clampBrush,
  clientToMask,
  drawStroke,
  fitScale,
  maskIsEmpty,
  maskSize,
  replay,
  zoomAround,
  type Point,
  type Size,
  type Stroke,
  type StrokeCtx,
  type View,
} from "./mask";
import { SavedMasks } from "./SavedMasks";
import { loadMaskStamp, parseColor } from "./stamp";
import { DEFAULT_SETTINGS, canPaintOn, modelHint, needsThumb, sanitizeSettings, summarizeModel } from "./options";
import styles from "./ObjectEraserView.module.css";

type Tool = "brush" | "unpaint";
type ResultMode = "compare" | "result";

const FALLBACK_COLOR = "#ff8c42";

function accentColor(): string {
  if (typeof document === "undefined") return FALLBACK_COLOR;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return v || FALLBACK_COLOR;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function parentName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

function parseWarning(resultJson: string): string {
  try {
    const r = JSON.parse(resultJson) as { warning?: unknown };
    return typeof r.warning === "string" ? r.warning : "";
  } catch {
    return "";
  }
}

interface Loaded {
  url: string;
  w: number;
  h: number;
}

export default function ObjectEraserView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const embedFocus = useEmbedFocus<HTMLElement>();
  const { files, remove } = inputs;
  // (the loader below also clears the mask history when the photo changes)
  const file = files.length > 0 ? files[files.length - 1] : undefined;
  const gate = useDepsGate(moduleId);
  const [settings, setSettings] = useModuleOptions(moduleId, DEFAULT_SETTINGS, sanitizeSettings);

  // The photo being edited; "Keep erasing" replaces it with the previous output.
  const [path, setPath] = useState<string | null>(null);
  const [img, setImg] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [models, setModels] = useState<EraserModelInfo[]>([]);
  const [tool, setTool] = useState<Tool>("brush");
  const [altDown, setAltDown] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [view, setView] = useState<View>(FIT_VIEW);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [rev, setRev] = useState(0); // bumps when the history changes
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; hint?: string } | null>(null);
  const [jobId, setJobId] = useState("");
  const [resultMode, setResultMode] = useState<ResultMode>("compare");
  const [afterUrl, setAfterUrl] = useState("");

  const history = useRef(new MaskHistory());
  const maskRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stroke = useRef<Stroke | null>(null);
  const panning = useRef<{ x: number; y: number } | null>(null);
  const warned = useRef("");
  const job = useJob(jobId);
  const running = !!job && isActive(job);
  const done = !!job && job.status === "done";
  const output = done ? job.outputs[0] : undefined;

  // A newly added file replaces the previous one.
  useEffect(() => {
    if (files.length > 1) for (const f of files.slice(0, -1)) remove(f.path);
  }, [files, remove]);
  const filePath = file?.path ?? null;
  useEffect(() => {
    setPath(filePath);
    setJobId("");
    setSubmitError(null);
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    EraserService.ModelStatus()
      .then((m) => !cancelled && setModels(m ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the image whenever the working path changes.
  const mask = useMemo<Size>(() => (img && img.w > 0 ? maskSize(img.w, img.h) : { w: 0, h: 0 }), [img]);
  useEffect(() => {
    history.current.reset();
    setRev((n) => n + 1);
    setImg(null);
    setLoadError(null);
    setView(FIT_VIEW);
    if (!path) return;
    if (!canPaintOn(path)) {
      setLoadError("This file type can't be shown for painting. Convert it to JPG or PNG first.");
      return;
    }
    let cancelled = false;
    let made = "";
    (needsThumb(path) ? FilesService.ImageThumb(path, 1600) : wholeImageUrl(path))
      .then((url) => {
        made = url;
        if (cancelled) releaseImageUrl(url);
        else setImg({ url, w: 0, h: 0 });
      })
      .catch((e) => !cancelled && setLoadError(toAppError(e).message));
    return () => {
      cancelled = true;
      releaseImageUrl(made);
    };
  }, [path]);

  const editing = !!img && img.w > 0 && !running && !done;

  // Track the stage size for the fit scale.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [!!img, done]); // eslint-disable-line react-hooks/exhaustive-deps

  // Result: URL for the "after" image, and the engine's warning.
  useEffect(() => {
    if (!output) {
      setAfterUrl("");
      return;
    }
    let cancelled = false;
    let made = "";
    wholeImageUrl(output.path)
      .then((u) => {
        made = u;
        if (cancelled) releaseImageUrl(u);
        else setAfterUrl(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      releaseImageUrl(made);
    };
  }, [output]);
  useEffect(() => {
    if (!job || job.status !== "done" || warned.current === job.id) return;
    warned.current = job.id;
    const w = parseWarning(job.resultJson);
    if (w) toast({ title: w, tone: "warn" });
  }, [job]);

  // ---- painting ----

  const ctx2d = (): CanvasRenderingContext2D | null => maskRef.current?.getContext("2d") ?? null;
  const repaint = useCallback(() => {
    const ctx = maskRef.current?.getContext("2d");
    if (ctx && mask.w > 0) replay(ctx as StrokeCtx, history.current, mask, accentColor());
  }, [mask]);

  // Size the painting canvas once the image is known, and redraw it whenever the stage remounts.
  useEffect(() => {
    const c = maskRef.current;
    if (!c || mask.w === 0) return;
    if (c.width !== mask.w || c.height !== mask.h) {
      c.width = mask.w;
      c.height = mask.h;
    }
    repaint();
  }, [mask, done, repaint]);

  const effectiveTool: Tool = altDown ? "unpaint" : tool;
  const scale = img && img.w > 0 ? fitScale(box, { w: img.w, h: img.h }) || 1 : 1;
  const dispW = img ? img.w * scale * view.zoom : 0;
  const dispH = img ? img.h * scale * view.zoom : 0;

  const canvasRect = () => maskRef.current?.getBoundingClientRect();

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing) return;
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      panning.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const rect = canvasRect();
    if (!rect || rect.width <= 0 || mask.w === 0) return;
    const p = clientToMask(e.clientX, e.clientY, rect, mask);
    stroke.current = { kind: effectiveTool, size: brushToMask(settings.brush, rect, mask), points: [p] };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const ctx = ctx2d();
    if (ctx) drawStroke(ctx as StrokeCtx, stroke.current, accentColor());
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = stageRef.current?.getBoundingClientRect();
    if (st) setCursor({ x: e.clientX - st.left, y: e.clientY - st.top });
    if (panning.current) {
      const dx = e.clientX - panning.current.x;
      const dy = e.clientY - panning.current.y;
      panning.current = { x: e.clientX, y: e.clientY };
      setView((v) => ({ ...v, panX: v.panX + dx, panY: v.panY + dy }));
      return;
    }
    const s = stroke.current;
    const rect = canvasRect();
    if (!s || s.kind === "clear" || s.kind === "stamp" || !rect || rect.width <= 0) return;
    s.points.push(clientToMask(e.clientX, e.clientY, rect, mask));
    const ctx = ctx2d();
    if (ctx) drawStroke(ctx as StrokeCtx, s, accentColor(), s.points.length - 1);
  };

  const endStroke = () => {
    panning.current = null;
    const s = stroke.current;
    stroke.current = null;
    if (!s) return;
    history.current.push(s);
    setRev((n) => n + 1);
  };

  const undo = useCallback(() => {
    if (history.current.undo()) {
      repaint();
      setRev((n) => n + 1);
    }
  }, [repaint]);
  const redo = useCallback(() => {
    if (history.current.redo()) {
      repaint();
      setRev((n) => n + 1);
    }
  }, [repaint]);
  // A saved mask becomes the starting mask: drawn scaled to this photo, one undo step.
  const loadSavedMask = useCallback(
    async (m: EraserSavedMask): Promise<boolean> => {
      if (mask.w === 0) return false;
      try {
        const url = await EraserService.SavedMaskImage(m.id);
        const stampCanvas = await loadMaskStamp(url, mask, parseColor(accentColor()));
        if (!stampCanvas) throw new Error("decode");
        history.current.push({ kind: "stamp", image: stampCanvas, w: mask.w, h: mask.h });
        repaint();
        setRev((n) => n + 1);
        return true;
      } catch {
        toast({ title: `Couldn't load “${m.name}”`, tone: "danger" });
        return false;
      }
    },
    [mask, repaint],
  );
  const clearMask = useCallback(() => {
    if (!history.current.hasPaint) return;
    history.current.push({ kind: "clear" });
    repaint();
    setRev((n) => n + 1);
  }, [repaint]);

  // ---- zoom / pan ----

  const zoomBy = useCallback((factor: number, px = 0, py = 0) => setView((v) => zoomAround(v, factor, px, py)), []);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, !!img, done]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- running ----

  const hasPaint = history.current.hasPaint;
  void rev;
  const canErase = editing && hasPaint && !gate.blocked && !submitting;

  const erase = async () => {
    const c = maskRef.current;
    if (!canErase || !c || !path || !img) return;
    if (canvasIsEmpty(c, maskIsEmpty)) {
      toast({ title: "Paint over what to erase first", tone: "warn" });
      return;
    }
    const data = exportMaskPNG(c, img.w, img.h);
    if (!data) {
      setSubmitError({ message: "Couldn't read the mask from the canvas" });
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const j = await EraserService.Erase(path, data, { model: settings.model, maskPath: "", note: "" });
      setJobId(j.id);
    } catch (e) {
      const a = toAppError(e);
      setSubmitError({ message: a.message, hint: a.hint });
    } finally {
      setSubmitting(false);
    }
  };

  const keepErasing = () => {
    if (!output) return;
    setJobId("");
    setPath(output.path);
  };

  const editAgain = () => setJobId("");

  // ---- keys ----

  const live = useRef({ erase, undo, redo, clearMask, pick: inputs.pick, pickLibrary: inputs.pickLibrary });
  live.current = { erase, undo, redo, clearMask, pick: inputs.pick, pickLibrary: inputs.pickLibrary };
  useEffect(
    () =>
      onEraserAction((a) => {
        const l = live.current;
        if (a === "choose-file") void l.pick();
        else if (a === "choose-library") void l.pickLibrary();
        else if (a === "erase") void l.erase();
        else if (a === "undo") l.undo();
        else if (a === "redo") l.redo();
        else l.clearMask();
      }),
    [],
  );

  useShortcut("Enter", () => void erase(), { when: canErase && embedFocus.active });
  useShortcut("B", () => setTool("brush"), { when: editing && embedFocus.active });
  useShortcut("E", () => setTool("unpaint"), { when: editing && embedFocus.active });
  useShortcut("[", () => setSettings((s) => ({ ...s, brush: clampBrush(s.brush * 0.8) })), { when: editing && embedFocus.active });
  useShortcut("]", () => setSettings((s) => ({ ...s, brush: clampBrush(s.brush * 1.25 + 1) })), { when: editing && embedFocus.active });
  useShortcut("Mod+Backspace", clearMask, { when: editing && embedFocus.active, allowInInputs: true });
  useShortcut("Mod+Z", undo, { when: editing && embedFocus.active, allowInInputs: true });
  useShortcut(["Mod+Shift+Z", "Mod+Y"], redo, { when: editing && embedFocus.active, allowInInputs: true });

  useEffect(() => {
    if (!editing || !embedFocus.active) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        e.preventDefault();
        setAltDown(true);
      } else if (e.key === " " && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltDown(false);
      else if (e.key === " ") setSpaceDown(false);
    };
    const blur = () => {
      setAltDown(false);
      setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [editing, embedFocus.active]);

  // ---- render ----

  const header = file ? (
    <ToolHeader aria-label="Object Eraser">
      <span className={styles.fileName} data-tip={path ?? file.path}>
        <span>{baseName(path ?? file.path)}</span>
        <Button
          size="sm"
          variant="ghost"
          data-tip="Drop this photo and pick another one"
          onClick={() => {
            inputs.clear();
            void inputs.pick();
          }}
        >
          Choose another
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="history"
          collapsible
          data-tip="Pick another photo from the Library; this one is closed"
          onClick={() => {
            inputs.clear();
            void inputs.pickLibrary();
          }}
        >
          From Library…
        </Button>
      </span>
    </ToolHeader>
  ) : null;

  if (!file) {
    return (
      <ClickInHost>
        <section ref={embedFocus.ref} className={cx(styles.root, styles.rootEmpty)} aria-label="Object Eraser">
          <DepsGate moduleId={moduleId} />
          <div className={styles.empty}>
            <DropZone id="eraser-drop" className={styles.fullDrop} label="Drop a photo" hint="Paint over what you want gone, then erase it." icon="eraser">
              <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", justifyContent: "center" }}>
                <Button variant="secondary" icon="folder-open" data-tip="Pick the photo you want to remove things from" onClick={() => void inputs.pick()}>
                  Choose photo
                </Button>
                <Button variant="secondary" icon="history" data-tip="Pick a photo Toolbox already made (the Library)" onClick={() => void inputs.pickLibrary()}>
                  From Library…
                </Button>
              </div>
            </DropZone>
            <RecentResults
              moduleId={moduleId}
              kinds={[OutputKind.KindImage]}
              icon="image"
              label="Recent"
              tip="Photos this tool made before. Double-click one to keep editing it; Show in folder, Open and Save a copy are on each row"
              onPick={(p) => void inputs.add([p])}
            />
          </div>
        </section>
      </ClickInHost>
    );
  }

  const modelOptions = [
    { value: EraserModel.ModelBest, label: "Best", tip: "Highest quality fill with cleaner textures; slower and a larger first-use model download" },
    { value: EraserModel.ModelFast, label: "Fast", tip: "Quicker with a smaller model; good for small objects, may look smeared on large areas" },
  ];
  const current = models.find((m) => m.id === settings.model);
  const needsDownload = current && !current.present && current.downloadBytes > 0;
  const modelSummary = summarizeModel(settings.model, current);
  const zoomPct = Math.round(scale * view.zoom * 100);
  const cursorSize = settings.brush;
  const showCursor = editing && cursor && !spaceDown && !panning.current;
  const failed = job && (job.status === "failed" || job.status === "cancelled") ? job : undefined;

  return (
    <ClickInHost>
    <section ref={embedFocus.ref} className={styles.root} aria-label="Object Eraser">
      {header}
      <DepsGate moduleId={moduleId} />

      {loadError && (
        <Banner tone="danger" title={loadError}>
          {path && !canPaintOn(path) ? "The engine can still erase it once it is converted." : undefined}
        </Banner>
      )}

      {!done && (
        <div className={styles.toolbar} role="toolbar" aria-label="Painting tools" data-tip="Paint over what you want gone, then press Erase">
          <SegmentedControl
            aria-label="Tool"
            size="sm"
            value={effectiveTool}
            onChange={(t) => setTool(t)}
            options={[
              { value: "brush", label: "Brush", tip: "Paint over the things to remove. Hold Alt to unpaint temporarily" },
              { value: "unpaint", label: "Unpaint", tip: "Rub out part of your mask where you painted too much" },
            ]}
            disabled={!editing}
          />
          <div className={styles.brush}>
            <label className={styles.label} htmlFor="eraser-brush" data-tip="Brush diameter in screen pixels; use [ and ] to change it">
              Size
            </label>
            <div data-tip="Brush diameter in screen pixels; use [ and ] to change it">
            <Slider id="eraser-brush" min={4} max={300} value={settings.brush} onChange={(brush) => setSettings((s) => ({ ...s, brush: clampBrush(brush) }))} format={(v) => `${v}px`} disabled={!editing} />
            </div>
          </div>
          <IconButton size="sm" icon="undo-2" label="Undo" data-tip="Undo the last brush stroke" kbd="Mod+Z" disabled={!editing || !history.current.canUndo} onClick={undo} />
          <IconButton size="sm" icon="redo-2" label="Redo" data-tip="Bring back the stroke you undid" kbd="Mod+Shift+Z" disabled={!editing || !history.current.canRedo} onClick={redo} />
          <IconButton size="sm" icon="trash-2" label="Clear mask" data-tip="Remove all your painting and start the mask again" kbd="Mod+Backspace" disabled={!editing || !hasPaint} onClick={clearMask} />
          <span className={styles.spacer} />
          <IconButton size="sm" icon="zoom-out" label="Zoom out" data-tip="Zoom out; Ctrl or Cmd with the mouse wheel also zooms" disabled={!img} onClick={() => zoomBy(1 / 1.25)} />
          <span className={styles.zoom} data-tip="Current zoom level of the picture">{img ? `${zoomPct}%` : ""}</span>
          <IconButton size="sm" icon="zoom-in" label="Zoom in" data-tip="Zoom in for precise painting; hold Space and drag to move around" disabled={!img} onClick={() => zoomBy(1.25)} />
          <MenuButton
            size="sm"
            variant="ghost"
            icon="maximize-2"
            label="Fit and actual size"
            tip="Zoom to fit the window, or show the photo at its real pixel size"
            items={() => [
              { id: "fit", label: "Fit to window", tip: "Zoom so the whole photo fits in the window", disabled: !img, onSelect: () => setView(FIT_VIEW) },
              { id: "actual", label: "Actual size (100%)", tip: "Show the photo at its real pixel size", disabled: !img || img.w === 0, onSelect: () => setView({ zoom: actualSizeZoom(box, { w: img?.w ?? 0, h: img?.h ?? 0 }), panX: 0, panY: 0 }) },
            ]}
          />
        </div>
      )}

      {done && output && (
        <div className={styles.toolbar} aria-label="Result">
          <SegmentedControl
            aria-label="Result view"
            size="sm"
            value={resultMode}
            onChange={setResultMode}
            options={[
              { value: "compare", label: "Before / After", tip: "Drag the divider to compare the original with the erased result" },
              { value: "result", label: "Result", tip: "Show only the finished photo" },
            ]}
          />
          <span className={styles.spacer} />
          <span className={styles.resultName} data-tip={output.path}>
            {output.name}
          </span>
          <span className={styles.label} data-tip={`Saved automatically in your library: ${output.path}`}>
            {formatBytes(output.sizeBytes)} · saved in {parentName(output.path)}
          </span>
          <FileActions outputId={output.id} path={output.path} />
        </div>
      )}

      <div className={styles.canvasArea}>
        {done && output ? (
          <div className={styles.resultBox}>
            {afterUrl && img ? (
              resultMode === "compare" ? (
                <CompareSlider before={img.url} after={afterUrl} beforeLabel="Before" afterLabel="After" aspect={img.w > 0 && img.h > 0 ? img.w / img.h : 4 / 3} aria-label="Before and after" />
              ) : (
                <img className={styles.resultImg} src={afterUrl} alt="Erased result" />
              )
            ) : (
              <span className={styles.hint} role="status">
                Loading the result…
              </span>
            )}
          </div>
        ) : (
          <div
            ref={stageRef}
            className={cx(styles.stage, spaceDown && styles.grab, editing && !spaceDown && styles.paint)}
            data-testid="stage"
            data-tip={editing ? "Click and drag to paint over what to remove; Space plus drag pans, Ctrl or Cmd plus wheel zooms" : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={() => setCursor(null)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {img ? (
              <div className={styles.board} style={{ width: dispW || undefined, height: dispH || undefined, transform: `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px))` }}>
                <img
                  className={styles.photo}
                  src={img.url}
                  alt="Photo to edit"
                  draggable={false}
                  onLoad={(e) => {
                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                    if (w > 0 && h > 0) setImg((cur) => (cur && cur.w === 0 ? { ...cur, w, h } : cur));
                  }}
                  onError={() => setLoadError("This photo can't be opened")}
                />
                <canvas ref={maskRef} className={styles.mask} aria-label="Mask" data-tip={editing ? "Your painted mask: everything painted will be removed and filled in" : "Your painted mask"} />
              </div>
            ) : !loadError ? (
              <span className={styles.hint} role="status">
                Loading…
              </span>
            ) : null}
            {showCursor && cursor && <span className={styles.cursor} aria-hidden style={{ width: cursorSize, height: cursorSize, left: cursor.x, top: cursor.y }} />}
            {running && job && (
              <div className={styles.overlay} role="status">
                <div className={styles.overlayCard}>
                  <Meter value={job.progress} label="Erase progress" />
                  <span className={styles.stageText}>{job.message || "Starting…"}</span>
                  <Button size="sm" variant="secondary" data-tip="Stop erasing; your mask is kept" onClick={() => void JobsService.Cancel(job.id).catch(() => undefined)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {submitError && (
        <Banner tone="danger" title={submitError.message}>
          {submitError.hint}
        </Banner>
      )}
      {failed && (
        <Banner tone={failed.status === "failed" ? "danger" : "warn"} title={failed.status === "failed" ? failed.error || "The erase failed" : "Erase cancelled"}>
          {failed.status === "failed" ? failed.errorHint : "Your mask is still there."}
        </Banner>
      )}

      <div className={styles.footer}>
        {done && output ? (
          <>
            <span className={styles.hint} data-tip="Photo size in pixels, width by height">
              {img ? `${img.w} × ${img.h}` : ""}
            </span>
            <Button variant="secondary" data-tip="Go back to your mask to paint more and erase again from the original" onClick={editAgain}>
              Edit mask again
            </Button>
            <Button variant="primary" icon="eraser" data-tip="Use the result as the new starting photo and remove more things from it" onClick={keepErasing}>
              Keep erasing on the result
            </Button>
          </>
        ) : (
          <>
            <ClickIn icon="cpu" title="Model" summary={modelSummary} tip="Speed and quality of the fill, and whether the model must be downloaded" width={340} className={styles.modelRow}>
              <div className={styles.models}>
                <SegmentedControl aria-label="Model" size="sm" value={settings.model} onChange={(model) => setSettings((s) => ({ ...s, model }))} options={modelOptions} disabled={running} />
                <span className={styles.hint} data-tip="Speed and quality of the selected model, and whether it must be downloaded">
                  {modelHint(models)}
                  {needsDownload && current ? ` · downloads ${Math.round(current.downloadBytes / (1024 * 1024))} MB on first use` : ""}
                </span>
              </div>
            </ClickIn>
            <SavedMasks
              canSave={editing && hasPaint}
              getMaskPNG={() => (maskRef.current && img ? exportMaskPNG(maskRef.current, img.w, img.h) : "")}
              onLoad={loadSavedMask}
              canLoad={editing && mask.w > 0}
              suggestName={baseName(path ?? file.path).replace(/.[^.]+$/, "")}
            />
            <span className={styles.spacer} />
            {gate.blocked && <span className={styles.hint}>{gate.reason}</span>}
            <Button
              variant="primary"
              icon="eraser"
              kbd="Enter"
              loading={submitting}
              disabled={!canErase}
              data-tip={canErase ? "Remove everything you painted and fill it in to match the surroundings" : gate.blocked ? gate.reason : !hasPaint ? "Paint over what to erase first" : "Wait for the photo to load"}
              onClick={() => void erase()}>
              Erase
            </Button>
          </>
        )}
      </div>
    </section>
    </ClickInHost>
  );
}
