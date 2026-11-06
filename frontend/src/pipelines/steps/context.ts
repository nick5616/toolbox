import { createContext, useContext, useEffect, useState } from "react";

/** The id of the pipeline being edited ("" when unknown); "Run another pipeline" leaves it out of its list. */
export const CurrentPipelineContext = createContext<string>("");

export function useCurrentPipelineId(): string {
  return useContext(CurrentPipelineContext);
}

export interface Loaded<T> {
  items: T[];
  loading: boolean;
  failed: boolean;
}

/** Loads a list once when an editor opens (saved compositions, masks…); never throws. */
export function useLoadedList<T>(load: () => Promise<T[] | null>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ items: [], loading: true, failed: false });
  useEffect(() => {
    let live = true;
    load().then(
      (items) => {
        if (live) setState({ items: items ?? [], loading: false, failed: false });
      },
      () => {
        if (live) setState({ items: [], loading: false, failed: true });
      },
    );
    return () => {
      live = false;
    };
    // The loader is a module-level function; the list is read once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}
