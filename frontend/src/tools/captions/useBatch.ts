import { useCallback, useEffect, useRef, useState } from "react";
import { CaptionAction, CaptionService, JobStatus, JobsService, type CaptionField, type CaptionItemEvent, type CaptionOptions, type CaptionWriteOptions, type Job } from "@/lib/api";
import { on } from "@/lib/events";
import { useJobs, type JobView } from "@/state/jobs";
import { normBatch, normItem, pendingItem, statusOf, type BatchView, type ItemView } from "./options";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Edits are written to captions.json this long after the last keystroke. */
export const SAVE_DEBOUNCE_MS = 1000;

type Watch = { kind: "run" } | { kind: "regen"; index: number } | { kind: "action" };

const isTerminal = (s: JobStatus): boolean => s === JobStatus.JobDone || s === JobStatus.JobFailed || s === JobStatus.JobCancelled;

function resultDir(job: JobView | undefined): string {
  if (!job?.resultJson) return "";
  try {
    const r = JSON.parse(job.resultJson) as { batchDir?: unknown };
    return typeof r.batchDir === "string" ? r.batchDir : "";
  } catch {
    return "";
  }
}

/** Server items win unless the user edited the local copy of that item. */
function mergeItems(local: ItemView[], server: ItemView[]): ItemView[] {
  return server.map((s, i) => {
    const l = local[i];
    return l && l.input === s.input && statusOf(l) !== "pending" && Object.values(l.edited).some(Boolean) ? l : s;
  });
}

export interface BatchApi {
  batch: BatchView | null;
  saveState: SaveState;
  /** The batch job is running (cards still arriving). */
  running: boolean;
  jobId: string;
  /** Items with a Regenerate in flight, by index. */
  busy: Record<number, true>;
  /** The latest write/rename job. */
  actionJobId: string;
  start: (inputs: string[], options: CaptionOptions) => Promise<Job | undefined>;
  open: (dir: string) => Promise<void>;
  close: () => void;
  edit: (index: number, field: CaptionField, value: string | string[]) => void;
  setNote: (index: number, note: string) => void;
  regenerate: (index: number, all: boolean) => Promise<void>;
  runAction: (action: "write" | "rename", write?: CaptionWriteOptions) => Promise<Job | undefined>;
  cancel: () => void;
  /** Writes pending edits now. */
  flush: () => Promise<void>;
  notes: Record<string, string>;
}

