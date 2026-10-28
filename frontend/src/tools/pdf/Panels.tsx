import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, IconButton, SegmentedControl, Stepper, Switch, TextField, cx } from "@/components";
import { PdfAction, type FileInfo, type PdfOptions } from "@/lib/api";
import { PageGrid } from "./PageGrid";
import { PasswordField } from "./PasswordField";
import {
  deleteTiles,
  initialTiles,
  keepOnly,
  reverseTiles,
  rotateTiles,
  summarize,
  toEdits,
  type Tile,
} from "./organize";
import { buildOptions, type PdfUiState } from "./options";
import { countPages, parseRanges } from "./ranges";
import { RunBar } from "./RunBar";
import type { Infos } from "./usePdfInfos";
import styles from "./Panels.module.css";

export interface RunRequest {
  paths: string[];
  options: PdfOptions;
  newPassword?: string;
}

export interface PanelProps {
  files: FileInfo[];
  infos: Infos;
  password: string;
  /** Non-empty = a password problem blocks running (shown as the reason). */
  blocker: string;
  ui: PdfUiState;
  setUi: (f: (p: PdfUiState) => PdfUiState) => void;
  run: (req: RunRequest) => void;
  running: boolean;
}

const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pagesOf = (infos: Infos, path: string) => infos[path]?.info?.pages ?? 0;
const paths = (files: FileInfo[]) => files.map((f) => f.path);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      {children}
    </div>
  );
}

function reasonFor(p: PanelProps, min = 1): string {
  if (p.files.length < min) return min > 1 ? `Add at least ${min} files` : "Add a file to continue";
  return p.blocker;
}

export function MergePanel(p: PanelProps) {
  const total = p.files.reduce((n, f) => n + pagesOf(p.infos, f.path), 0);
  return (
    <div className={styles.panel}>
      {total > 0 && <p className={styles.note}>{noun(total, "page", "pages")} in total</p>}
      <RunBar
        label={p.files.length >= 2 ? `Merge ${p.files.length} PDFs` : "Merge PDFs"}
        reason={reasonFor(p, 2)}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(p.ui, PdfAction.ActionMerge) })}
      />
    </div>
  );
}

export function SplitPanel(p: PanelProps) {
  const { ui } = p;
  const known = p.files.map((f) => pagesOf(p.infos, f.path)).filter((n) => n > 0);
  const minPages = known.length > 0 ? Math.min(...known) : undefined;
  const parsed = useMemo(() => parseRanges(ui.ranges, minPages), [ui.ranges, minPages]);
  let count = 0;
  if (ui.splitMode === "every") count = known.reduce((n, pg) => n + Math.ceil(pg / ui.every), 0);
  else if (!parsed.error) count = parsed.items.length * p.files.length;
  const inputError = ui.splitMode === "ranges" && ui.ranges.trim() !== "" ? parsed.error : "";
  const reason = reasonFor(p) || (ui.splitMode === "ranges" ? parsed.error : "");
  return (
    <div className={styles.panel}>
      <SegmentedControl
        aria-label="Split mode"
        value={ui.splitMode}
        onChange={(splitMode) => p.setUi((u) => ({ ...u, splitMode }))}
        options={[
          { value: "every", label: "Every N pages" },
          { value: "ranges", label: "Custom ranges" },
        ]}
      />
      {ui.splitMode === "every" ? (
        <Row label="Pages per file">
          <Stepper aria-label="Pages per file" min={1} value={ui.every} onChange={(every) => p.setUi((u) => ({ ...u, every }))} />
        </Row>
      ) : (
        <div className={styles.col}>
          <TextField
            aria-label="Page ranges"
            placeholder="1-3, 5, 8-"
            mono
            value={ui.ranges}
            invalid={!!inputError}
            onChange={(e) => p.setUi((u) => ({ ...u, ranges: e.target.value }))}
          />
          <ul className={styles.chips} aria-label="Parsed ranges">
            {parsed.items.map((it, i) => (
              <li key={`${it.text}-${i}`} className={cx(styles.chip, it.error && styles.chipBad)} title={it.error}>
                {it.label}
              </li>
            ))}
          </ul>
          {inputError && (
            <p className={styles.error} role="alert">
              {inputError}
            </p>
          )}
        </div>
      )}
      {count > 0 && <p className={styles.note}>Creates {noun(count, "file", "files")}</p>}
      <RunBar
        label={p.files.length > 1 ? `Split ${p.files.length} PDFs` : "Split PDF"}
        reason={reason}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(ui, PdfAction.ActionSplit) })}
      />
    </div>
  );
}

