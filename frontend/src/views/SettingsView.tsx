import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  PathText,
  Section,
  SegmentedControl,
  Spinner,
  Stepper,
  Tooltip,
  toast,
} from "@/components";
import { DepSource, DepState, DepsService, LibraryService, SettingsService, Theme } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useDeps, type DepView } from "@/state/deps";
import { isActive, useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useSettings } from "@/state/settings";
import { SettingsClipboard } from "./SettingsClipboard";
import { SettingsGeneral } from "./SettingsGeneral";
import { SettingsVault } from "./SettingsVault";
import styles from "./SettingsView.module.css";

const YTDLP_ID = "yt-dlp";
const YTDLP_JOB_MODULE = "system-ytdlp-update";
const UV_ID = "uv";
const EXIFTOOL_ID = "exiftool";
const EXIFTOOL_JOB_MODULE = "system-exiftool-update";
const UPSCAYL_ID = "upscayl";
const UPSCALER_JOB_MODULE = "system-upscaler-install";
const AUDIO_ENGINE_ID = "audio-engine";
const AUDIO_ENGINE_JOB_MODULE = "system-audio-engine";

const themeOptions = [
  { value: Theme.ThemeSystem, label: "System" },
  { value: Theme.ThemeDark, label: "Dark" },
  { value: Theme.ThemeLight, label: "Light" },
];

const sourceLabel: Record<string, string> = {
  [DepSource.SourceManaged]: "Toolbox",
  [DepSource.SourcePath]: "PATH",
  [DepSource.SourceKnownDir]: "System",
};

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

async function copy(text: string, title: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title });
  } catch (e) {
    fail(e);
  }
}

function DepChip({ dep }: { dep: DepView }) {
  if (dep.state === DepState.DepOK) return <Badge tone="ok">OK</Badge>;
  if (dep.state === DepState.DepError) {
    const chip = <Badge tone="danger">Error</Badge>;
    return dep.error ? <Tooltip label={dep.error}>{chip}</Tooltip> : chip;
  }
  if (dep.state === DepState.DepOutdated) return <Badge tone="warn">Update</Badge>;
  return <Badge tone={dep.required ? "danger" : "warn"}>Missing</Badge>;
}

/** AI engine actions (install/update/repair/remove) plus the models sub-row. */
function AudioEngineActions({ dep }: { dep: DepView }) {
  const jobsById = useJobs((s) => s.byId);
  const busy = useMemo(
    () => Object.values(jobsById).some((j) => j.moduleId === AUDIO_ENGINE_JOB_MODULE && isActive(j)),
    [jobsById],
  );
  const [queuing, setQueuing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const installed = dep.state === DepState.DepOK || dep.state === DepState.DepOutdated;

  const install = async () => {
    setQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.InstallAudioEngine());
    } catch (e) {
      fail(e);
    } finally {
      setQueuing(false);
    }
  };
  const remove = async () => {
    setConfirmRemove(false);
    try {
      await DepsService.RemoveAudioEngine();
      toast({ title: "AI engine removed" });
      await useDeps.getState().recheck();
    } catch (e) {
      fail(e);
    }
  };

  const label = dep.state === DepState.DepOutdated ? "Update" : dep.state === DepState.DepOK ? "Repair" : "Install";
  return (
    <span className={styles.actionGroup}>
      <Button size="sm" variant="secondary" loading={queuing || busy} onClick={() => void install()}>
        {label}
      </Button>
      {installed && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
      )}
      <ConfirmDialog
        open={confirmRemove}
        tone="danger"
        title="Remove the AI engine?"
        body="Remove the AI engine? This frees about 1.4 GB. Downloaded models are kept."
        confirmLabel="Remove"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </span>
  );
}

function ModelsRow() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);

  const refresh = async () => {
    try {
      setBytes(await DepsService.ModelsUsage());
    } catch {
      setBytes(null);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    setConfirm(false);
    try {
      await DepsService.ClearModels();
      toast({ title: "Models cleared" });
    } catch (e) {
      fail(e);
    }
    await refresh();
  };

  return (
    <tr>
      <td colSpan={5} className={styles.subRow}>
        <span>Models: {bytes == null ? "…" : formatBytes(bytes)}</span>
        <span aria-hidden="true"> · </span>
        <Button size="sm" variant="ghost" disabled={!bytes} onClick={() => setConfirm(true)}>
          Clear models
        </Button>
        <ConfirmDialog
          open={confirm}
          tone="danger"
          title="Clear downloaded models?"
          body="Models are downloaded again the next time a tool needs them."
          confirmLabel="Clear models"
          onConfirm={() => void clear()}
          onCancel={() => setConfirm(false)}
        />
      </td>
    </tr>
  );
}

