/** Ghost ticks on the selected video clips: footage moments and song accents (§24.3). Mounted inside the tracks' rows. */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditClip } from "@/lib/api";
import { parseSpeed } from "@/viz/edit/schema";
import { HEADER_PX, msToX } from "../geometry";
import { findClip } from "../doc";
import { useEditStudio, useMarkers } from "../store";
import { seekTo } from "../transport/player";
import { accentMoments, clipMoments, footageMoments, momentTip } from "./logic";
import styles from "./moments.module.css";
import { useFootageMoments } from "./store";

interface Box {
  top: number;
  height: number;
}

function ClipTicks({ clip, box }: { clip: EditClip; box: Box }) {
  const fps = useEditStudio((s) => s.history?.present.fps ?? 30);
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const markers = useMarkers();
  const footage = useFootageMoments(clip.path, fps);
  const ticks = useMemo(
    () => clipMoments(footageMoments(clip, fps, parseSpeed(clip.speed).value, footage.moments), accentMoments(clip, markers), 400),
    [clip, fps, footage.moments, markers],
  );
  return (
    <>
      {ticks.map((m) => {
        const x = msToX(m.timelineMs, pps, scrollMs);
        if (x < 0) return null;
        return (
          <button
            key={m.id}
            type="button"
            tabIndex={-1}
            className={styles.tick}
            data-kind={m.kind}
            data-testid="moment-tick"
            aria-label={momentTip(m.kind, m.clipMs, m.strength)}
            data-tip={momentTip(m.kind, m.clipMs, m.strength)}
            style={{ left: HEADER_PX + x, top: box.top + box.height - 18 }}
            onClick={() => seekTo(m.timelineMs)}
          />
        );
      })}
    </>
  );
}

export function MomentsOverlay() {
  const selection = useEditStudio((s) => s.selection);
  const project = useEditStudio((s) => s.history?.present ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});

  const clips = useMemo(() => {
    if (!project || selection?.kind !== "clips") return [];
    const out: EditClip[] = [];
    for (const id of selection.ids) {
      const c = findClip(project, id)?.clip;
      if (c && c.kind === "video" && c.path) out.push(c);
    }
    return out;
  }, [project, selection]);

  // Rows have fixed heights, so a clip's block is measured against the rows container whenever the layout can have changed.
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const pr = parent.getBoundingClientRect();
    const next: Record<string, Box> = {};
    for (const c of clips) {
      const el = parent.querySelector<HTMLElement>(`[data-clip-id="${c.id}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next[c.id] = { top: Math.round(r.top - pr.top + parent.scrollTop), height: Math.round(r.height) };
    }
    setBoxes((prev) => {
      const same = Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([k, v]) => prev[k]?.top === v.top && prev[k]?.height === v.height);
      return same ? prev : next;
    });
  }, [clips, project?.tracks]);

  return (
    <div ref={ref} className={styles.overlay} aria-hidden={clips.length === 0 || undefined}>
      {clips.map((c) => {
        const box = boxes[c.id];
        return box ? <ClipTicks key={c.id} clip={c} box={box} /> : null;
      })}
    </div>
  );
}
