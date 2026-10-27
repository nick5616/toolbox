import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  PathText,
  Section,
  SegmentedControl,
  Spinner,
  Stepper,
  Tooltip,
  toast,
} from "@/components";
import { DepSource, DepState, LibraryService, SettingsService, Theme } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useDeps, type DepView } from "@/state/deps";
import { isActive, useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useSettings } from "@/state/settings";
import styles from "./SettingsView.module.css";

const YTDLP_ID = "yt-dlp";
const YTDLP_JOB_MODULE = "system-ytdlp-update";

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
  return <Badge tone={dep.required ? "danger" : "warn"}>Missing</Badge>;
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
        <thead>
          <tr>
            <th>Tool</th>
            <th>Status</th>
            <th>Version</th>
            <th>Source</th>
            <th>Path</th>
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
              <tr key={d.id}>
                <td>
                  <div className={styles.toolName}>{d.name}</div>
                  <div className={styles.subtle}>{d.purpose}</div>
                  {names.length > 0 ? (
                    <div className={styles.subtle}>Required by {names.join(", ")}</div>
                  ) : d.recommendedBy.length > 0 ? (
                    <div className={styles.subtle}>Recommended</div>
                  ) : null}
                </td>
                <td>
                  <DepChip dep={d} />
                </td>
                <td className={styles.mono}>{ok ? d.version : ""}</td>
                <td>{ok ? (sourceLabel[d.source] ?? "") : ""}</td>
                <td>{ok && d.path ? <PathText path={d.path} copy /> : null}</td>
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
