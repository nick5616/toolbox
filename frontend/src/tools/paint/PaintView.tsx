import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useIsEmbedded, useToolHandoff } from "@/lib/embed";
import { useMediaQuery } from "@/lib/media";
import { useShortcut } from "@/lib/shortcuts";
import { useUI } from "@/state/ui";
import type { ToolViewProps } from "../index";
import Gallery from "./Gallery";
import { useOpenImages } from "./useOpenImages";
import "./ui/tokens.css";
import styles from "./PaintView.module.css";

// The editor (engine, panels, Lab) loads when a painting opens; the gallery is light.
/**
 * The real engine, library and AI queue go live when the editor first loads (the vitest suites keep the fakes).
 * Without WebGL 2 the real engine refuses to attach and the editor shows "Paint+ needs WebGL 2".
 */
async function loadEditor() {
  if (import.meta.env.MODE !== "test") (await import("./engine-real")).enableRealRuntime();
  return import("./Editor");
}
const Editor = lazy(loadEditor);

/**
 * Paint+ (Phase 19): the start-screen gallery and the editor, in Paint+'s own
 * design language (SPEC §0, §1.5, §1.6). Studio mode (F) takes the whole
 * window: the shell hides its sidebar and top bar while `useUI.studio` is on.
 */
export default function PaintView(_props: ToolViewProps) {
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const [imports, setImports] = useState<string[]>([]);
  const embedded = useIsEmbedded();
  const studioFlag = useUI((s) => s.studio);
  const studio = studioFlag && !embedded;
  const toggleStudio = useCallback(() => {
    if (!embedded) useUI.getState().setStudio(!useUI.getState().studio);
  }, [embedded]);
  const openImages = useOpenImages();
  const compact = useMediaQuery("(max-width: 1099px)") || useMediaQuery("(max-height: 659px)");
  const openRef = useRef(open);
  openRef.current = open;

  // Dropped, pasted or sent pictures: new canvases from the gallery, new layers in an open painting.
  useToolHandoff("paint", (h) => {
    if (h.inputs.length === 0) return;
    if (openRef.current) setImports(h.inputs);
    else
      void openImages.openPaths(h.inputs).then((ids) => {
        const id = ids[0];
        if (id) setOpen({ id, name: "" });
      });
  });
  useShortcut("f", toggleStudio, { when: !open });

  const clearImports = useCallback(() => setImports([]), []);
  return (
    <div className={styles.host} data-design="paint">
      {open ? (
        <Suspense fallback={<div className={styles.loading} role="status">Opening…</div>}>
          <Editor
            key={open.id}
            projectId={open.id}
            initialName={open.name}
            studio={studio}
            onToggleStudio={toggleStudio}
            onBack={() => setOpen(null)}
            onOpen={(id) => setOpen({ id, name: "" })}
            imports={imports}
            onImportsDone={clearImports}
          />
        </Suspense>
      ) : (
        <Gallery openImages={openImages} onOpen={(id) => setOpen({ id, name: "" })} studio={studio} onToggleStudio={toggleStudio} compact={compact} />
      )}
      {openImages.dialogs}
    </div>
  );
}
