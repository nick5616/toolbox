import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, Icon, Spinner, cx } from "@/components";
import { PackState, type PipelineTemplate, type StepType } from "@/lib/api";
import { usePacks } from "@/state/packs";
import { usePipelines } from "@/state/pipelines";
import { createPipeline, openToolPacks } from "./createPipeline";
import styles from "./TemplateGallery.module.css";

export interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
}

/** Icons of a template's steps, in order. */
export function stepIcons(template: PipelineTemplate, catalog: readonly StepType[]): string[] {
  return (template.pipeline.steps ?? []).map((s) => catalog.find((t) => t.id === s.type)?.icon ?? "box");
}

const FOCUSABLE = "button:not(:disabled)";

/** The "New pipeline" dialog: a blank pipeline and the built-in templates (SPEC.md §11.2). */
export function TemplateGallery({ open, onClose }: TemplateGalleryProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const templates = usePipelines((s) => s.templates);
  const catalog = usePipelines((s) => s.catalog);
  const packs = usePacks((s) => s.byId);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void usePipelines.getState().ensureCatalog().catch(() => undefined);
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => prev?.focus?.();
  }, [open]);

  if (!open) return null;

  const choose = async (templateId: string | null) => {
    if (busy) return;
    setBusy(templateId ?? "");
    const id = await createPipeline(templateId);
    setBusy(null);
    if (id) onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            New pipeline
          </h2>
          <Button variant="ghost" size="sm" data-tip="Close without creating a pipeline" data-tip-kbd="Esc" onClick={onClose}>
            Cancel
          </Button>
        </div>
        <div className={styles.grid}>
          <div className={cx(styles.card, styles.blank)}>
            <button type="button" className={styles.main} disabled={busy !== null} data-tip="Create an empty pipeline to build step by step" onClick={() => void choose(null)}>
              <span className={styles.cardHead}>
                <Icon name="plus" size={18} className={styles.icon} />
                <span className={styles.name}>Blank pipeline</span>
                {busy === "" && <Spinner size={14} label="Creating" />}
              </span>
              <span className={styles.blurb}>Start from a Downloader step and build your own.</span>
            </button>
          </div>
          {templates.map((t) => {
            const needs = (t.packs ?? []).map((id) => packs[id]);
            const names = (t.packs ?? []).map((id, i) => needs[i]?.name ?? id);
            const missing = needs.some((p) => p !== undefined && p.state !== PackState.PackInstalled);
            return (
              <div key={t.id} className={styles.card}>
                <button type="button" className={styles.main} disabled={busy !== null} onClick={() => void choose(t.id)} aria-label={t.pipeline.name} data-tip={missing ? `Create this pipeline; install the ${names.join(", ")} pack to run it` : "Create a pipeline from this template; you can change every step"}>
                  <span className={styles.cardHead}>
                    <Icon name={t.icon} size={18} className={styles.icon} />
                    <span className={styles.name}>{t.pipeline.name}</span>
                    {busy === t.id && <Spinner size={14} label="Creating" />}
                  </span>
                  <span className={styles.blurb}>{t.blurb}</span>
                  <span className={styles.steps} aria-hidden="true" data-tip="The tools this template uses, in order">
                    {stepIcons(t, catalog).map((icon, i) => (
                      <Icon key={i} name={icon} size={14} />
                    ))}
                  </span>
                </button>
                {names.length > 0 && (
                  <div className={styles.needs}>
                    <span className={cx(styles.chip, missing && styles.missing)} data-tip={missing ? "A tool pack this template uses is not installed yet" : "The tool packs this template uses are installed"}>Needs: {names.join(", ")} pack</span>
                    {missing && (
                      <Button size="sm" variant="ghost" data-tip="Open Settings to install the missing tool pack" onClick={openToolPacks}>
                        Install
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
