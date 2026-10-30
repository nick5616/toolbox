/**
 * The Lyric Video session: the song, its title/artist, the lyric sheet and its
 * undo history. It lives in a store (not in the view) so it survives switching
 * to another tool and back (SPEC.md §9.2, §9.4). Look and options are remembered
 * separately through the module state.
 */
import { useCallback } from "react";
import { create } from "zustand";
import { editorReducer, newHistory, type EditorAction, type History, type Row } from "./logic";

export interface SessionData {
  songPath: string | null;
  meta: { title: string; artist: string };
  /** Pasted lyrics (align source). */
  text: string;
  lyricsPath: string;
  history: History<Row[]>;
  matched: number | null;
  noLyrics: boolean;
  /** An instrumental exists for this song (2-stem cache or the Visualizer's 4-stem mix). */
  hasInstrumental: boolean;
  /** "Also save the stems to the Library" on the Visuals step (never remembered). */
  saveStems: boolean;
}

export function initialSession(): SessionData {
  return {
    songPath: null,
    meta: { title: "", artist: "" },
    text: "",
    lyricsPath: "",
    history: newHistory<Row[]>([]),
    matched: null,
    noLyrics: false,
    hasInstrumental: false,
    saveStems: false,
  };
}

export const useSession = create<SessionData>(() => initialSession());

/** Forgets the whole session (tests, and a fresh start). */
export function resetSession(): void {
  useSession.setState(initialSession(), true);
}

type Setter<T> = (v: T | ((prev: T) => T)) => void;

/** A `[value, setValue]` pair for one session field, like useState. */
export function useSessionField<K extends keyof SessionData>(key: K): [SessionData[K], Setter<SessionData[K]>] {
  const value = useSession((s) => s[key]);
  const set = useCallback<Setter<SessionData[K]>>(
    (v) => {
      useSession.setState((s) => {
        const next = typeof v === "function" ? (v as (p: SessionData[K]) => SessionData[K])(s[key]) : v;
        return { [key]: next } as Pick<SessionData, K>;
      });
    },
    [key],
  );
  return [value, set];
}

/** Applies an editor action to the sheet's history. */
export function dispatchSheet(a: EditorAction): void {
  useSession.setState((s) => ({ history: editorReducer(s.history, a) }));
}
