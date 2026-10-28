import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Button, DropZone, FileList, Icon, Section, cx } from "@/components";
import { PdfAction, PdfService } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { JobRow } from "@/shell/JobRow";
import { isActive, useOrderedJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useModuleOptions, useFileInputs } from "@/tools/_kit";
import { DepsGate } from "@/tools/_kit/DepsGate";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ToolViewProps } from "@/tools";
import { usePdfIntent } from "./intent";
import { OrderedList } from "./OrderedList";
import { ACTIONS, DEFAULT_PDF_UI, actionMeta, isImagePath, isPdfPath, routeAction, sanitizePdfUi } from "./options";
import {
  CompressPanel,
  ImagesToPdfPanel,
  MergePanel,
  OrganizePanel,
  PdfToImagesPanel,
  ProtectPanel,
  SplitPanel,
  UnlockPanel,
  type PanelProps,
  type RunRequest,
} from "./Panels";
import { PasswordField } from "./PasswordField";
import { Results } from "./Results";
import { usePdfInfos } from "./usePdfInfos";
import styles from "./PdfView.module.css";

const PANELS: Record<PdfAction, ComponentType<PanelProps>> = {
  [PdfAction.$zero]: MergePanel,
  [PdfAction.ActionMerge]: MergePanel,
  [PdfAction.ActionSplit]: SplitPanel,
  [PdfAction.ActionOrganize]: OrganizePanel,
  [PdfAction.ActionCompress]: CompressPanel,
  [PdfAction.ActionImagesToPDF]: ImagesToPdfPanel,
  [PdfAction.ActionPDFToImages]: PdfToImagesPanel,
  [PdfAction.ActionProtect]: ProtectPanel,
  [PdfAction.ActionUnlock]: UnlockPanel,
};

const ORDERED = new Set<PdfAction>([PdfAction.ActionMerge, PdfAction.ActionImagesToPDF]);

