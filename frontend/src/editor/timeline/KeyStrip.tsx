/**
 * The keyframe strip under a selected clip (Phase 21 SPEC §B2): one diamond
 * per keyed time, merged across the clip's params. Click goes to that time;
 * drag moves every key at it; Alt+click deletes them; double-click opens that
 * param in the inspector.
 */
import { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import type { EditClip } from "@/lib/api";
import { withClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import { enterVideoFocus } from "../focus";
import { seekTo } from "../transport/player";
import { collapseDrag, commit } from "./actions";
import { clipKeyTimes, deleteKeysAt, keyParamsAt, moveKeysAt } from "./keyframes";
import { useTimelineStore } from "./timelineStore";
import styles from "./Timeline.module.css";

let seq = 0;
const DRAG_PX = 3;

export function KeyStrip({ clip, pps, locked }: { clip: EditClip; pps: number; locked: boolean }) {
  const times = useMemo(() => clipKeyTimes(clip), [clip]);
  if (!times.length) return null;

  const onDown = (e: ReactPointerEvent<HTMLElement>, t: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    const st = useEditStudio.getState();
    const baseDoc = st.history?.present;
    const baseClip = baseDoc?.tracks.flatMap((c) => c.clips).find((c) => c.id === clip.id);
    if (!baseDoc || !baseClip) return;
    st.select({ kind: "clips", ids: [clip.id] });
    if (e.altKey) {
      if (locked) return;
      const patch = deleteKeysAt(baseClip, t);
      if (patch) commit(withClip(baseDoc, clip.id, patch));
      return;
    }
    const startX = e.clientX;
    const key = `keys-${++seq}`;
    const startPast = st.history?.past.length ?? 0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (locked) return;
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_PX) return;
      moved = true;
      const patch = moveKeysAt(baseClip, t, t + ((ev.clientX - startX) * 1000) / useEditStudio.getState().pps);
      if (patch) useEditStudio.getState().edit(withClip(baseDoc, clip.id, patch), key);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      collapseDrag(startPast, baseDoc);
      if (!moved && ev.type === "pointerup") seekTo(baseClip.startMs + t);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onDouble = (e: { stopPropagation(): void }, t: number) => {
    e.stopPropagation();
    const param = keyParamsAt(clip, t)[0];
    if (!param) return;
    useTimelineStore.getState().focusParam(clip.id, param);
    enterVideoFocus();
  };

  return (
    <div className={styles.keyStrip} data-key-strip={clip.id}>
      {times.map((t) => (
        <span
          key={t}
          className={styles.keyDiamond}
          style={{ left: (t * pps) / 1000 }}
          role="button"
          tabIndex={-1}
          aria-label={`Keyframe at ${(t / 1000).toFixed(2)} seconds`}
          data-key-time={t}
          data-tip="Keyframe: click to go there, drag to move every key at this time, Alt+click to delete them, double-click to open the param in the inspector"
          onPointerDown={(e) => onDown(e, t)}
          onDoubleClick={(e) => onDouble(e, t)}
        />
      ))}
    </div>
  );
}