function DepsTable() {
  const list = useDeps((s) => s.list);
  const checking = useDeps((s) => s.checking);
  const modulesById = useModules((s) => s.byId);
  const jobsById = useJobs((s) => s.byId);
  const updating = useMemo(
    () => Object.values(jobsById).some((j) => j.moduleId === YTDLP_JOB_MODULE && isActive(j)),
    [jobsById],
  );
  const [queuing, setQueuing] = useState(false);
  const [uvQueuing, setUvQueuing] = useState(false);
  const [exifQueuing, setExifQueuing] = useState(false);
  const exifUpdating = useMemo(
    () => Object.values(jobsById).some((j) => j.moduleId === EXIFTOOL_JOB_MODULE && isActive(j)),
    [jobsById],
  );

  const [upscalerQueuing, setUpscalerQueuing] = useState(false);
  const upscalerInstalling = useMemo(
    () => Object.values(jobsById).some((j) => j.moduleId === UPSCALER_JOB_MODULE && isActive(j)),
    [jobsById],
  );

  const installUpscaler = async () => {
    setUpscalerQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.InstallUpscaler());
      toast({ title: "Upscaler install queued" });
    } catch (e) {
      fail(e);
    } finally {
      setUpscalerQueuing(false);
    }
  };

  const updateExiftool = async () => {
    setExifQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.UpdateExiftool());
      toast({ title: "ExifTool install queued" });
    } catch (e) {
      fail(e);
    } finally {
      setExifQueuing(false);
    }
  };

  const updateUv = async () => {
    setUvQueuing(true);
    try {
      useJobs.getState().upsert(await DepsService.UpdateUv());
      toast({ title: "uv update queued" });
    } catch (e) {
      fail(e);
    } finally {
      setUvQueuing(false);
    }
  };

  const updateYtDlp = async () => {
    setQueuing(true);
    try {
      await useDeps.getState().updateYtDlp();
      toast({ title: "yt-dlp update queued" });
    } catch (e) {
      fail(e);
    } finally {
      setQueuing(false);
    }
  };

  return (
    <Section
      label="Dependencies"
      action={
        <Button
          size="sm"
          variant="secondary"
          icon="refresh-cw"
          loading={checking}
          onClick={() => void useDeps.getState().recheck().catch(fail)}
        >
          Recheck
        </Button>
      }
    >
      <table className={styles.table}>
        <colgroup>
          <col />
          <col className={styles.colStatus} />
          <col className={styles.colVersion} />
          <col className={styles.colSource} />
          <col className={styles.colAction} />
        </colgroup>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Status</th>
            <th>Version</th>
            <th>Source</th>
            <th>
              <span className={styles.srOnly}>Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((d) => {
            const ok = d.state === DepState.DepOK;
            const names = d.requiredBy.map((id) => modulesById[id]?.name ?? id);
            return (
              <Fragment key={d.id}>
              <tr>
                <td>
                  <div className={styles.toolName}>{d.name}</div>
                  <div className={styles.subtle}>{d.purpose}</div>
                  {ok && d.path ? (
                    <div className={styles.depPath}>
                      <PathText path={d.path} copy />
                    </div>
                  ) : null}
                  {d.id === UPSCAYL_ID && ok && d.version ? (
                    <div className={styles.subtle}>Pinned version {d.version}</div>
                  ) : null}
                  {names.length > 0 ? (
                    <div className={styles.subtle}>Required by {names.join(", ")}</div>
                  ) : d.recommendedBy.length > 0 ? (
                    <div className={styles.subtle}>Recommended</div>
                  ) : null}
                </td>
                <td>
                  <DepChip dep={d} />
                </td>
                <td className={styles.version} title={ok ? d.version : undefined}>
                  {ok ? d.version : ""}
                </td>
                <td>{ok ? (sourceLabel[d.source] ?? "") : ""}</td>
                <td className={styles.action}>
                  {d.id === YTDLP_ID ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={queuing || updating}
                      onClick={() => void updateYtDlp()}
                    >
                      {ok ? "Update" : "Install"}
                    </Button>
                  ) : d.id === UV_ID ? (
                    <Button size="sm" variant="secondary" loading={uvQueuing} onClick={() => void updateUv()}>
                      {ok ? "Update" : "Install"}
                    </Button>
                  ) : d.id === EXIFTOOL_ID ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={exifQueuing || exifUpdating}
                      onClick={() => void updateExiftool()}
                    >
                      {ok ? "Update" : "Install"}
                    </Button>
                  ) : d.id === UPSCAYL_ID ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={upscalerQueuing || upscalerInstalling}
                      onClick={() => void installUpscaler()}
                    >
                      {ok ? "Update" : "Install"}
                    </Button>
                  ) : d.id === AUDIO_ENGINE_ID ? (
                    <AudioEngineActions dep={d} />
                  ) : !ok ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="copy"
                      onClick={() => void copy(d.installHint, "Install command copied")}
                    >
                      Copy install command
                    </Button>
                  ) : null}
                </td>
              </tr>
              {d.id === AUDIO_ENGINE_ID && d.state !== DepState.DepMissing ? <ModelsRow /> : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {checking && list.length === 0 ? <Spinner label="Checking tools" /> : null}
    </Section>
  );
}