export function OrganizePanel(p: PanelProps) {
  const file = p.files[0];
  const pages = file ? pagesOf(p.infos, file.path) : 0;
  const path = file?.path ?? "";
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusPage, setFocusPage] = useState(1);

  useEffect(() => {
    setTiles(initialTiles(pages));
    setSelected(new Set());
    setFocusPage(1);
  }, [path, pages]);

  const none = selected.size === 0;
  const afterRemoval = (next: Tile[]) => {
    setTiles(next);
    setSelected(new Set());
    const f = next[0];
    if (f && !next.some((t) => t.page === focusPage)) setFocusPage(f.page);
  };
  const reason = p.files.length > 1 ? "Organize works on one PDF at a time — remove the others" : reasonFor(p) || (tiles.length === 0 ? "Keep at least one page" : "");
  const tb = (label: string, icon: string, onClick: () => void, disabled = false) => (
    <IconButton key={label} icon={icon} label={label} disabled={disabled} onClick={onClick} />
  );
  return (
    <div className={styles.panel}>
      <div className={styles.toolbar} role="toolbar" aria-label="Page tools">
        {tb("Rotate left", "rotate-ccw", () => setTiles(rotateTiles(tiles, selected, -90)), none)}
        {tb("Rotate right", "rotate-cw", () => setTiles(rotateTiles(tiles, selected, 90)), none)}
        {tb("Delete selected", "trash-2", () => afterRemoval(deleteTiles(tiles, selected)), none)}
        <Button size="sm" variant="secondary" disabled={none} onClick={() => afterRemoval(keepOnly(tiles, selected))}>
          Keep only selected
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setTiles(reverseTiles(tiles))}>
          Reverse
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setTiles(initialTiles(pages));
            setSelected(new Set());
          }}
        >
          Reset
        </Button>
        <span className={styles.summary} role="status">
          {summarize(tiles, pages)}
        </span>
      </div>
      {file && pages > 0 && p.files.length === 1 && (
        <PageGrid
          path={path}
          password={p.password}
          tiles={tiles}
          selected={selected}
          focusPage={focusPage}
          onTiles={setTiles}
          onSelected={setSelected}
          onFocus={setFocusPage}
        />
      )}
      <RunBar
        label="Save as new PDF"
        reason={reason}
        running={p.running}
        onRun={() =>
          p.run({ paths: [path], options: buildOptions(p.ui, PdfAction.ActionOrganize, { pages: toEdits(tiles) }) })
        }
      />
    </div>
  );
}

const LEVELS = [
  { id: "small", title: "Small", note: "Smallest file, 110 dpi images" },
  { id: "balanced", title: "Balanced", note: "Good for sharing, 150 dpi images" },
  { id: "high", title: "High quality", note: "Closest to the original, 220 dpi images" },
] as const;

export function CompressPanel(p: PanelProps) {
  return (
    <div className={styles.panel}>
      <div role="radiogroup" aria-label="Compression level" className={styles.cards}>
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={p.ui.level === l.id}
            className={cx(styles.card, p.ui.level === l.id && styles.cardOn)}
            onClick={() => p.setUi((u) => ({ ...u, level: l.id }))}
          >
            <span className={styles.cardTitle}>{l.title}</span>
            <span className={styles.note}>{l.note}</span>
          </button>
        ))}
      </div>
      <p className={styles.note}>Text and vector graphics are never degraded; only photos and scans shrink.</p>
      <RunBar
        label={p.files.length > 1 ? `Compress ${p.files.length} PDFs` : "Compress PDF"}
        reason={reasonFor(p)}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(p.ui, PdfAction.ActionCompress) })}
      />
    </div>
  );
}

export function ImagesToPdfPanel(p: PanelProps) {
  return (
    <div className={styles.panel}>
      <Row label="Page size">
        <SegmentedControl
          aria-label="Page size"
          value={p.ui.pageSize}
          onChange={(pageSize) => p.setUi((u) => ({ ...u, pageSize }))}
          options={[
            { value: "a4", label: "A4" },
            { value: "letter", label: "Letter" },
            { value: "fit", label: "Fit to image" },
          ]}
        />
      </Row>
      <Switch
        label="Margin"
        checked={p.ui.margin === "small"}
        onChange={(on) => p.setUi((u) => ({ ...u, margin: on ? "small" : "none" }))}
      />
      <RunBar
        label={p.files.length > 0 ? `Create PDF from ${noun(p.files.length, "image", "images")}` : "Create PDF"}
        reason={reasonFor(p)}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(p.ui, PdfAction.ActionImagesToPDF) })}
      />
    </div>
  );
}

