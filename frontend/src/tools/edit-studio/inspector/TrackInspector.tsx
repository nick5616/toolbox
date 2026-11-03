/** The Inspector for a track: name, mute, lock (§14.8). */
import { Section, Select, Switch, TextField } from "@/components";
import type { EditTrack } from "@/lib/api";
import { patchTrack } from "./inspectorState";
import styles from "./inspector.module.css";

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
      <Section label="Track">
        <div className={styles.stack}>
          <label className={styles.stack}>
            <span className={styles.label}>Name</span>
            <TextField size="sm" aria-label="Track name" maxLength={40} value={track.name} onChange={(e) => patchTrack(track.id, { name: e.target.value }, `${track.id}:name`)} />
          </label>
          <Switch label="Muted" checked={track.muted} onChange={(muted) => patchTrack(track.id, { muted })} />
          <p className={styles.hint}>{adjust ? "A muted track's effects are not applied." : "A muted track isn't drawn and its audio isn't mixed."}</p>
          <Switch label="Locked" checked={track.locked} onChange={(locked) => patchTrack(track.id, { locked })} />
          <p className={styles.hint}>A locked track can't be edited, and auto-fill skips it.</p>
        </div>
      </Section>
      {!adjust && (
        <Section label="Track matte">
          <div className={styles.stack}>
            <Select size="sm" aria-label="Track matte" value={track.matte ?? ""} onChange={(matte) => patchTrack(track.id, { matte })} options={MATTE_OPTIONS} />
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