/** The open batch: streaming cards, edits with a debounced save, regenerate and the write/rename jobs. */
export function useBatch(): BatchApi {
  const [batch, setBatchState] = useState<BatchView | null>(null);
  const batchRef = useRef<BatchView | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [jobId, setJobId] = useState("");
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<Record<number, true>>({});
  const [actionJobId, setActionJobId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const watched = useRef(new Map<string, Watch>());
  const early = useRef<CaptionItemEvent[]>([]);
  const starting = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const jobIdRef = useRef("");
  jobIdRef.current = jobId;
  const runningRef = useRef(false);

  const setBatch = useCallback((b: BatchView | null) => {
    batchRef.current = b;
    setBatchState(b);
  }, []);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    // The job writes the file while it runs; held edits are saved when it ends.
    if (!dirty.current || !batchRef.current || batchRef.current.dir === "") return;
    if (runningRef.current) return;
    if (saving.current) {
      await saving.current;
      if (!dirty.current) return;
    }
    const b = batchRef.current;
    dirty.current = false;
    setSaveState("saving");
    const p = (async () => {
      try {
        await CaptionService.SaveBatch(b);
        if (alive.current) setSaveState(dirty.current ? "dirty" : "saved");
      } catch {
        dirty.current = true;
        if (alive.current) setSaveState("error");
      }
    })();
    saving.current = p;
    await p;
    saving.current = null;
  }, []);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSaveState("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  }, [save]);

  const applyEvent = useCallback((ev: CaptionItemEvent) => {
    const cur = batchRef.current;
    if (!cur || ev.index < 0 || ev.index >= cur.items.length) return;
    const items = cur.items.slice();
    items[ev.index] = normItem(ev.item);
    setBatch({ ...cur, dir: cur.dir || ev.dir, items });
  }, [setBatch]);

  // captions:item → the card for that index.
  useEffect(() => {
    return on("captions:item", (ev) => {
      const cur = batchRef.current;
      if (watched.current.has(ev.jobId) || (cur && cur.dir !== "" && cur.dir === ev.dir)) applyEvent(ev);
      else if (starting.current) early.current.push(ev);
    });
  }, [applyEvent]);

  const finish = useCallback(
    async (id: string, w: Watch, job: JobView) => {
      watched.current.delete(id);
      if (w.kind === "action") {
        return;
      }
      const cur = batchRef.current;
      const dir = (cur?.dir ?? "") || resultDir(job);
      if (w.kind === "run") {
        runningRef.current = false;
        setRunning(false);
        // Whatever never arrived (cancelled) is not a card.
        if (cur) setBatch({ ...cur, dir: cur.dir || dir, items: cur.items.filter((i) => statusOf(i) !== "pending") });
      } else {
        setBusy((b) => {
          const n = { ...b };
          delete n[w.index];
          return n;
        });
      }
      if (dir !== "") {
        try {
          const server = normBatch(await CaptionService.Batch(dir));
          const now = batchRef.current;
          if (now && alive.current) {
            const items = w.kind === "run" ? mergeItems(now.items, server.items) : now.items.map((l, i) => (i === w.index && server.items[i]?.input === l.input ? (server.items[i] as ItemView) : l));
            setBatch({ ...server, dir, items });
          }
        } catch {
          /* the cards already show what arrived */
        }
      }
      if (dirty.current) void save();
    },
    [save, setBatch],
  );

  // Follow the jobs this tool started.
  const check = useCallback(() => {
    for (const [id, w] of Array.from(watched.current)) {
      const job = useJobs.getState().byId[id];
      if (job && isTerminal(job.status)) void finish(id, w, job);
    }
  }, [finish]);
  useEffect(() => {
    const unsub = useJobs.subscribe(check);
    return unsub;
  }, [check]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const watch = useCallback(
    (id: string, w: Watch) => {
      watched.current.set(id, w);
      check();
    },
    [check],
  );

  const start = useCallback(
    async (inputs: string[], options: CaptionOptions) => {
      dirty.current = false;
      setSaveState("idle");
      early.current = [];
      starting.current = true;
      watched.current.clear();
      setBusy({});
      setActionJobId("");
      setBatch({ version: 1, name: "", dir: "", created: 0, model: "", options, items: inputs.map(pendingItem) });
      runningRef.current = true;
      setRunning(true);
      try {
        const n: Record<string, string> = {};
        for (const p of inputs) if (notesRef.current[p]) n[p] = notesRef.current[p] as string;
        const jobs = (await CaptionService.Enqueue(inputs, { ...options, action: CaptionAction.ActionCaption, notes: n })) ?? [];
        const job = jobs[0];
        if (!job) throw new Error("No job was queued");
        useJobs.getState().upsert(job);
        setJobId(job.id);
        jobIdRef.current = job.id;
        watch(job.id, { kind: "run" });
        for (const ev of early.current) if (ev.jobId === job.id) applyEvent(ev);
        return job;
      } catch (e) {
        setBatch(null);
        runningRef.current = false;
        setRunning(false);
        throw e;
      } finally {
        starting.current = false;
        early.current = [];
      }
    },
    [applyEvent, setBatch, watch],
  );

  const open = useCallback(
    async (dir: string) => {
      const b = normBatch(await CaptionService.Batch(dir));
      watched.current.clear();
      dirty.current = false;
      setBusy({});
      runningRef.current = false;
      setRunning(false);
      setJobId("");
      jobIdRef.current = "";
      setActionJobId("");
      setBatch({ ...b, dir: b.dir || dir });
      setSaveState("saved");
    },
    [setBatch],
  );

  const close = useCallback(() => {
    void save().then(() => {
      if (!alive.current) return;
      watched.current.clear();
      setBatch(null);
      runningRef.current = false;
      setRunning(false);
      setJobId("");
      setBusy({});
      setActionJobId("");
      setSaveState("idle");
    });
  }, [save, setBatch]);

  const edit = useCallback(
    (index: number, field: CaptionField, value: string | string[]) => {
      const cur = batchRef.current;
      const it = cur?.items[index];
      if (!cur || !it) return;
      const items = cur.items.slice();
      items[index] = { ...it, fields: { ...it.fields, [field]: value }, edited: { ...it.edited, [field]: true } };
      setBatch({ ...cur, items });
      schedule();
    },
    [schedule, setBatch],
  );

  const setNote = useCallback(
    (index: number, note: string) => {
      const cur = batchRef.current;
      const it = cur?.items[index];
      if (!cur || !it) return;
      const items = cur.items.slice();
      items[index] = { ...it, note };
      setBatch({ ...cur, items });
      setNotes((n) => ({ ...n, [it.input]: note }));
      schedule();
    },
    [schedule, setBatch],
  );

  const regenerate = useCallback(
    async (index: number, all: boolean) => {
      const cur = batchRef.current;
      const it = cur?.items[index];
      if (!cur || !it || cur.dir === "") return;
      await save();
      setBusy((b) => ({ ...b, [index]: true }));
      const notesFor: Record<string, string> = it.note ? { [it.input]: it.note } : {};
      try {
        const jobs = (await CaptionService.Enqueue([], { ...cur.options, action: CaptionAction.ActionRegenerate, batch: cur.dir, index, keepEdited: !all, notes: notesFor })) ?? [];
        const job = jobs[0];
        if (!job) throw new Error("No job was queued");
        useJobs.getState().upsert(job);
        watch(job.id, { kind: "regen", index });
      } catch (e) {
        setBusy((b) => {
          const n = { ...b };
          delete n[index];
          return n;
        });
        throw e;
      }
    },
    [save, watch],
  );

  const runAction = useCallback(
    async (action: "write" | "rename", write?: CaptionWriteOptions) => {
      const cur = batchRef.current;
      if (!cur || cur.dir === "") return undefined;
      await save();
      const jobs = (await CaptionService.Enqueue([], { ...cur.options, action: action === "write" ? CaptionAction.ActionWrite : CaptionAction.ActionRename, batch: cur.dir, ...(write ? { write } : {}) })) ?? [];
      const job = jobs[0];
      if (!job) return undefined;
      useJobs.getState().upsert(job);
      setActionJobId(job.id);
      watch(job.id, { kind: "action" });
      return job;
    },
    [save, watch],
  );

  const cancel = useCallback(() => {
    if (jobIdRef.current) void JobsService.Cancel(jobIdRef.current).catch(() => undefined);
  }, []);

  return { batch, saveState, running, jobId, busy, actionJobId, start, open, close, edit, setNote, regenerate, runAction, cancel, flush: save, notes };
}
