/** The Inspector for a track: name, mute, lock (§14.8). */
import { Section, Select, Switch, TextField } from "@/components";
import type { EditTrack } from "@/lib/api";
import { patchTrack } from "./inspectorState";
import styles from "./inspector.module.css";

const MATTE_TIPS: Record<string, string> = {
  "": "No matte: the track draws normally",
  alpha: "This track shows only where the track above has something drawn (text, a shape, a photo)",
  "alpha-inverted": "This track shows only where the track above is empty, like a hole cut by its shape",
  luma: "This track shows through the bright parts of the track above; dark parts hide it",
  "luma-inverted": "This track shows through the dark parts of the track above; bright parts hide it",
};

const MATTE_OPTIONS = [
  { value: "", label: "None" },
  { value: "alpha", label: "Through the track above (alpha)" },
  { value: "alpha-inverted", label: "Outside the track above (alpha inverted)" },
  { value: "luma", label: "Through the bright parts above (luma)" },
  { value: "luma-inverted", label: "Through the dark parts above (luma inverted)" },
];

export function TrackInspector({ track }: { track: EditTrack }) {
  const adjust = track.kind === "adjust";
  return (
    <div className={styles.root} aria-label="Track inspector">
      <div className={styles.head}>
        <h2 className={styles.title}>{adjust ? "Adjustment track" : "Video track"}</h2>
      </div>
      <Section label="Track" tip="Name, mute and lock for this track">
        <div className={styles.stack}>
          <label className={styles.stack}>
            <span className={styles.label}>Name</span>
            <TextField size="sm" aria-label="Track name" data-tip="Shown on the timeline; up to 40 characters" maxLength={40} value={track.name} onChange={(e) => patchTrack(track.id, { name: e.target.value }, `${track.id}:name`)} />
          </label>
          <Switch tip={adjust ? "Skip this track's effects without deleting its clips" : "Hide this track's picture and silence its audio in the preview and export"} label="Muted" checked={track.muted} onChange={(muted) => patchTrack(track.id, { muted })} />
          <p className={styles.hint}>{adjust ? "A muted track's effects are not applied." : "A muted track isn't drawn and its audio isn't mixed."}</p>
          <Switch tip="Protect this track from edits, drags and auto-fill" label="Locked" checked={track.locked} onChange={(locked) => patchTrack(track.id, { locked })} />
          <p className={styles.hint}>A locked track can't be edited, and auto-fill skips it.</p>
        </div>
      </Section>
      {!adjust && (
        <Section label="Track matte" tip="Use the track above as a window: this track shows only through its shape or brightness">
          <div className={styles.stack}>
            <Select size="sm" aria-label="Track matte" data-tip={MATTE_TIPS[track.matte ?? ""]} value={track.matte ?? ""} onChange={(matte) => patchTrack(track.id, { matte })} options={MATTE_OPTIONS} />
            <p className={styles.hint}>
              {track.matte
                ? "This track shows only through the track above it, which isn't drawn by itself. Put text, a shape or a video there."
                : "Show this track only through the track above it: text, a photo or a video can be a window into this one."}
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}
