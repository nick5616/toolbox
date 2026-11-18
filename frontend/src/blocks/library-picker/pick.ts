import { create } from "zustand";
import { toast } from "@/components";
import type { LibraryPickOptions } from "./options";

// pickFromLibrary(): the in-app counterpart of FilesService.PickWith. Each
// window's shell mounts one <LibraryPickerHost/>, which shows the request.

interface Request {
  id: number;
  opts: LibraryPickOptions;
  resolve: (paths: string[]) => void;
}

export const useLibraryPick = create<{ req: Request | null }>(() => ({ req: null }));

let seq = 0;
let hosts = 0;

/** Called by LibraryPickerHost on mount; returns the unmount callback. */
export function registerLibraryPickerHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    if (hosts === 0) finishLibraryPick(useLibraryPick.getState().req?.id ?? -1, []);
  };
}

/**
 * Asks the user for files Toolbox already made (and, for pictures, saved
 * compositions). Resolves with the chosen paths, or [] when cancelled. A
 * second call replaces an open request (the first resolves with []).
 */
export function pickFromLibrary(opts: LibraryPickOptions = {}): Promise<string[]> {
  if (hosts === 0) {
    toast({ tone: "warn", title: "The Library picker isn't available in this window" });
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const prev = useLibraryPick.getState().req;
    useLibraryPick.setState({ req: { id: ++seq, opts, resolve } });
    prev?.resolve([]);
  });
}

/** Resolves request id (once) and closes it. */
export function finishLibraryPick(id: number, paths: string[]): void {
  const req = useLibraryPick.getState().req;
  if (!req || req.id !== id) return;
  useLibraryPick.setState({ req: null });
  req.resolve(paths);
}
