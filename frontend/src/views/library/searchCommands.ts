import { toast } from "@/components";
import { useCommands, type Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { useLibrary } from "@/state/library";
import { useSearch } from "@/state/search";
import { useUI } from "@/state/ui";
import { baseOf } from "./items";

/** Opens the Library with the search box focused. */
export function focusLibrarySearch(): void {
  useSearch.getState().requestFocus();
  useUI.getState().navigate("library");
}

/** Shows the files that look most like the Library's selected file. */
export function findSimilarToSelected(): void {
  const { selectedPath, selectedPos } = useSearch.getState();
  if (!selectedPath) return;
  useSearch.getState().setSimilar({ path: selectedPath, pos: selectedPos, name: baseOf(selectedPath) });
  useLibrary.getState().setFilters({ search: "" });
  if (useLibrary.getState().view === "things") useLibrary.getState().setView("grid");
  useUI.getState().navigate("library");
}

/**
 * The Smart search palette entries: "Search pictures and text for…", "Find
 * similar to selected" and "Pause indexing" / "Resume indexing". Mounted by
 * the Library; the shell may also call it (ids are deduplicated).
 */
export function useSearchCommands(): void {
  const installed = useSearch((s) => s.status.installed);
  const paused = useSearch((s) => s.status.paused);
  const cmds: Command[] = [
    { id: "search.focus", title: "Search pictures and text for…", section: "Actions", icon: "search", keywords: ["find", "photos", "images", "ocr", "library"], run: focusLibrarySearch },
    {
      id: "search.similar",
      title: "Find similar to selected",
      section: "Actions",
      icon: "scan-search",
      keywords: ["look alike", "similar pictures", "library"],
      enabled: () => installed && useSearch.getState().selectedPath !== "",
      run: findSimilarToSelected,
    },
    {
      id: "search.toggle-pause",
      title: paused ? "Resume indexing" : "Pause indexing",
      section: "Actions",
      icon: paused ? "play" : "pause",
      keywords: ["smart search", "index"],
      enabled: () => installed,
      run: () =>
        useSearch
          .getState()
          .saveSettings({ paused: !paused })
          .catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message })),
    },
  ];
  useCommands(cmds, [installed, paused]);
}
