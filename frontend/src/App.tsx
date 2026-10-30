import { lazy, Suspense, useEffect, useState } from "react";
import { bootstrap, bootstrapPopup } from "@/state/bootstrap";
import { usePacksSync } from "@/state/packs";
import { useSettings } from "@/state/settings";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { PopupShell } from "@/shell/PopupShell";
import { Shell } from "@/shell/Shell";
import { BootError } from "@/views/BootError";
import { SetupView } from "@/views/setup/SetupView";
import RenderHost from "@/viz/RenderHost";

const VizLab = lazy(() => import("@/viz/lab/VizLab"));

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
    <>
      <RenderHost />
      {done ? <Shell /> : <SetupView />}
    </>
  );
}

export function App() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });
  const [win] = useState(() => windowKind());

  useEffect(() => {
    (win.popup ? bootstrapPopup() : bootstrap()).then(
      () => setBoot({ kind: "ready" }),
      (e: unknown) => setBoot({ kind: "error", error: toAppError(e) }),
    );
  }, [win.popup]);

  if (boot.kind === "loading") return null;
  if (boot.kind === "error") return <BootError error={boot.error} onReload={() => window.location.reload()} />;
  if (win.vizlab)
    return (
      <Suspense fallback={null}>
        <VizLab />
      </Suspense>
    );
  return win.popup ? <PopupShell view={win.view} /> : <MainWindow />;
}