export function PdfToImagesPanel(p: PanelProps) {
  const { ui } = p;
  const allPages = ui.pageRange.trim() === "";
  const known = p.files.map((f) => pagesOf(p.infos, f.path)).filter((n) => n > 0);
  const minPages = known.length > 0 ? Math.min(...known) : undefined;
  const parsed = useMemo(() => parseRanges(ui.pageRange, minPages), [ui.pageRange, minPages]);
  const rangeMode = !allPages;
  const [mode, setMode] = useState<"all" | "range">(rangeMode ? "range" : "all");
  const rangeError = mode === "range" ? parsed.error : "";
  let count = 0;
  for (const f of p.files) {
    const total = pagesOf(p.infos, f.path);
    if (total > 0) count += mode === "all" ? total : rangeError ? 0 : countPages(parsed.items, total);
  }
  return (
    <div className={styles.panel}>
      <Row label="Format">
        <SegmentedControl
          aria-label="Image format"
          value={ui.imageFormat}
          onChange={(imageFormat) => p.setUi((u) => ({ ...u, imageFormat }))}
          options={[
            { value: "png", label: "PNG" },
            { value: "jpg", label: "JPG" },
          ]}
        />
      </Row>
      <Row label="Resolution">
        <SegmentedControl
          aria-label="Resolution"
          value={String(ui.dpi) as "72" | "150" | "300"}
          onChange={(v) => p.setUi((u) => ({ ...u, dpi: Number(v) as 72 | 150 | 300 }))}
          options={[
            { value: "72", label: "72 · Screen" },
            { value: "150", label: "150 · Standard" },
            { value: "300", label: "300 · Print" },
          ]}
        />
      </Row>
      <Row label="Pages">
        <SegmentedControl
          aria-label="Pages"
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "all") p.setUi((u) => ({ ...u, pageRange: "" }));
          }}
          options={[
            { value: "all", label: "All" },
            { value: "range", label: "Range" },
          ]}
        />
        {mode === "range" && (
          <TextField
            aria-label="Page range"
            placeholder="1-3, 5, 8-"
            mono
            value={ui.pageRange}
            invalid={!!rangeError && ui.pageRange.trim() !== ""}
            onChange={(e) => p.setUi((u) => ({ ...u, pageRange: e.target.value }))}
          />
        )}
      </Row>
      {mode === "range" && ui.pageRange.trim() !== "" && rangeError && (
        <p className={styles.error} role="alert">
          {rangeError}
        </p>
      )}
      {count > 0 && <p className={styles.note}>Creates {noun(count, "image", "images")}</p>}
      <RunBar
        label={p.files.length > 1 ? `Render ${p.files.length} PDFs` : "Render pages"}
        reason={reasonFor(p) || rangeError}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(ui, PdfAction.ActionPDFToImages) })}
      />
    </div>
  );
}

export function ProtectPanel(p: PanelProps) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm !== "" && confirm !== pw;
  const reason = reasonFor(p) || (pw === "" ? "Enter a password" : confirm !== pw ? "The passwords must match" : "");
  return (
    <div className={styles.panel}>
      <PasswordField label="New password" value={pw} onChange={setPw} />
      <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} error={mismatch ? "Passwords don't match" : undefined} />
      <p className={styles.note}>Uses AES-256. There's no way to recover a forgotten password.</p>
      <RunBar
        label={p.files.length > 1 ? `Protect ${p.files.length} PDFs` : "Add password"}
        reason={reason}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(p.ui, PdfAction.ActionProtect), newPassword: pw })}
      />
    </div>
  );
}

export function UnlockPanel(p: PanelProps) {
  return (
    <div className={styles.panel}>
      <p className={styles.note}>You need the current password; this tool can't crack PDFs.</p>
      <RunBar
        label={p.files.length > 1 ? `Unlock ${p.files.length} PDFs` : "Remove password"}
        reason={reasonFor(p) || (p.password === "" ? "Enter the PDF's password" : "")}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(p.ui, PdfAction.ActionUnlock) })}
      />
    </div>
  );
}
