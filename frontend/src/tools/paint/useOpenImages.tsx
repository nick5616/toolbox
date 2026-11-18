/**
 * Opening pictures as new canvases: the picker, drops and hand-offs all go
 * through `openPaths`. A picture over the limits (8192 px per side, 40 MP)
 * asks first: "Scale down to fit" or Cancel. `.ora` files become projects
 * with their layers.
 */
import { useCallback, useState, type ReactNode } from "react";
import { pickFromLibrary } from "@/blocks/library-picker";
import { toast } from "@/components/toast";
import { FilesService, PaintService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { IMAGE_PICK_EXTS, MAX_PIXELS, MAX_SIDE, baseNameNoExt, fitSize, isOra } from "./limits";
import { Dialog, TextButton } from "./ui";

interface Ask {
  path: string;
  w: number;
  h: number;
  resolve(v: "fit" | "cancel"): void;
}

export interface OpenImages {
  /** Opens each path as a new canvas; resolves with the new project ids (cancelled or failed ones are skipped). */
  openPaths(paths: string[]): Promise<string[]>;
  /** The native picker, then `openPaths`. */
  pick(): Promise<string[]>;
  /** The Library picker (files Toolbox already made), then `openPaths`. */
  pickLibrary(): Promise<string[]>;
  /** Render this once: the over-limit offer. */
  dialogs: ReactNode;
}

export function useOpenImages(): OpenImages {
  const [ask, setAsk] = useState<Ask | null>(null);

  const openOne = useCallback(async (path: string): Promise<string | null> => {
    const name = baseNameNoExt(path);
    if (isOra(path)) return PaintService.ImportORA(path);
    let fit = false;
    try {
      const s = await FilesService.ImageSize(path);
      if (s.w > MAX_SIDE || s.h > MAX_SIDE || s.w * s.h > MAX_PIXELS) {
        const choice = await new Promise<"fit" | "cancel">((resolve) => setAsk({ path, w: s.w, h: s.h, resolve }));
        setAsk(null);
        if (choice === "cancel") return null;
        fit = true;
      }
    } catch {
      /* unknown size: let the backend decide */
    }
    return PaintService.CreateFromImage(path, name, fit);
  }, []);

  const openPaths = useCallback(
    async (paths: string[]): Promise<string[]> => {
      const ids: string[] = [];
      for (const p of paths) {
        try {
          const id = await openOne(p);
          if (id) ids.push(id);
        } catch (e) {
          toast({ title: `Couldn't open ${baseNameNoExt(p)}`, description: toAppError(e).message, tone: "danger" });
        }
      }
      return ids;
    },
    [openOne],
  );

  const pick = useCallback(async () => {
    const paths = (await FilesService.PickWith("Open a picture or OpenRaster file", IMAGE_PICK_EXTS, true)) ?? [];
    return paths.length ? openPaths(paths) : [];
  }, [openPaths]);

  const fitted = ask ? fitSize(ask.w, ask.h) : null;
  const dialogs = ask ? (
    <Dialog
      title="This picture is bigger than a canvas can be"
      onClose={() => ask.resolve("cancel")}
      actions={
        <>
          <TextButton tip="Don't open this picture" onClick={() => ask.resolve("cancel")}>
            Cancel
          </TextButton>
          <TextButton primary tip="Open a copy scaled down to the largest size a canvas can be; the original file is never changed" onClick={() => ask.resolve("fit")}>
            Scale down to fit
          </TextButton>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        It's {ask.w} × {ask.h} px. A canvas can be at most {MAX_SIDE} px on a side and {MAX_PIXELS / 1e6} megapixels.
        {fitted ? ` Scaled down it becomes ${fitted.w} × ${fitted.h} px.` : ""}
      </p>
    </Dialog>
  ) : null;

  const pickLibrary = useCallback(async () => {
    const paths = await pickFromLibrary({ title: "Open a picture from Library", exts: IMAGE_PICK_EXTS, multiple: true });
    return paths.length ? openPaths(paths) : [];
  }, [openPaths]);

  return { openPaths, pick, pickLibrary, dialogs };
}
