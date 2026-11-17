import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { bootstrap, bootstrapPopup } from "@/state/bootstrap";
import { usePacksSync } from "@/state/packs";
import { useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { preloadToolView } from "@/lib/toolActions";
import { currentWindow, type WindowIdentity } from "@/lib/windows";
import { BootError } from "@/views/BootError";
import { TooltipLayer } from "@/components/TooltipLayer";

// Each window kind loads only its own shell. The chunks are requested at module
// load, in parallel with bootstrap(), so there is no import waterfall.
const load = {
  popup: () => import("@/shell/PopupShell"),
  tool: () => import("@/shell/ToolWindowShell"),
  part: () => import("@/shell/PartWindowShell"),
  shell: () => import("@/shell/Shell"),
  renderHost: () => import("@/viz/RenderHost"),
  setup: () => import("@/views/setup/SetupView"),
  tools: () => import("@/tools"),
  parts: () => import("@/parts"),
};

const PopupShell = lazy(() => load.popup().then((m) => ({ default: m.PopupShell })));
const ToolWindowShell = lazy(() => load.tool().then((m) => ({ default: m.ToolWindowShell })));
const PartWindowShell = lazy(() => load.part().then((m) => ({ default: m.PartWindowShell })));
const Shell = lazy(() => load.shell().then((m) => ({ default: m.Shell })));
const RenderHost = lazy(load.renderHost);
const SetupView = lazy(() => load.setup().then((m) => ({ default: m.SetupView })));
const VizLab = lazy(() => import("@/viz/lab/VizLab"));
const PaintLab = lazy(() => import("@/paint/paintlab/PaintLab"));

/** Starts downloading what this window kind needs first. Resolves when it has (failures are left to the lazy components). */
function preloadWindow(w: WindowIdentity): Promise<unknown> {
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  switch (w.kind) {
    case "popup":
      return quiet(load.popup());
    case "tool":
      return quiet(Promise.all([load.tool(), load.tools().then(() => preloadToolView(w.view))]));
    case "part":
      return quiet(Promise.all([load.part(), load.parts().then((m) => m.loadPartHost(w.part))]));
    case "main":
      return quiet(Promise.all([load.shell().then((m) => m.preloadShellView(useUI.getState().view)), load.renderHost(), load.tools().then(() => preloadToolView(useUI.getState().view))]));
    default:
      return Promise.resolve();
  }
}

type BootState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: AppErrorShape };

/** Which window this JS context renders: `/?window=popup&view=<id>` or the main shell. */
export function windowKind(search: string = window.location.search): { popup: boolean; view: string; vizlab: boolean } {
  const q = new URLSearchParams(search);
  return { popup: q.get("window") === "popup", view: q.get("view") ?? "", vizlab: q.get("window") === "vizlab" };
}

/** The main window: first-run setup until `setup.done`, then the shell. */
function MainWindow() {
  usePacksSync();
  const done = useSettings((s) => s.settings.setup.done);
  return (
    <Suspense fallback={null}>
      <RenderHost />
      <TooltipLayer />
      {done ? <Shell /> : <SetupView />}
    </Suspense>
  );
}

/** Tool and part windows share the full data bootstrap but never mount the render host (main only). */
function ToolWindow({ view }: { view: string }) {
  usePacksSync();
  return <ToolWindowShell view={view} />;
}

function PartWindow({ part }: { part: string }) {
  usePacksSync();
  return <PartWindowShell part={part} />;
}

// Started once per page, before React renders; skipped in tests (they import App only for windowKind).
const startup: Promise<unknown> = import.meta.env.MODE === "test" ? Promise.resolve() : preloadWindow(currentWindow());

const quiet = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

export function App() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });
  const [win] = useState(() => currentWindow());

  useEffect(() => {
    const ready = (win.kind === "popup" ? bootstrapPopup() : bootstrap()).then(async () => {
      await startup;
      // The first-run setup view is fetched only when it will be shown, so it doesn't flash in.
      if (win.kind === "main" && !useSettings.getState().settings.setup.done) await load.setup().catch(() => undefined);
    });
    ready.then(
      () => setBoot({ kind: "ready" }),
      (e: unknown) => setBoot({ kind: "error", error: toAppError(e) }),
    );
  }, [win.kind]);

  if (boot.kind === "loading") return null;
  if (boot.kind === "error") return <BootError error={boot.error} onReload={() => window.location.reload()} />;
  switch (win.kind) {
    case "vizlab":
      return quiet(<VizLab />);
    case "paintlab":
      return quiet(<PaintLab />);
    case "popup":
      return quiet(<PopupShell view={win.view} />);
    case "tool":
      return quiet(<ToolWindow view={win.view} />);
    case "part":
      return quiet(<PartWindow part={win.part} />);
    default:
      return <MainWindow />;
  }
}