export function SettingsView() {
  const settings = useSettings((s) => s.settings);
  const appInfo = useSettings((s) => s.appInfo);
  const [dirError, setDirError] = useState("");

  const changeDir = async () => {
    try {
      const dir = await SettingsService.ChooseLibraryDir();
      if (!dir) return;
      setDirError("");
      await useSettings.getState().update({ libraryDir: dir });
    } catch (e) {
      const err = toAppError(e);
      const msg = err.fields?.libraryDir;
      if (msg) setDirError(msg);
      else fail(e);
    }
  };

  const patch = (p: Parameters<ReturnType<typeof useSettings.getState>["update"]>[0]) =>
    useSettings.getState().update(p).catch(fail);

  return (
    <div className={styles.scroll}>
      <section className={styles.root} aria-label="Settings">
        <h1 className={styles.title}>Settings</h1>

        <SettingsGeneral />

        <Section label="Library">
          <div className={styles.row}>
            <PathText path={settings.libraryDir} />
            <Button size="sm" variant="secondary" onClick={() => void changeDir()}>
              Change…
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void LibraryService.OpenLibraryFolder("").catch(fail)}
            >
              Open
            </Button>
          </div>
          {dirError ? (
            <Banner tone="danger">{dirError}</Banner>
          ) : null}
          <p className={styles.note}>Existing files stay where they are.</p>
        </Section>

        <Section label="Jobs">
          <div className={styles.row}>
            <span id="parallel-jobs-label">Parallel jobs</span>
            <Stepper
              aria-labelledby="parallel-jobs-label"
              min={1}
              max={8}
              value={settings.concurrency}
              onChange={(n) => void patch({ concurrency: n })}
            />
          </div>
        </Section>

        <Section label="Appearance">
          <SegmentedControl<Theme>
            aria-label="Theme"
            value={settings.theme}
            options={themeOptions}
            onChange={(t) => void patch({ theme: t })}
          />
        </Section>

        <SettingsClipboard />

        <SettingsVault />

        <DepsTable />

        <Section label="About">
          {appInfo ? (
            <dl className={styles.about}>
              <dt>Version</dt>
              <dd className={styles.mono}>{appInfo.version}</dd>
              <dt>System</dt>
              <dd className={styles.mono}>
                {appInfo.os}/{appInfo.arch}
              </dd>
              <dt>Support folder</dt>
              <dd className={styles.pathRow}>
                <PathText path={appInfo.supportDir} />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void LibraryService.RevealPath(appInfo.supportDir).catch(fail)}
                >
                  Open
                </Button>
              </dd>
              <dt>Database</dt>
              <dd>
                <PathText path={appInfo.dbPath} />
              </dd>
              <dt>Log file</dt>
              <dd className={styles.pathRow}>
                <PathText path={appInfo.logPath} />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void LibraryService.RevealPath(appInfo.logPath).catch(fail)}
                >
                  Open
                </Button>
              </dd>
            </dl>
          ) : (
            <Spinner label="Loading" />
          )}
        </Section>
      </section>
    </div>
  );
}
