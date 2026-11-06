import { useMemo, useRef, useState } from "react";
import { Button, ClickIn, Field, Icon, IconButton, Section, SegmentedControl, Select, Slider, TextField, toast } from "@/components";
import { FilesService, JobStatus, LibraryService, OrganizeDupMode, OrganizeGroupBy, OrganizeService, type OrganizeOptions } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { useToolHandoff } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { type JobView, useOrderedJobs } from "@/state/jobs";
import type { ToolViewProps } from "@/tools";
import { EmptyLine, FileToolLayout, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import { formatResultDate } from "@/tools/_kit/format";
import {
  ACTION_OPTIONS,
  DEFAULT_ORGANIZE_OPTIONS,
  DUPLICATE_OPTIONS,
  GROUP_OPTIONS,
  MAX_SIMILARITY,
  MIN_SIMILARITY,
  PATTERN_TOKENS,
  advancedSummaryParts,
  baseName,
  parseSummary,
  patternProblem,
  sanitizeOrganizeOptions,
} from "./options";
import { PreviewPanel } from "./PreviewPanel";
import styles from "./OrganizeView.module.css";

const PREVIEW_ID = "organize-preview";
const RESULTS_SHOWN = 5;

type SetOpts = (f: (o: OrganizeOptions) => OrganizeOptions) => void;

function AdvancedOptions({ opts, setOpts, problem }: { opts: OrganizeOptions; setOpts: SetOpts; problem: string }) {
  const pickDestination = async () => {
    try {
      const dir = await FilesService.PickFolder("Put the organized copies in");
      if (dir) setOpts((o) => ({ ...o, destination: dir }));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  return (
    <div className={styles.stack}>
      <Field label="Folder pattern" hint={`Folders inside the result, like {yyyy}/{mm}/{type}. You can use ${PATTERN_TOKENS.join(" ")}.`}>
        {(c) => (
          <TextField
            id={c.id}
            aria-describedby={c["aria-describedby"]}
            mono
            value={opts.pattern}
            invalid={opts.groupBy === OrganizeGroupBy.GroupPattern && problem !== ""}
            disabled={opts.groupBy !== OrganizeGroupBy.GroupPattern}
            data-tip={opts.groupBy === OrganizeGroupBy.GroupPattern ? "How the folders are named" : 'Choose "Pattern" under Group by to use this'}
            onChange={(e) => setOpts((o) => ({ ...o, pattern: e.target.value }))}
          />
        )}
      </Field>
      {opts.groupBy === OrganizeGroupBy.GroupPattern && problem !== "" && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      <Field label="Duplicates">
        <SegmentedControl
          aria-label="Duplicates"
          value={opts.duplicates}
          options={DUPLICATE_OPTIONS.map((d) => ({ value: d.value, label: d.label, tip: d.tip }))}
          onChange={(duplicates) => setOpts((o) => ({ ...o, duplicates }))}
        />
      </Field>
      {opts.duplicates === OrganizeDupMode.DupSimilar && (
        <Field label="Similarity" hint="Higher means the photos must look more alike.">
          {(c) => (
            <Slider
              id={c.id}
              aria-label="Similarity"
              min={MIN_SIMILARITY}
              max={MAX_SIMILARITY}
              step={1}
              value={opts.similarity}
              format={(v) => `${v}%`}
              data-tip="How alike two photos must look to count as the same picture"
              onChange={(similarity) => setOpts((o) => ({ ...o, similarity }))}
            />
          )}
        </Field>
      )}
      {opts.duplicates !== OrganizeDupMode.DupOff && (
        <Field label="Duplicates go">
          {(c) => (
            <Select
              id={c.id}
              value={opts.dupAction}
              options={ACTION_OPTIONS}
              data-tip="The best copy (largest, then oldest) stays in its folder; the others are set aside"
              onChange={(dupAction) => setOpts((o) => ({ ...o, dupAction }))}
            />
          )}
        </Field>
      )}
      <Field label="Put the result in" hint="A new folder is made inside it. Default: Organized in your library.">
        {() => (
          <span className={styles.row}>
            <span className={styles.pathName} data-tip={opts.destination || "Your library's Organized folder"}>
              {opts.destination ? baseName(opts.destination) : "Library · Organized"}
            </span>
            <Button size="sm" variant="secondary" data-tip="Choose another folder, not inside the files you're organizing" onClick={() => void pickDestination()}>
              Choose…
            </Button>
            {opts.destination !== "" && (
              <Button size="sm" variant="ghost" data-tip="Go back to the library's Organized folder" onClick={() => setOpts((o) => ({ ...o, destination: "" }))}>
                Clear
              </Button>
            )}
          </span>
        )}
      </Field>
      <Field label="Folder name" hint="Leave empty to name it after the date and time.">
        {(c) => (
          <TextField
            id={c.id}
            aria-describedby={c["aria-describedby"]}
            value={opts.runName}
            placeholder="Organized …"
            data-tip="Name of the new folder that holds the copies"
            onChange={(e) => setOpts((o) => ({ ...o, runName: e.target.value }))}
          />
        )}
      </Field>
    </div>
  );
}

function ResultRowView({ job }: { job: JobView }) {
  const sum = parseSummary(job.resultJson);
  const report = job.outputs.find((o) => baseName(o.path) === "report.csv");
  const fail = (e: unknown) => toast({ title: toAppError(e).message, tone: "danger" });
  if (!sum) return null;
  const meta = [
    `${sum.copied} organized`,
    sum.duplicates > 0 && `${sum.duplicates} ${sum.duplicates === 1 ? "duplicate" : "duplicates"}${sum.skipped > 0 ? " left out" : ""}`,
    sum.failed > 0 && `${sum.failed} failed`,
    formatResultDate(job.finishedAt),
  ].filter(Boolean);
  return (
    <li className={styles.result}>
      <Icon name="folder-output" size={16} className={styles.resultIcon} />
      <span className={styles.resultText}>
        <span className={styles.resultName} data-tip={sum.root}>
          {baseName(sum.root)}
        </span>
        <span className={styles.resultMeta}>{meta.join(" · ")}</span>
      </span>
      <span className={styles.resultActions}>
        <IconButton icon="folder-open" label="Open folder" data-tip="Show the organized folder" onClick={() => LibraryService.RevealPath(sum.root).catch(fail)} />
        {report && <IconButton icon="file-text" label="Open report" data-tip="Open report.csv: where every file went and which are duplicates" onClick={() => LibraryService.Open(report.id).catch(fail)} />}
      </span>
    </li>
  );
}

function Results({ moduleId }: { moduleId: string }) {
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(() => jobs.filter((j) => j.status === JobStatus.JobDone && parseSummary(j.resultJson)).slice(0, RESULTS_SHOWN), [jobs]);
  return (
    <Section label="Results" tip="Folders this tool made lately">
      {done.length === 0 ? (
        <EmptyLine title="Nothing organized yet." body="The folder and its report show up here." />
      ) : (
        <ul className={styles.list}>
          {done.map((j) => (
            <ResultRowView key={j.id} job={j} />
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function OrganizeView({ moduleId }: ToolViewProps) {
  // Registered before useFileInputs: folders are expanded to their files first (the file list holds files only).
  const addRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  const expandAndAdd = async (paths: string[]) => {
    try {
      const files = (await OrganizeService.Expand(paths)) ?? [];
      if (files.length === 0) {
        toast({ title: "No files found there", tone: "warn" });
        return;
      }
      await addRef.current(files);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  useToolHandoff(moduleId, (h) => void expandAndAdd(h.inputs));
  const inputs = useFileInputs(moduleId);
  addRef.current = inputs.add;

  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_ORGANIZE_OPTIONS, sanitizeOrganizeOptions);
  const [running, setRunning] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({});

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const problem = opts.groupBy === OrganizeGroupBy.GroupPattern ? patternProblem(opts.pattern) : "";

  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(() => OrganizeService.Enqueue(paths, opts), paths, ["Organizer run", "Organizer runs"]);
    setRunning(false);
    setSubmitErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const pickFolder = async () => {
    try {
      const dir = await FilesService.PickFolder("Add a folder to organize");
      if (dir) await expandAndAdd([dir]);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  useCommands([
    { id: "organize.pick", title: "Organize files…", section: "Organizer", icon: "folder-output", keywords: ["sort", "photos", "duplicates", "folders"], run: () => inputs.pick() },
    { id: "organize.folder", title: "Organize a folder…", section: "Organizer", icon: "folder-input", keywords: ["sort", "camera roll", "duplicates"], run: () => void pickFolder() },
  ]);

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Organize", paths.length, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={submitErrors}
      runDisabledReason={problem !== "" ? problem : undefined}
      primary={
        <div className={styles.stack}>
          <Field label="Group by">
            <SegmentedControl
              aria-label="Group by"
              value={opts.groupBy}
              options={GROUP_OPTIONS.map((g) => ({ value: g.value, label: g.label, tip: g.tip }))}
              onChange={(groupBy) => setOpts((o) => ({ ...o, groupBy }))}
            />
          </Field>
          <Button size="sm" variant="secondary" icon="folder-input" data-tip="Add every file inside a folder, including sub-folders (hidden files are ignored)" onClick={() => void pickFolder()}>
            Add a folder…
          </Button>
        </div>
      }
      advancedSummary={summarize(...advancedSummaryParts(opts))}
      advanced={<AdvancedOptions opts={opts} setOpts={setOpts} problem={problem} />}
      moreClickIns={
        <ClickIn
          id={PREVIEW_ID}
          icon="eye"
          title="Preview"
          summary={paths.length > 0 ? `${paths.length} ${paths.length === 1 ? "file" : "files"}` : "Add files to see the plan"}
          tip="See the folders and the duplicate groups before anything is copied"
          width={560}
          disabledReason={paths.length === 0 ? "Add files first" : problem !== "" ? problem : undefined}
        >
          <PreviewPanel paths={paths} opts={opts} />
        </ClickIn>
      }
      results={<Results moduleId={moduleId} />}
    />
  );
}
