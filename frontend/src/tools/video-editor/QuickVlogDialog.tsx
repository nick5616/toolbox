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
  onPickSong: () => void;
  onBuild: () => void;
  onCancel: () => void;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function QuickVlogDialog({ open, form, busy, onChange, onPickClips, onPickSong, onBuild, onCancel }: QuickVlogDialogProps) {
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
                <Button size="sm" icon="plus" onClick={onPickClips}>
                  Add clips and photos
                </Button>
                <span className={styles.muted}>{form.paths.length === 0 ? "None yet" : `${form.paths.length} added`}</span>
              </div>
              {form.paths.length > 0 && (
                <ul className={styles.vlogList} aria-label="Files">
                  {form.paths.slice(0, 50).map((p) => (
                    <li key={p}>
                      <span title={p}>{base(p)}</span>
                      <IconButton size="sm" icon="x" label={`Remove ${base(p)}`} onClick={() => onChange({ ...form, paths: form.paths.filter((x) => x !== p) })} />
                    </li>
                  ))}
                  {form.paths.length > 50 && <li className={styles.muted}>and {form.paths.length - 50} more</li>}
                </ul>
              )}
            </div>
          </Field>
          <Field label="Song (optional)">
            <div className={styles.vlogFileRow}>
              <Button size="sm" icon="music" onClick={onPickSong}>
                {form.musicPath ? "Change song" : "Pick a song"}
              </Button>
              {form.musicPath && (
                <>
                  <span className={styles.muted} title={form.musicPath}>
                    {base(form.musicPath)}
                  </span>
                  <IconButton size="sm" icon="x" label="Remove the song" onClick={() => onChange({ ...form, musicPath: "", beatCut: false, length: form.length === "music" ? "music" : "seconds" })} />
                </>
              )}
            </div>
          </Field>
          <Field label="Shape">
            {(c) => <Select {...c} value={form.aspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} onChange={(aspect) => onChange({ ...form, aspect })} />}
          </Field>
          <Field label="Order">
            <SegmentedControl
              aria-label="Order"
              size="sm"
              value={form.order}
              options={[
                { value: "as-given", label: "As given" },
                { value: "date-taken", label: "Date taken" },
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
                { value: "music", label: form.musicPath ? "Fit the song" : "About 3 s a clip" },
                { value: "seconds", label: "Set length" },
              ]}
              onChange={(length) => onChange({ ...form, length })}
            />
            {form.length === "seconds" && <Stepper aria-label="Length in seconds" unit="s" min={3} max={1800} value={form.seconds} onChange={(seconds) => onChange({ ...form, seconds })} />}
          </Field>
          <Switch label="Cut on the beat" checked={form.beatCut && form.musicPath !== ""} disabled={!form.musicPath} onChange={(beatCut) => onChange({ ...form, beatCut })} />
          <Field label="Transition">
            <SegmentedControl
              aria-label="Transition"
              size="sm"
              value={form.transition}
              options={[
                { value: "cut", label: "Cut" },
                { value: "fade", label: "Fade" },
                { value: "dip", label: "Dip" },
                { value: "slide", label: "Slide" },
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
