import { useEffect } from "react";
import { isEditableTarget } from "@/lib/shortcuts";
import { useUI } from "@/state/ui";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? []));
}

/** Sends pasted http(s) links to the downloader when focus isn't in an input. */
export function useGlobalPaste(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const urls = extractUrls(e.clipboardData?.getData("text/plain") ?? "");
      if (urls.length === 0) return;
      e.preventDefault();
      useUI.getState().handOff({ moduleId: "downloader", inputs: urls });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}
