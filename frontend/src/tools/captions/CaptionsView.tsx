import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner, Button, Field, Section, SegmentedControl, Select, Stepper, Switch, TextArea, ToolHeader, toast } from "@/components";
import { CaptionField, CaptionPreset, CaptionService, JobStatus, PacksService, type CaptionOptions, type CaptionStatus } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import type { ToolViewProps } from "@/lib/toolActions";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useDeps } from "@/state/deps";
import { usePacks } from "@/state/packs";
import { EmptyLine, FileToolLayout, ResultRow, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { BatchBar, BatchFiles } from "./BatchBar";
import { CaptionCard } from "./CaptionCard";
import { RenameDialog, WriteDialog } from "./Dialogs";
import { PastBatches } from "./PastBatches";
import {
  DEFAULT_CAPTION_OPTIONS,
  LANGUAGES,
  LENGTHS,
  MAX_FILES,
  NAME_PATTERNS,
  PRESET_FIELDS,
  PRESET_OPTIONS,
  TONES,
  advancedSummary,
  encodeUse,
  isVideoPath,
  oneOf,
  sanitizeCaptionOptions,
  statusOf,
} from "./options";
import { SaveStateLabel } from "./SaveStateLabel";
import { useBatch } from "./useBatch";
import styles from "./captions.module.css";

const NO_STATUS: CaptionStatus = { model: "", modelLabel: "", problem: "", exifTool: true, ffmpeg: true, searchHints: false };
const PACK_ID = "captions";

/** The preset's fields in display order (from Go; the local table until it answers). */
function useFieldOrder(preset: CaptionPreset): CaptionField[] {
  const [order, setOrder] = useState<CaptionField[]>(PRESET_FIELDS[preset] ?? PRESET_FIELDS[CaptionPreset.PresetPosting]);
  useEffect(() => {
    setOrder(PRESET_FIELDS[preset] ?? PRESET_FIELDS[CaptionPreset.PresetPosting]);
    let live = true;
    CaptionService.Fields(preset)
      .then((f) => {
        if (live && f && f.length > 0) setOrder(f);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [preset]);
  return order;
}

function useCaptionStatus(): CaptionStatus {
  const [status, setStatus] = useState<CaptionStatus>(NO_STATUS);
  const packs = usePacks((s) => s.list);
  const deps = useDeps((s) => s.list);
  useEffect(() => {
    let live = true;
    CaptionService.Status()
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [packs, deps]);
  return status;
}

/** "Install the Caption Writer pack" under the gate's message. */
function GateBanner({ problem }: { problem: string }) {
  const pack = usePacks((s) => s.byId[PACK_ID]);
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try {
      const res = await PacksService.Install([PACK_ID], "");
      for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
      if (res.restart) await PacksService.Relaunch();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      tone="warn"
      title="Caption Writer needs its picture-reading model"
      action={
        <Button size="sm" variant="primary" icon="download" loading={busy} disabled={busy} data-tip="Download the Caption Writer pack: the model that reads pictures, plus ExifTool and FFmpeg" onClick={() => void install()}>
          Install the {pack?.name ?? "Caption Writer"} pack
        </Button>
      }
    >
      {problem}
    </Banner>
  );
}

/** The copies a write/rename job made. */
function ActionResults({ job }: { job: JobView }) {
  const label = job.title || "Copies";
  const folder = job.outputs[0]?.path ?? "";
  if (isActive(job)) {
    return (
      <Section label={label} tip="The job that is making copies">
        <EmptyLine title={job.status === JobStatus.JobQueued ? "Waiting to start…" : "Making copies…"} />
      </Section>
    );
  }
  if (job.status === JobStatus.JobFailed) {
    return (
      <Section label={label} tip="The job that made copies">
        <EmptyLine title="It didn't finish." body={job.error ?? ""} />
      </Section>
    );
  }
  const shown = job.outputs.slice(0, 20);
  return (
    <Section label={label} tip="The copies this batch made; your originals were not changed">
      {job.outputs.length === 0 ? (
        <EmptyLine title={job.status === JobStatus.JobCancelled ? "Cancelled." : "Nothing was written."} />
      ) : (
        <div className={styles.files}>
          {shown.map((o) => (
            <ResultRow key={o.id} path={o.path} outputId={o.id} missing={o.missing} name={o.name} sizeBytes={o.sizeBytes} at={o.createdAt} moduleId="captions" />
          ))}
          {job.outputs.length > shown.length && folder !== "" && <p className={styles.help}>and {job.outputs.length - shown.length} more in the same folder</p>}
        </div>
      )}
    </Section>
  );
}

export default function CaptionsView({ moduleId }: ToolViewProps) {
  const embed = useEmbed();
  const inputs = useFileInputs(moduleId);
  const [defaults, setDefaults] = useState<CaptionOptions>(DEFAULT_CAPTION_OPTIONS);
  const [opts, setOpts, loaded] = useModuleOptions(moduleId, defaults, sanitizeCaptionOptions);
  const status = useCaptionStatus();
  const api = useBatch();
  const [batches, setBatches] = useState<Awaited<ReturnType<typeof CaptionService.Batches>> | null>(null);
  const [dialog, setDialog] = useState<"" | "write" | "rename">("");
  const [submitting, setSubmitting] = useState(false);
  const actionJob = useJobs((s) => (api.actionJobId ? s.byId[api.actionJobId] : undefined));

  useEffect(() => {
    let live = true;
    CaptionService.Defaults()
      .then((d) => live && d && setDefaults(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // A host's start-up request: its text becomes the context, its action picks the preset.
  const handoff = embed?.handoff;
  useEffect(() => {
    if (!handoff || !loaded) return;
    const body = handoff.text?.body;
    const preset = oneOf(handoff.action, PRESET_OPTIONS.map((p) => p.value), "" as CaptionPreset);
    if (body !== undefined || preset !== "") setOpts((o) => ({ ...o, ...(body !== undefined ? { context: body } : {}), ...(preset !== "" ? { preset } : {}) }));
  }, [handoff, loaded, setOpts]);

  const refreshBatches = useCallback(() => {
    CaptionService.Batches()
      .then((b) => setBatches(b ?? []))
      .catch(() => setBatches([]));
  }, []);
  const batchDir = api.batch?.dir ?? "";
  useEffect(() => {
    if (!api.running) refreshBatches();
  }, [api.running, batchDir, refreshBatches]);

  const batchPreset = api.batch?.options?.preset || opts.preset;
  const fieldOrder = useFieldOrder(batchPreset);

  const paths = inputs.files.map((f) => f.path);
  const hasVideo = paths.some(isVideoPath);
  const reason = useMemo(() => {
    if (status.problem !== "") return "Install the Caption Writer pack first";
    if (hasVideo && !status.ffmpeg) return "Videos need FFmpeg: install the Caption Writer pack, or remove the videos";
    if (paths.length > MAX_FILES) return `At most ${MAX_FILES} files at a time`;
    if (api.running) return "A batch is still being written";
    return undefined;
  }, [status, hasVideo, paths.length, api.running]);

  const onRun = async () => {
    setSubmitting(true);
    try {
      await api.start(paths, { ...opts, notes: {} });
      inputs.clear();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  };

  const guard = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const useLabel = embed?.onUse ? embed.useLabel : "";
  const useItem = (index: number) => {
    const it = api.batch?.items[index];
    if (!it || !embed?.onUse) return;
    embed.onUse([encodeUse({ input: it.input, caption: it.fields.caption, hashtags: it.fields.hashtags, alt: it.fields.alt })]);
    if (embed.placement !== "window") toast({ title: `Sent to ${embed.hostName}`, tone: "success" });
  };
  const useFirst = () => {
    const i = api.batch?.items.findIndex((x) => statusOf(x) === "done") ?? -1;
    if (i >= 0) useItem(i);
  };

  const batch = api.batch;
  const compact = embed !== null;
  const doneItems = batch?.items.filter((i) => statusOf(i) === "done") ?? [];
  const images = doneItems.filter((i) => !isVideoPath(i.input)).length;
  const videos = doneItems.length - images;
  const failed = batch?.items.filter((i) => statusOf(i) === "failed").length ?? 0;
  const pending = batch?.items.filter((i) => statusOf(i) === "pending").length ?? 0;


  return (
    <>
      <ToolHeader aria-label="Caption Writer">
        <SaveStateLabel state={api.saveState} />
      </ToolHeader>
      <FileToolLayout
        moduleId={moduleId}
        inputs={inputs}
        runLabel={runLabel("Write captions for", paths.length, "file", "files")}
        onRun={onRun}
        running={submitting}
        runDisabledReason={reason}
        primary={
          <>
            {status.problem !== "" && <GateBanner problem={status.problem} />}
            <Field label="Write">
              <SegmentedControl<CaptionPreset>
                aria-label="Write"
                value={opts.preset}
                options={PRESET_OPTIONS.map((p) => ({ value: p.value, label: p.label, tip: p.tip }))}
                onChange={(preset) => setOpts((o) => ({ ...o, preset }))}
              />
            </Field>
            <Field label="Context">
              {(c) => (
                <TextArea
                  id={c.id}
                  aria-describedby={c["aria-describedby"]}
                  data-tip="Anything the writer should know about all of these files: where, when, who. Names only come from here or from a note on a card"
                  value={opts.context}
                  minRows={2}
                  maxRows={5}
                  placeholder="Lisbon trip, May 2026. The dog is Max."
                  onChange={(e) => setOpts((o) => ({ ...o, context: e.target.value }))}
                />
              )}
            </Field>
          </>
        }
        advancedSummary={advancedSummary(opts)}
        advanced={
          <div className={styles.options}>
            <Field label="Tone">
              <SegmentedControl aria-label="Tone" size="sm" value={opts.tone} options={TONES.map((t) => ({ value: t.value, label: t.label }))} onChange={(tone) => setOpts((o) => ({ ...o, tone }))} />
            </Field>
            <Field label="Length">
              <SegmentedControl aria-label="Length" size="sm" value={opts.length} options={LENGTHS.map((t) => ({ value: t.value, label: t.label }))} onChange={(length) => setOpts((o) => ({ ...o, length }))} />
            </Field>
            <Field label="Language">
              {(c) => (
                <Select id={c.id} size="sm" aria-label="Language" value={opts.language} options={[{ value: "", label: "Auto (the app's language)" }, ...LANGUAGES.map((l) => ({ value: l, label: l }))]} onChange={(language) => setOpts((o) => ({ ...o, language }))} />
              )}
            </Field>
            <Switch checked={opts.emoji} onChange={(emoji) => setOpts((o) => ({ ...o, emoji }))} label="Emoji" tip="Allow emoji in captions" />
            <Field label="Hashtags">
              <Stepper aria-label="Hashtags" min={0} max={15} value={opts.hashtags} onChange={(hashtags) => setOpts((o) => ({ ...o, hashtags }))} data-tip="How many hashtags to suggest (0 to 15)" />
            </Field>
            <Field label="File names">
              {(c) => (
                <Select id={c.id} size="sm" aria-label="File names" value={opts.namePattern} options={NAME_PATTERNS.map((p) => ({ value: p.value, label: p.label }))} onChange={(namePattern) => setOpts((o) => ({ ...o, namePattern }))} />
              )}
            </Field>
            <Switch checked={opts.kebab} onChange={(kebab) => setOpts((o) => ({ ...o, kebab }))} label="kebab-case names" tip="Write file names like lisbon-tram-at-dusk" />
            <Switch
              checked={opts.useHints && status.searchHints}
              disabled={!status.searchHints}
              onChange={(useHints) => setOpts((o) => ({ ...o, useHints }))}
              label="Use Smart search hints"
              tip={status.searchHints ? "Give the writer the labels and text Smart search already found in each file" : "Smart search isn't installed, so there are no hints to use"}
            />
            <Switch checked={opts.readText} onChange={(readText) => setOpts((o) => ({ ...o, readText }))} label="Mention words in the picture" tip="Let captions quote words that are visible in the picture, like signs" />
            <p className={styles.help} data-tip="The model that reads your pictures; it runs on this computer">
              Model: {status.modelLabel || "none installed"}
            </p>
          </div>
        }
        moreClickIns={<PastBatches batches={batches} currentDir={batchDir} onOpen={(dir) => guard(api.open(dir))} onDelete={(dir) => guard(CaptionService.DeleteBatch(dir).then(() => { if (dir === batchDir) api.close(); refreshBatches(); }))} />}
        results={
          <>
            {batch ? (
              <Section
                label={batch.name || "Captions"}
                tip="One card per file; edit any text and it is saved"
                action={
                  pending > 0 || failed > 0 ? (
                    <span className={styles.batchCount}>
                      {pending > 0 ? `${pending} waiting` : ""}
                      {pending > 0 && failed > 0 ? " · " : ""}
                      {failed > 0 ? `${failed} failed` : ""}
                    </span>
                  ) : undefined
                }
              >
                {batch.dir !== "" && (
                  <BatchBar
                    batch={batch}
                    busy={api.running}
                    exifTool={status.exifTool}
                    onWrite={() => setDialog("write")}
                    onRename={() => setDialog("rename")}
                    onUseFirst={useLabel ? useFirst : undefined}
                    useLabel={useLabel}
                  />
                )}
                <div className={styles.cards}>
                  {batch.items.map((item, i) => (
                    <CaptionCard
                      key={`${item.input}#${i}`}
                      item={item}
                      index={i}
                      fields={fieldOrder}
                      busy={api.busy[i] === true}
                      compact={compact}
                      useLabel={useLabel}
                      canRegenerate={batch.dir !== "" && !api.running}
                      onEdit={api.edit}
                      onNote={api.setNote}
                      onRegenerate={(idx, all) => void guard(api.regenerate(idx, all))}
                      onRetry={(idx) => void guard(api.regenerate(idx, true))}
                      onUse={useItem}
                    />
                  ))}
                </div>
                {batch.dir !== "" && !api.running && <BatchFiles batch={batch} />}
              </Section>
            ) : (
              <Section label="Captions" tip="The text written for your files appears here, one card per file">
                <EmptyLine title="Nothing written yet." body="Add photos or videos and choose Write captions. Each file's card appears as soon as it's done." />
              </Section>
            )}
            {actionJob && <ActionResults job={actionJob} />}
            {dialog === "write" && batch && (
              <WriteDialog
                initial={opts.write}
                images={images}
                videos={videos}
                onClose={() => setDialog("")}
                onWrite={(w) => {
                  setDialog("");
                  void guard(api.runAction("write", w));
                }}
              />
            )}
            {dialog === "rename" && batch && (
              <RenameDialog
                items={batch.items}
                pattern={batch.options?.namePattern ?? opts.namePattern}
                onClose={() => setDialog("")}
                onRename={() => {
                  setDialog("");
                  void guard(api.runAction("rename"));
                }}
              />
            )}
          </>
        }
      />
    </>
  );
}
