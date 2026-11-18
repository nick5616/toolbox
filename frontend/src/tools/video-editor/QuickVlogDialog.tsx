import { Button, ConfirmDialog, Field, IconButton, SegmentedControl, Select, Stepper, Switch } from "@/components";
import { ASPECTS } from "./edit";
import { vlogProblem, type VlogForm } from "./vlog";
import styles from "./VideoEditorView.module.css";

export interface QuickVlogDialogProps {
  open: boolean;
  form: VlogForm;
  busy: boolean;
  onChange: (f: VlogForm) => void;
  onPickClips: () => void;
  onPickClipsLibrary: () => void;
  onPickSong: () => void;
  onPickSongLibrary: () => void;
  onBuild: () => void;
  onCancel: () => void;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function QuickVlogDialog({ open, form, busy, onChange, onPickClips, onPickClipsLibrary, onPickSong, onPickSongLibrary, onBuild, onCancel }: QuickVlogDialogProps) {
  const problem = vlogProblem(form);
  return (
    <ConfirmDialog
      open={open}
      title="Quick vlog"
      confirmLabel={busy ? "Building…" : "Build"}
      onConfirm={() => {
        if (!busy && !problem) onBuild();
      }}
      onCancel={onCancel}
      body={
        <div className={styles.vlogForm}>
          <Field label="Clips and photos" hint="Drop files on the window or pick them.">
            <div className={styles.vlogFiles}>
              <div className={styles.vlogFileRow}>
                <Button size="sm" icon="plus" data-tip="Choose the videos and photos to cut together" onClick={onPickClips}>
                  Add clips and photos
                </Button>
                <Button size="sm" variant="secondary" icon="history" data-tip="Choose videos and photos Toolbox already made (the Library)" onClick={onPickClipsLibrary}>
                  From Library…
                </Button>
                <span className={styles.muted} data-tip="How many files will be used">{form.paths.length === 0 ? "None yet" : `${form.paths.length} added`}</span>
              </div>
              {form.paths.length > 0 && (
                <ul className={styles.vlogList} aria-label="Files">
                  {form.paths.slice(0, 50).map((p) => (
                    <li key={p}>
                      <span data-tip={p}>{base(p)}</span>
                      <IconButton size="sm" icon="x" label={`Remove ${base(p)}`} data-tip="Leave this file out of the vlog" onClick={() => onChange({ ...form, paths: form.paths.filter((x) => x !== p) })} />
                    </li>
                  ))}
                  {form.paths.length > 50 && <li className={styles.muted}>and {form.paths.length - 50} more</li>}
                </ul>
              )}
            </div>
          </Field>
          <Field label="Song (optional)">
            <div className={styles.vlogFileRow}>
              <Button size="sm" icon="music" data-tip="Choose a song to play under the vlog; it can set the length and cut points" onClick={onPickSong}>
                {form.musicPath ? "Change song" : "Pick a song"}
              </Button>
              <Button size="sm" variant="secondary" icon="history" data-tip="Choose a song Toolbox already made (the Library)" onClick={onPickSongLibrary}>
                From Library…
              </Button>
              {form.musicPath && (
                <>
                  <span className={styles.muted} data-tip={form.musicPath}>
                    {base(form.musicPath)}
                  </span>
                  <IconButton size="sm" icon="x" label="Remove the song" data-tip="Build the vlog without music" onClick={() => onChange({ ...form, musicPath: "", beatCut: false, length: form.length === "music" ? "music" : "seconds" })} />
                </>
              )}
            </div>
          </Field>
          <Field label="Shape">
            {(c) => <Select {...c} data-tip="Frame shape of the finished video" value={form.aspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} onChange={(aspect) => onChange({ ...form, aspect })} />}
          </Field>
          <Field label="Order">
            <SegmentedControl
              aria-label="Order"
              size="sm"
              value={form.order}
              options={[
                { value: "as-given", label: "As given", tip: "Keep the clips in the order you added them" },
                { value: "date-taken", label: "Date taken", tip: "Sort the clips by when they were filmed or shot" },
              ]}
              onChange={(order) => onChange({ ...form, order })}
            />
          </Field>
          <Field label="Length">
            <SegmentedControl
              aria-label="Length"
              size="sm"
              value={form.length}
              options={[
                { value: "music", label: form.musicPath ? "Fit the song" : "About 3 s a clip", tip: form.musicPath ? "Make the video as long as the song" : "Give each clip about 3 seconds" },
                { value: "seconds", label: "Set length", tip: "Choose the total length of the video yourself" },
              ]}
              onChange={(length) => onChange({ ...form, length })}
            />
            {form.length === "seconds" && (
              <span data-tip="Total length of the video in seconds (3 to 1800)" style={{ display: "contents" }}>
                <Stepper aria-label="Length in seconds" unit="s" min={3} max={1800} value={form.seconds} onChange={(seconds) => onChange({ ...form, seconds })} />
              </span>
            )}
          </Field>
          <Switch label="Cut on the beat" tip={form.musicPath ? "Switch clips on the beats of the song" : "Pick a song first"} checked={form.beatCut && form.musicPath !== ""} disabled={!form.musicPath} onChange={(beatCut) => onChange({ ...form, beatCut })} />
          <Field label="Transition">
            <SegmentedControl
              aria-label="Transition"
              size="sm"
              value={form.transition}
              options={[
                { value: "cut", label: "Cut", tip: "Jump straight from clip to clip" },
                { value: "fade", label: "Fade", tip: "Cross-fade between clips" },
                { value: "dip", label: "Dip", tip: "Dip to black between clips" },
                { value: "slide", label: "Slide", tip: "The next clip slides in" },
              ]}
              onChange={(transition) => onChange({ ...form, transition })}
            />
          </Field>
          {problem && <div className={styles.muted}>{problem}</div>}
        </div>
      }
    />
  );
}
