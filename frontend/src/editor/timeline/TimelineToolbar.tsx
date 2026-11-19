/**
 * The timeline toolbar's Phase 21 controls (SPEC §B2): the tool segment (V C B
 * N Y), the snapping magnet and the zoom slider. One line; it never wraps.
 */
import { IconButton } from "@/components";
import { ppsToSlider, sliderToPps } from "@/editor/geometry";
import { useEditStudio } from "@/editor/store";
import { useTimelineStore, TOOLS } from "./timelineStore";
import { zoomFit, zoomIn, zoomOut, zoomToPps } from "./zoomActions";
import styles from "./Timeline.module.css";

export function TimelineToolbar() {
  const tool = useTimelineStore((s) => s.tool);
  const setTool = useTimelineStore((s) => s.setTool);
  const snap = useEditStudio((s) => s.snap);
  const pps = useEditStudio((s) => s.pps);
  return (
    <>
      <div className={styles.tools} role="group" aria-label="Timeline tools">
        {TOOLS.map((t) => (
          <IconButton key={t.id} size="sm" icon={t.icon} label={`${t.label} tool`} kbd={t.key} data-tip={`${t.label} (${t.key}): ${t.tip}`} pressed={tool === t.id} onClick={() => setTool(t.id)} />
        ))}
        <IconButton
          size="sm"
          icon="magnet"
          label={snap ? "Snapping on" : "Snapping off"}
          kbd="Shift+N"
          data-tip={snap ? "Snapping is on: clips and the playhead stick to edges, markers and the playhead (hold Alt to skip it). Click to turn off" : "Snapping is off. Click to turn on"}
          pressed={snap}
          onClick={() => useEditStudio.getState().setSnap(!snap)}
        />
      </div>
      <span className={styles.toolSep} aria-hidden="true" />
      <div className={styles.zoom} role="group" aria-label="Zoom">
        <IconButton size="sm" icon="zoom-out" label="Zoom out" kbd="-" onClick={zoomOut} />
        <input
          type="range"
          className={styles.zoomSlider}
          min={0}
          max={1000}
          step={1}
          value={ppsToSlider(pps)}
          aria-label="Zoom"
          data-tip="Zoom the timeline (also = and − keys; Ctrl+wheel zooms at the pointer)"
          onChange={(e) => zoomToPps(sliderToPps(Number(e.target.value)))}
        />
        <IconButton size="sm" icon="zoom-in" label="Zoom in" kbd="=" onClick={zoomIn} />
        <IconButton size="sm" icon="maximize" label="Fit the whole edit" kbd="\" onClick={zoomFit} />
      </div>
    </>
  );
}
