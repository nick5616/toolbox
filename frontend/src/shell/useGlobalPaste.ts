import { useEffect } from "react";
import { FilesService, ModulesService } from "@/lib/api";
import type { FilesDropped } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { toast } from "@/components";
import { isEditableTarget } from "@/lib/shortcuts";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { routeFilesDropped } from "./dropRouting";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? []));
}

/** Where pasted links go when the current view does not take them. */
export const LINK_FALLBACK = "downloader";

/**
 * Hands pasted links to a tool. The current view gets them when it takes
 * links (Web Archiver, Downloader…); otherwise the Downloader does, and the
 * toast offers Undo, which goes back to where the user was.
 */
export function routePastedLinks(urls: string[]): void {
  const ui = useUI.getState();
  const here = ui.view;
  const mod = useModules.getState().byId[here];
  if (mod?.accepts.urls) {
    ui.handOff({ moduleId: here, inputs: urls });
    return;
  }
  ui.handOff({ moduleId: LINK_FALLBACK, inputs: urls });
  const name = useModules.getState().byId[LINK_FALLBACK]?.name ?? "Downloader";
  toast({
    title: `Sent ${urls.length === 1 ? "the link" : `${urls.length} links`} to ${name}`,
    action: {
      label: "Undo",
      onClick: () => {
        const cur = useUI.getState();
        // Not picked up yet (the tool had not mounted): take it back.
        if (cur.handoff?.moduleId === LINK_FALLBACK) useUI.setState({ handoff: null });
        cur.navigate(here);
      },
    },
  });
}

const readClipboardFiles = (): Promise<string[] | null> => FilesService.ClipboardFiles();

/**
 * Files copied in Explorer/Finder, or an image on the clipboard, are read on
 * the Go side and handed to the current tool exactly like a drop on it.
 */
export async function routePastedFiles(): Promise<void> {
  let paths: string[] = [];
  try {
    paths = (await readClipboardFiles()) ?? [];
  } catch (e) {
    toast({ tone: "danger", title: toAppError(e).message });
    return;
  }
  if (paths.length === 0) return;
  let result = { matches: [], unmatched: paths } as FilesDropped["result"];
  try {
    result = await ModulesService.Match(paths);
  } catch {
    /* the current tool may still take them; the chooser would just be empty */
  }
  routeFilesDropped({ paths, result, targetId: "", window: "" });
}

/**
 * Pasting outside a text field: links go to a tool (see routePastedLinks),
 * copied files and screenshots go to the current tool like a drop.
 */
export function useGlobalPaste(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const urls = extractUrls(text);
      if (urls.length > 0) {
        e.preventDefault();
        routePastedLinks(urls);
        return;
      }
      // Plain text is not ours; files and images carry no text.
      const hasFiles = (e.clipboardData?.files.length ?? 0) > 0 || (e.clipboardData?.types ?? []).includes("Files");
      if (hasFiles || text === "") {
        e.preventDefault();
        void routePastedFiles();
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}