export default function PdfView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [ui, setUi, loaded] = useModuleOptions(moduleId, DEFAULT_PDF_UI, sanitizePdfUi);
  const mod = useModules((s) => s.byId[moduleId]);
  const jobs = useOrderedJobs(moduleId);
  const active = jobs.filter(isActive);
  const [password, setPassword] = useState("");
  const [order, setOrder] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});

  const meta = actionMeta(ui.action);
  const uiRef = useRef(ui);
  uiRef.current = ui;

  // Palette handoff: preselect an action.
  const intent = usePdfIntent((s) => s.action);
  useEffect(() => {
    if (!intent || !loaded) return;
    setUi((u) => ({ ...u, action: intent }));
    usePdfIntent.getState().clear();
  }, [intent, loaded, setUi]);

  // Route dropped files to an action that fits them.
  const fileKey = inputs.files.map((f) => f.path).join("\n");
  const routed = useRef("");
  useEffect(() => {
    if (!loaded || fileKey === routed.current) return;
    routed.current = fileKey;
    const next = routeAction(uiRef.current.action, fileKey ? fileKey.split("\n") : []);
    if (next !== uiRef.current.action) setUi((u) => ({ ...u, action: next }));
  }, [fileKey, loaded, setUi]);

  const ordered = useMemo(() => {
    const rank = (p: string) => {
      const i = order.indexOf(p);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return inputs.files.slice().sort((a, b) => rank(a.path) - rank(b.path));
  }, [inputs.files, order]);
  const fit = useMemo(
    () => ordered.filter((f) => (meta.input === "image" ? isImagePath(f.path) : isPdfPath(f.path))),
    [ordered, meta.input],
  );
  const skipped = ordered.length - fit.length;

  const infoPaths = useMemo(() => (meta.input === "pdf" ? fit.map((f) => f.path) : []), [fit, meta.input]);
  const infos = usePdfInfos(infoPaths, password);

  const needs = fit.some((f) => {
    const i = infos[f.path]?.info;
    return !!i && (i.needsPassword || i.restricted);
  });
  const restrictedOnly = needs && fit.every((f) => !infos[f.path]?.info?.needsPassword);
  const wrong = infoPaths.some((p) => /password/i.test(infos[p]?.error ?? ""));
  const showPassword = meta.input === "pdf" && (needs || wrong || ui.action === PdfAction.ActionUnlock);
  const blocker = wrong ? "Wrong password" : needs && password === "" ? "Enter the PDF's password to continue" : "";

  const move = (from: number, to: number) => {
    const next = ordered.map((f) => f.path);
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    setOrder(next);
  };

  const run = async (req: RunRequest) => {
    setRunning(true);
    const res = await submitJobs(
      () => PdfService.Enqueue(req.paths, req.options, password, req.newPassword ?? ""),
      req.paths,
      ["job", "jobs"],
    );
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) {
      inputs.clear();
      setPassword("");
    }
  };

  const Panel = PANELS[ui.action];
  const empty = ordered.length === 0;
  const totalSize = ordered.reduce((n, f) => n + f.sizeBytes, 0);
  const fileErrors: Record<string, string> = { ...inputErrors };
  for (const p of infoPaths) {
    const e = infos[p]?.error;
    if (e && !/password/i.test(e)) fileErrors[p] = e;
  }

  return (
    <section className={styles.root} aria-label={mod?.name ?? "PDF Toolkit"}>
      <header>
        <h1 className={styles.title}>{mod?.name ?? "PDF Toolkit"}</h1>
        {mod?.tagline && <p className={styles.tagline}>{mod.tagline}</p>}
      </header>
      <DepsGate moduleId={moduleId} />
      <div className={styles.body}>
        <div role="radiogroup" aria-label="PDF action" className={styles.picker}>
          {ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={a.id === ui.action}
              tabIndex={a.id === ui.action ? 0 : -1}
              className={cx(styles.action, a.id === ui.action && styles.actionOn)}
              onClick={() => setUi((u) => ({ ...u, action: a.id }))}
              onKeyDown={(e) => {
                const i = ACTIONS.findIndex((x) => x.id === ui.action);
                const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                const n = ACTIONS[(i + d + ACTIONS.length) % ACTIONS.length];
                if (n) setUi((u) => ({ ...u, action: n.id }));
              }}
            >
              <Icon name={a.icon} size={16} className={styles.actionIcon} />
              <span className={styles.actionText}>
                <span className={styles.actionTitle}>{a.title}</span>
                <span className={styles.actionDesc}>{a.desc}</span>
              </span>
            </button>
          ))}
        </div>

        <div className={styles.main}>
          <Section
            label="Input"
            action={
              !empty && (
                <span className={styles.summaryBar}>
                  <span className={styles.mono}>
                    {ordered.length} {ordered.length === 1 ? "file" : "files"} · {formatBytes(totalSize)}
                  </span>
                  <Button size="sm" variant="secondary" icon="plus" onClick={() => void inputs.pick()}>
                    Add files…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={inputs.clear}>
                    Clear
                  </Button>
                </span>
              )
            }
          >
            {empty ? (
              <DropZone
                id={`tool-drop:${moduleId}`}
                label={meta.input === "image" ? "Drop images here or Add files…" : "Drop PDFs here or Add files…"}
              >
                <Button size="sm" variant="secondary" icon="plus" onClick={() => void inputs.pick()}>
                  Add files…
                </Button>
              </DropZone>
            ) : ORDERED.has(ui.action) ? (
              <OrderedList
                files={fit}
                kind={meta.input}
                infos={infos}
                password={password}
                onMove={move}
                onRemove={inputs.remove}
                inputErrors={fileErrors}
              />
            ) : (
              <FileList
                aria-label="Input files"
                files={fit.map((f) => {
                  const err = fileErrors[f.path];
                  const pages = infos[f.path]?.info?.pages;
                  return {
                    path: f.path,
                    size: f.sizeBytes,
                    trailing: err ? (
                      <span className={styles.error} role="alert">
                        {err}
                      </span>
                    ) : pages ? (
                      <span className={styles.mono}>{pages} pages</span>
                    ) : undefined,
                  };
                })}
                onRemove={inputs.remove}
              />
            )}
            {skipped > 0 && (
              <p className={styles.note}>
                {skipped} {skipped === 1 ? "file doesn't" : "files don't"} fit {meta.title} and will be ignored.
              </p>
            )}
          </Section>

          {showPassword && (
            <PasswordField
              label={restrictedOnly ? "Owner password" : "Password"}
              value={password}
              onChange={setPassword}
              error={wrong ? "Wrong password" : undefined}
              hint={needs && !wrong ? "This PDF is protected." : undefined}
            />
          )}

          <Panel
            key={ui.action}
            files={fit}
            infos={infos}
            password={password}
            blocker={blocker}
            ui={ui}
            setUi={setUi}
            run={(r) => void run(r)}
            running={running}
          />

          {active.length > 0 && (
            <Section label="Active">
              <div className={styles.jobs}>
                {active.map((j) => (
                  <JobRow key={j.id} job={j} compact />
                ))}
              </div>
            </Section>
          )}
          <Results moduleId={moduleId} />
        </div>
      </div>
    </section>
  );
}
