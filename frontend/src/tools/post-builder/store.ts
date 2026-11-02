import { create } from "zustand";

/** "new" = always start a new post; "" = no choice made (use the open post, or start one). */
export type AddTarget = string;

interface AddToPostState {
  /** Where the next handoff to Post Builder should put its files. */
  target: AddTarget;
  setTarget: (t: AddTarget) => void;
  /** Returns and clears the target. */
  takeTarget: () => AddTarget;
}

/** Remembers the post chosen in the Library's "Add to post…" dialog until Post Builder takes the handoff. */
export const useAddToPost = create<AddToPostState>((set, get) => ({
  target: "",
  setTarget: (target) => set({ target }),
  takeTarget: () => {
    const t = get().target;
    if (t) set({ target: "" });
    return t;
  },
}));

export const NEW_POST = "new";
