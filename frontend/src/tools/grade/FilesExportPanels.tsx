/**
 * Rail ▸ Files and Export (Phase 21 SPEC §E1, CLAUDE.md "Every tool stands on
 * its own"). Files is the batch list. Export holds the format, the primary
 * export, Save look, .cube, and this tool's results: the file names (full path
 * on hover) with Reveal / Open / Save a copy / Send to, the Library folder they
 * went to, and the past results.
 */
import { FromLibraryButton } from "@/blocks/library-picker";
import { Button, Icon, IconButton, Meter, Select, TextField } from "@/components";
import { openLibrary } from "@/lib/openLibrary";
import { isActive } from "@/state/jobs";
import { RecentResults } from "../_kit/RecentResults";
import { useToolJobs } from "../_kit/session";
import { ALL_EXTS, MODULE_ID, baseName, kindOfPath, useGrade, type OutputFormat } from "./store";
import { addPaths, exportAll, exportCube, openInput, pickFiles, saveLook } from "./actions";
import { lutAvailable, lutLeftOut } from "./seams";
import { opLabel } from "./recipe";
import { useReplicaFlag } from "./replica";
import styles from "./Grade.module.css";

export function FilesPanel() {
  const inputs = useGrade((s) => s.inputs);
  const selected = useGrade((s) => s.selected);
  const replica = useReplicaFlag();
  return (
    <div className={styles.panel}>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" icon="plus" kbd="Mod+O" aria-disabled={replica || undefined} data-tip="Choose pictures or videos; each gets the same look" onClick={() => !replica && void pickFiles()}>
          Add files…
        </Button>
        <FromLibraryButton title="Choose pictures or videos from Library" exts={ALL_EXTS} multiple size="sm" have={inputs} onPick={(p) => void addPaths(p)} />
      </div>
      {inputs.length === 0 ? (
        <p className={styles.note}>Nothing here yet. Add files, or drop pictures and videos onto the window.</p>
      ) : (
        <ul className={styles.fileList} aria-label="Files to grade">
          {inputs.map((p) => (
            <li key={p} className={styles.fileRow} data-selected={p === selected || undefined}>
              <Icon name={kindOfPath(p) === "video" ? "film" : "image"} size={14} />
              <button
                type="button"
                className={styles.fileName}
                aria-current={p === selected}
                data-tip={p}
                onClick={() => {
                  useGrade.getState().select(p);
                  void openInput(p);
                }}
              >
                {baseName(p)}
              </button>
              <IconButton label={`Remove ${baseName(p)} from the batch`} icon="x" size="sm" onClick={() => useGrade.getState().removeInput(p)} />
            </li>
          ))}
        </ul>
      )}
      {inputs.length > 1 && <p className={styles.note}>The look you see is applied to every file when you export.</p>}
    </div>
  );
}

const FORMATS: ReadonlyArray<{ value: OutputFormat; label: string }> = [
  { value: "same", label: "Same as the original" },
  { value: "jpg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "webp", label: "WebP" },
];

function ActiveJobs() {
  const jobs = useToolJobs(MODULE_ID).filter((j) => isActive(j));
  if (jobs.length === 0) return null;
  return (
    <ul className={styles.jobList} aria-label="Exports in progress">
      {jobs.map((j) => (
        <li key={j.id} className={styles.jobRow} data-tip={j.inputs[0] ?? j.title}>
          <span className={styles.fileName}>{j.title || baseName(j.inputs[0] ?? "")}</span>
          <Meter value={Math.max(0, j.progress)} label={j.message || "Grading"} />
        </li>
      ))}
    </ul>
  );
}

export function ExportPanel() {
  const inputs = useGrade((s) => s.inputs);
  const recipe = useGrade((s) => s.recipe);
  const format = useGrade((s) => s.format);
  const exporting = useGrade((s) => s.exporting);
  const setFormat = useGrade((s) => s.setFormat);
  const replica = useReplicaFlag();
  const left = lutLeftOut(recipe);
  const cubeOk = lutAvailable();
  const noInput = inputs.length === 0;
  const exportWhy = replica ? "Export from the main window" : noInput ? "Add a picture or a video first" : "";
  const cubeWhy = !cubeOk ? "The LUT baker isn't available in this build" : recipe.ops.every((o) => !o.on) ? "This look has no colour ops to put in a LUT" : "";
  const hasPictures = inputs.some((p) => kindOfPath(p) === "image");
  const hasVideos = inputs.some((p) => kindOfPath(p) === "video");
  return (
    <div className={styles.panel}>
      <Button
        variant="primary"
        icon="download"
        loading={exporting}
        aria-disabled={!!exportWhy || undefined}
        data-tip={exportWhy || "Grade every file with this look and save the results to the Graded folder of your Library"}
        onClick={() => !exportWhy && void exportAll()}
      >
        {noInput ? "Export" : inputs.length === 1 ? "Export 1 file" : `Export ${inputs.length} files`}
      </Button>
      <p className={styles.note}>
        Results go to <strong>Graded</strong> in your Library, named after the file and the look. Originals are never touched.
        {hasPictures ? " Pictures keep their full size." : ""}
        {hasVideos ? " Videos become .mp4 with their sound kept." : ""}
      </p>
      <label className={styles.param}>
        <span className={styles.paramLabel}>Pictures as</span>
        <Select size="sm" value={format} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} aria-label="Picture format" onChange={setFormat} />
      </label>

      <div className={styles.divider1} />
      <LookNameField />
      <div className={styles.actions}>
        <Button size="sm" variant="secondary" icon="bookmark-plus" aria-disabled={replica || undefined} data-tip="Keep this look in Mine, under the name in the Look panel" onClick={() => !replica && void saveLook(recipe)}>
          Save look
        </Button>
        <Button size="sm" variant="secondary" icon="file-json" aria-disabled={!!cubeWhy || replica || undefined} data-tip={cubeWhy || "Write a .cube LUT of this look's colour ops, to use in other editors"} onClick={() => !cubeWhy && !replica && void exportCube()}>
          Export .cube
        </Button>
      </div>
      <details className={styles.lutNote}>
        <summary data-tip="A LUT only holds colour changes">What a LUT can't hold</summary>
        <p className={styles.note}>
          A .cube file holds the colour-only ops, as they look everywhere in the picture at this Wildness. It leaves out regions (subject, background, near, far), texture and spatial ops (grain, glow, glitch, blur…) and anything that moves.
        </p>
        {left.ops.length > 0 && (
          <ul className={styles.leftOut}>
            {left.ops.map((o) => {
              const op = recipe.ops.find((x) => x.id === o.id);
              return (
                <li key={o.id}>
                  {op ? opLabel(op.kind) : o.id}: left out ({o.reason})
                </li>
              );
            })}
          </ul>
        )}
      </details>

      <div className={styles.divider1} />
      <ActiveJobs />
      <RecentResults moduleId={MODULE_ID} limit={8} icon="palette" label="Graded" tip="Files this tool made, newest first. Double-click to open." />
      <Button size="sm" variant="ghost" icon="folder-open" data-tip="See everything Color Grader made in the Library" onClick={() => openLibrary({ moduleId: MODULE_ID })}>
        Show all in Library
      </Button>
    </div>
  );
}

/** A one-line text field kept for the look's name in the Export panel's Save look. */
export function LookNameField() {
  const name = useGrade((s) => s.recipe.name);
  return <TextField size="sm" value={name} maxLength={40} aria-label="Look name" data-tip="The name Save look and the exported files use" onChange={(e) => useGrade.getState().renameLook(e.target.value)} />;
}
