/**
 * The pipeline being edited (Phase 11, SPEC §5.6): the draft, its undo history,
 * the node selected for the Step panel, and the autosave / re-check timers.
 *
 * One draft at a time, owned by the window that shows the editor (the host).
 * Part windows (popped-out panels) hold replicas through the workspace bridge:
 * the actions listed in `workspace.tsx` run on the host, so a replica never
 * saves, checks or starts a run. Everything crossing the bridge is JSON.
 */
import { create } from "zustand";
import { toast } from "@/components";
import { FilesService, PipelinesService, type ClipTrigger, type Pipeline, type PipelineCheck, type PipelineEntry, type PipelineStep, type ScheduleTrigger, type StepType } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { adoptParkedHistory, registerHistory } from "@/lib/parkedHistory";
import { newHistory, pushHistory, redo as redoHistory, undo as undoHistory, type History } from "@/lib/history";
import { normalizeEntry, usePipelines } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { newStepId, stepsOf, withEntry } from "./editorModel";
import { deleteSteps, duplicateSteps, INPUT_NODE, MAX_STEPS, parseLayout, serializeLayout, withSteps } from "./graphModel";
import { addTime, DEFAULT_TIME, WEEKDAYS } from "./scheduleModel";
import { unbindVar } from "./wiring";

export const SAVE_DELAY_MS = 600;
export const DESCRIBE_DELAY_MS = 250;

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

const EMPTY_CHECK: PipelineCheck = { ready: true, problems: [], missing: [], accepts: { extensions: [], urls: false, any: false }, steps: [] } as unknown as PipelineCheck;

export interface DraftState {
  pipelineId: string | null;
  draft: Pipeline | null;
  check: PipelineCheck;
  catalog: StepType[];
  /** The node whose options the Step panel shows. */
  stepId: string | null;
  watchMessage: string;
  /** Whether the "When I copy…" trigger is working, and why not (PipelineEntry.clip). */
  clipStatus: { active: boolean; message: string };
  /** Whether the schedule is working, when it fires next, and why not (PipelineEntry.schedule). */
  scheduleStatus: { active: boolean; message: string; next: number };
  runText: string;
  runCount: number;
  canUndo: boolean;
  canRedo: boolean;
  saveState: SaveState;
  dirty: boolean;
  hist: History<Pipeline> | null;

  open: (entry: PipelineEntry) => void;
  close: () => void;
  markDeleted: () => void;
  /** Applies `fn` to the draft; edits with the same non-empty `key` within 800 ms share one undo step. */
  edit: (fn: (p: Pipeline) => Pipeline, key?: string) => void;
  /** A change to the canvas only: saved, nothing to re-check. `undoable` for moved nodes, not for pan/zoom. */
  editLayout: (layout: string, undoable?: boolean) => void;
  undo: () => void;
  redo: () => void;
  select: (stepId: string | null) => void;
  patchStep: (id: string, patch: Partial<PipelineStep>) => void;
  keepTouched: (id: string) => void;
  removeStep: (id: string) => void;
  duplicateStep: (id: string) => void;
  /** Edits a run parameter: its label or its default (the name never changes). */
  updateParam: (name: string, patch: { label?: string; default?: string }) => void;
  /** Removes a run parameter and every wire that uses it. */
  removeParam: (name: string) => void;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setWatchEnabled: (enabled: boolean) => void;
  chooseFolder: () => Promise<void>;
  /** Edits the "When I copy…" trigger. */
  setClip: (patch: Partial<ClipTrigger>) => void;
  /** Edits the schedule trigger. */
  setSchedule: (patch: Partial<ScheduleTrigger>) => void;
  openClipboardSettings: () => void;
  openRuns: () => void;
  setLive: (v: Partial<Pick<DraftState, "watchMessage" | "clipStatus" | "scheduleStatus" | "runText" | "runCount" | "catalog">>) => void;
  /** Saves now if dirty. */
  flush: () => Promise<void>;
}

/** Steps whose Keep the user set by hand (so wiring never overrides it). */
export const touchedKeep = new Set<string>();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let describeTimer: ReturnType<typeof setTimeout> | undefined;
let describeSeq = 0;
let saving = false;
let resave = false;
let deleted = false;
/** A draft that couldn't be saved before a pop-out; applied by `open` for the same pipeline. */
let stash: Pipeline | null = null;

/** Keeps an unsaved draft for the next `open` of the same pipeline (the tool reopened in another window). */
export function stashDraft(p: Pipeline | null): void {
  stash = p;
}

function normalizeCheck(pipeline: Pipeline, check: PipelineCheck): PipelineCheck {
  return normalizeEntry({ pipeline, check, watch: { active: false, message: "" }, clip: { active: false, message: "" }, schedule: { active: false, message: "", next: 0 }, lastRun: null }).check;
}

