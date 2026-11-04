/**
 * The "Cut to beat" button and popover in the tracks toolbar: pick what the
 * clips switch on (beat, downbeat, kick, snare…), how often, and Apply.
 */
import { useEffect, useRef, useState } from "react";
import { Button, SegmentedControl, Select, toast } from "@/components";
import { useEditStudio, useMarkers, useProject } from "../store";
import { cutToBeat, readySources, type CutOptions } from "./cutLogic";
import { HIT_LANES, HIT_LANE_TIPS } from "./hits";
import styles from "./beatsync.module.css";

const CUT_LANES = HIT_LANES.filter((l) => l.value !== "section" && l.value !== "word" && l.value !== "drop");
const EVERY = [1, 2, 4, 8].map((n) => ({ value: String(n), label: n === 1 ? "Every one" : `Every ${n}` }));

export function CutToBeat() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - 340), top: Math.max(8, r.top - 8) });
    setOpen((o) => !o);
  };
  return (
    <>
      <Button ref={btn} size="sm" icon="scissors" data-tip="Switch clips on the music: pick beats, downbeats, kicks or snares and how often" variant={open ? "primary" : "secondary"} onClick={toggle}>
        Cut to beat
      </Button>
      {open && <CutPopover left={pos.left} bottom={window.innerHeight - pos.top} onClose={() => setOpen(false)} />}
    </>
  );
}

function CutPopover({ left, bottom, onClose }: { left: number; bottom: number; onClose(): void }) {
  const project = useProject();
  const markers = useMarkers();
  const analysis = useEditStudio((s) => s.analysis);
  const sourceStates = useEditStudio((s) => s.sources);
  const selection = useEditStudio((s) => s.selection);
  const [lane, setLane] = useState<CutOptions["lane"]>("beat");
  const [every, setEvery] = useState(1);
  const [order, setOrder] = useState<CutOptions["order"]>("sequential");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  if (!project) return null;
  // Where: the selected clips' track and span, a selected range, a selected track, else the first video track.
  const selIds = selection?.kind === "clips" ? new Set(selection.ids) : null;
  const selTrack = selIds ? project.tracks.find((t) => t.clips.some((c) => selIds.has(c.id))) : selection?.kind === "track" ? project.tracks.find((t) => t.id === selection.id) : undefined;
  const track = (selTrack?.kind === "video" && !selTrack.locked ? selTrack : undefined) ?? project.tracks.find((t) => t.kind === "video" && !t.locked);
  let range: CutOptions["range"] = null;
  if (selection?.kind === "range") range = { fromMs: selection.fromMs, toMs: selection.toMs };
  else if (selIds && selTrack) {
    const cs = selTrack.clips.filter((c) => selIds.has(c.id));
    if (cs.length) range = { fromMs: Math.min(...cs.map((c) => c.startMs)), toMs: Math.max(...cs.map((c) => c.endMs)) };
  }
  const sources = readySources(project, sourceStates);
  const where = `${track?.name ?? "a new track"} · ${range ? "the selection" : "the whole edit"}`;

  const apply = () => {
    if (!analysis) {
      toast({ title: "Analyze the song first", tone: "warn" });
      return;
    }
    if (sources.length === 0) {
      toast({ title: "Add some clips or photos to Sources first", tone: "warn" });
      return;
    }
    const st = useEditStudio.getState();
    const res = cutToBeat(project, markers, analysis, sources, { lane, every, order, moments: "shotAligned", range, trackId: track?.id ?? "new", sources: "all", seed: (project.seed + Date.now()) % 100000 });
    if (res.problem) {
      toast({ title: "Couldn't cut there", description: res.problem, tone: "warn" });
      return;
    }
    st.edit(res.project);
    toast({ title: `${res.cuts} clips, switching on ${CUT_LANES.find((l) => l.value === lane)?.label.toLowerCase() ?? lane}${every > 1 ? ` (every ${every})` : ""}`, tone: "success" });
    onClose();
  };

  return (
    <div ref={box} className={styles.popover} style={{ left, bottom }} role="dialog" aria-label="Cut to beat">
      <div className={styles.cut}>
        <h3 className={styles.cutTitle}>Switch clips on…</h3>
        <div className={styles.chips} role="group" aria-label="Switch on" data-tip="The musical moment where clips switch">
          {CUT_LANES.map((l) => (
            <button key={l.value} type="button" data-tip={HIT_LANE_TIPS[l.value]} className={styles.chip} aria-pressed={lane === l.value} onClick={() => setLane(l.value)}>
              {l.label}
            </button>
          ))}
        </div>
        <div className={styles.row}>
          <span className={styles.label}>How often</span>
          <Select size="sm" data-tip="Cut on every marker, or only every 2nd, 4th or 8th for a slower pace" aria-label="How often" value={String(every)} onChange={(v) => setEvery(Number(v))} options={EVERY} />
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Order</span>
          <SegmentedControl size="sm" aria-label="Order" value={order} onChange={(v) => setOrder(v as CutOptions["order"])} options={[{ value: "sequential", label: "In order", tip: "Use the sources one after another in the order they were added" }, { value: "shuffleNoRepeat", label: "Shuffled", tip: "Use the sources in a random order without repeating one until all are used" }]} />
        </div>
        <p className={styles.note}>
          On {where}. Uses all {sources.length} sources; pinned clips stay. Undo with Ctrl+Z.
        </p>
        <div className={styles.foot}>
          <Button size="sm" variant="ghost" data-tip="Close without changing anything" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" icon="scissors" data-tip="Place clips on the chosen markers; one Undo reverts it" onClick={apply}>
            Cut
          </Button>
        </div>
      </div>
    </div>
  );
}
