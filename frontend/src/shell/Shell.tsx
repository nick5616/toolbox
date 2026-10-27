// STUB (foundation). WP-F replaces this file.
import { Suspense } from "react";
import { toolViews } from "@/tools";
import { useUI } from "@/state/ui";
import { LibraryView } from "@/views/LibraryView";
import { SettingsView } from "@/views/SettingsView";
import { ComingSoonView } from "@/views/ComingSoonView";

export function Shell() {
  const view = useUI((s) => s.view);
  const Tool = toolViews[view];
  return (
    <main data-file-drop-target>
      {view === "library" ? (
        <LibraryView />
      ) : view === "settings" ? (
        <SettingsView />
      ) : Tool ? (
        <Suspense fallback={null}>
          <Tool moduleId={view} />
        </Suspense>
      ) : (
        <ComingSoonView moduleId={view} />
      )}
    </main>
  );
}
