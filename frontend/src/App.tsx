import { useEffect, useState } from "react";
import { bootstrap, bootstrapPopup } from "@/state/bootstrap";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { PopupShell } from "@/shell/PopupShell";
import { Shell } from "@/shell/Shell";
import { BootError } from "@/views/BootError";

type BootState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; error: AppErrorShape };

/** Which window this JS context renders: `/?window=popup&view=<id>` or the main shell. */
export function windowKind(search: string = window.location.search): { popup: boolean; view: string } {
  const q = new URLSearchParams(search);
  return { popup: q.get("window") === "popup", view: q.get("view") ?? "" };
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
  return win.popup ? <PopupShell view={win.view} /> : <Shell />;
}