/** Saves a pipeline and tells the list about it. */
async function persist(p: Pipeline): Promise<PipelineEntry> {
  const saved = await PipelinesService.Save(p);
  const s = usePipelines.getState();
  s.setEntries(withEntry(s.entries, saved));
  return saved;
}

function clearTimers() {
  clearTimeout(saveTimer);
  clearTimeout(describeTimer);
}

export const useDraft = create<DraftState>()((set, get) => {
  const runDescribe = () => {
    const p = get().draft;
    if (!p) return;
    const seq = ++describeSeq;
    PipelinesService.Describe(p)
      .then((c) => {
        if (seq === describeSeq && get().draft?.id === p.id) set({ check: normalizeCheck(p, c) });
      })
      .catch(() => undefined); // keep the last answer; saving still works
  };

  const save = async (): Promise<void> => {
    clearTimeout(saveTimer);
    const s0 = get();
    if (!s0.dirty || deleted || !s0.draft) return;
    if (saving) {
      resave = true;
      return;
    }
    saving = true;
    set({ dirty: false, saveState: { kind: "saving" } });
    try {
      await persist(s0.draft);
      set((s) => ({ saveState: s.dirty ? { kind: "saving" } : { kind: "saved" } }));
    } catch (e) {
      set({ dirty: true, saveState: { kind: "error", message: toAppError(e).message } });
    } finally {
      saving = false;
      if (resave) {
        resave = false;
        void save();
      }
    }
  };

  const schedule = (describe: boolean) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), SAVE_DELAY_MS);
    if (describe) {
      clearTimeout(describeTimer);
      describeTimer = setTimeout(runDescribe, DESCRIBE_DELAY_MS);
    }
  };

  /** Makes `hist.present` the draft. */
  const apply = (hist: History<Pipeline>, describe: boolean) => {
    const p = hist.present;
    set((s) => ({
      hist,
      draft: p,
      canUndo: hist.past.length > 0,
      canRedo: hist.future.length > 0,
      dirty: true,
      // The Input node (run parameters) stays selectable; a step that's gone is deselected.
      stepId: s.stepId && (s.stepId === INPUT_NODE || stepsOf(p).some((x) => x.id === s.stepId)) ? s.stepId : null,
    }));
    schedule(describe);
  };

  const edit = (fn: (p: Pipeline) => Pipeline, key = "") => {
    const { draft, hist } = get();
    if (!draft || !hist) return;
    const next = fn(draft);
    const h = pushHistory(hist, next, key);
    if (h === hist) return;
    apply(h, true);
  };

  const chooseFolder = async () => {
    try {
      const dir = await FilesService.PickFolder("Watch folder");
      if (dir) edit((p) => ({ ...p, watch: { ...p.watch, folder: dir } }));
    } catch (e) {
      toast({ title: "Couldn't choose a folder", description: toAppError(e).message, tone: "danger" });
    }
  };

  return {
    pipelineId: null,
    draft: null,
    check: EMPTY_CHECK,
    catalog: [],
    stepId: null,
    watchMessage: "",
    clipStatus: { active: false, message: "" },
    scheduleStatus: { active: false, message: "", next: 0 },
    runText: "",
    runCount: 0,
    canUndo: false,
    canRedo: false,
    saveState: { kind: "idle" },
    dirty: false,
    hist: null,

    open: (entry) => {
      clearTimers();
      describeSeq++;
      saving = false;
      resave = false;
      deleted = false;
      touchedKeep.clear();
      const restored = stash && stash.id === entry.pipeline.id ? stash : null;
      stash = null;
      const draft = restored ?? entry.pipeline;
      set({
        pipelineId: entry.pipeline.id,
        draft,
        hist: newHistory(draft),
        check: entry.check,
        stepId: null,
        canUndo: false,
        canRedo: false,
        dirty: restored !== null,
        saveState: { kind: "idle" },
      });
      if (restored) schedule(true);
      void adoptParkedHistory("pipelines", entry.pipeline.id);
    },

    close: () => {
      clearTimers();
      const { draft, dirty } = get();
      if (draft && dirty && !deleted && !saving) {
        void persist(draft).catch((e: unknown) => toast({ title: "Couldn't save the pipeline", description: toAppError(e).message, tone: "danger" }));
      }
      describeSeq++;
      set({ pipelineId: null, draft: null, hist: null, dirty: false, stepId: null, canUndo: false, canRedo: false, saveState: { kind: "idle" } });
    },

    markDeleted: () => {
      deleted = true;
      clearTimers();
      set({ dirty: false });
    },

    edit,

    editLayout: (layout, undoable = false) => {
      const { draft, hist } = get();
      if (!draft || !hist || draft.layout === layout) return;
      const next = { ...draft, layout };
      apply(undoable ? pushHistory(hist, next) : { ...hist, present: next }, false);
    },

    undo: () => {
      const { hist } = get();
      if (hist && hist.past.length > 0) apply(undoHistory(hist), true);
    },

    redo: () => {
      const { hist } = get();
      if (hist && hist.future.length > 0) apply(redoHistory(hist), true);
    },

    select: (stepId) => set({ stepId }),

    patchStep: (id, patch) =>
      edit((p) => ({ ...p, steps: stepsOf(p).map((s) => (s.id === id ? { ...s, ...patch } : s)) }), `patch:${id}:${Object.keys(patch).sort().join(",")}`),

    keepTouched: (id) => void touchedKeep.add(id),

    removeStep: (id) => {
      const { draft } = get();
      if (!draft) return;
      const cur = stepsOf(draft);
      if (cur.length <= 1) {
        toast({ title: "A pipeline needs at least one step", tone: "warn" });
        return;
      }
      edit((p) => {
        const next = deleteSteps(stepsOf(p), new Set([id]));
        const layout = parseLayout(p.layout);
        return withSteps(p, next, p.layout.trim() ? serializeLayout(layout, [INPUT_NODE, ...next.map((s) => s.id)]) : p.layout);
      });
    },

    duplicateStep: (id) => {
      const { draft } = get();
      if (!draft) return;
      const cur = stepsOf(draft);
      if (cur.length + 1 > MAX_STEPS) {
        toast({ title: "That's the most steps a pipeline can have", tone: "warn" });
        return;
      }
      const res = duplicateSteps(cur, new Set([id]), newStepId);
      const layout = parseLayout(draft.layout);
      const nodes = { ...layout.nodes };
      for (const [old, nid] of res.idMap) {
        const n = layout.nodes[old];
        if (n) nodes[nid] = { x: n.x + 40, y: n.y + 40 };
      }
      const json = draft.layout.trim() ? serializeLayout({ ...layout, nodes }, [INPUT_NODE, ...res.steps.map((s) => s.id)]) : draft.layout;
      edit((p) => withSteps(p, res.steps, json));
      const nid = res.idMap.get(id);
      if (nid) set({ stepId: nid });
    },

    updateParam: (name, patch) =>
      edit(
        (p) => ({
          ...p,
          params: (p.params ?? []).map((q) =>
            q.name === name ? { ...q, label: patch.label !== undefined && patch.label.trim() !== "" ? patch.label.slice(0, 60) : q.label, default: patch.default ?? q.default } : q,
          ),
        }),
        `param:${name}`,
      ),

    removeParam: (name) => edit((p) => ({ ...p, params: (p.params ?? []).filter((q) => q.name !== name), steps: unbindVar(stepsOf(p), name) })),

    setName: (name) => edit((p) => ({ ...p, name }), "name"),
    setDescription: (description) => edit((p) => ({ ...p, description }), "description"),

    setWatchEnabled: (enabled) => {
      edit((p) => ({ ...p, watch: { ...p.watch, enabled } }));
      if (enabled && !get().draft?.watch.folder) void chooseFolder();
    },

    chooseFolder,

    setClip: (patch) =>
      edit((p) => {
        const next = { ...p.clip, ...patch, kinds: patch.kinds ?? p.clip.kinds ?? [] };
        // Switching it on with nothing chosen starts with links, the common case.
        if (patch.enabled && next.kinds.length === 0) next.kinds = ["link"];
        return { ...p, clip: next };
      }),

    setSchedule: (patch) =>
      edit((p) => {
        const next = { ...p.schedule, ...patch, days: patch.days ?? p.schedule?.days ?? [], times: patch.times ?? p.schedule?.times ?? [] };
        // Switching it on with nothing chosen starts with weekdays at 09:00, the common case.
        if (patch.enabled) {
          if (next.days.length === 0) next.days = [...WEEKDAYS];
          if (next.times.length === 0) next.times = addTime([], DEFAULT_TIME);
        }
        return { ...p, schedule: next };
      }),

    openClipboardSettings: () => useUI.getState().navigate("settings"),

    openRuns: () => {
      const id = get().pipelineId;
      if (!id) return;
      const s = usePipelines.getState();
      s.setRunFilter(id);
      s.setTab("runs");
    },

    setLive: (v) => set(v),

    flush: async () => {
      clearTimeout(saveTimer);
      await save();
    },
  };
});

// Undo history survives popping the whole tool out and bringing it back (lib/parkedHistory.ts).
registerHistory("pipelines", ["pipelines"], {
  docId: () => useDraft.getState().pipelineId,
  read: () => {
    const h = useDraft.getState().hist;
    return h ? { past: h.past, future: h.future } : null;
  },
  write: ({ past, future }) => {
    const h = useDraft.getState().hist;
    if (h) useDraft.setState({ hist: { ...h, past: past as Pipeline[], future: future as Pipeline[] }, canUndo: past.length > 0, canRedo: future.length > 0 });
  },
  subscribe: (cb) =>
    useDraft.subscribe((s, prev) => {
      if (s.hist !== prev.hist) cb();
    }),
});
