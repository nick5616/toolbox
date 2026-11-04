import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ClickIn, IconButton, MenuButton, SegmentedControl, Stepper, Switch, TextField, cx } from "@/components";
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

function Row({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label} data-tip={tip}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** The per-action settings: one click-in row with a summary of the current choices. */
function Options({ summary, tip, width, children }: { summary: string; tip: string; width?: number; children: ReactNode }) {
  return (
    <ClickIn icon="sliders-horizontal" title="Options" summary={summary} tip={tip} width={width} className={styles.options}>
      <div className={styles.drawer}>{children}</div>
    </ClickIn>
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
      {total > 0 && (
        <p className={styles.note} data-tip="Pages in the merged PDF">
          {noun(total, "page", "pages")} in total
        </p>
      )}
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
  const summary = ui.splitMode === "every" ? `Every ${noun(ui.every, "page", "pages")}` : ui.ranges.trim() === "" ? "Custom ranges" : ui.ranges.trim();
  return (
    <div className={styles.panel}>
      <Options summary={summary} tip="Split every N pages or at custom page ranges">
      <SegmentedControl
        aria-label="Split mode"
        value={ui.splitMode}
        onChange={(splitMode) => p.setUi((u) => ({ ...u, splitMode }))}
        options={[
          { value: "every", label: "Every N pages", tip: "Cut into equal chunks of this many pages" },
          { value: "ranges", label: "Custom ranges", tip: "Choose exact page ranges; each range becomes its own PDF" },
        ]}
      />
      {ui.splitMode === "every" ? (
        <Row label="Pages per file" tip="How many pages each new PDF gets; the last one may be shorter">
          <Stepper aria-label="Pages per file" data-tip="How many pages each new PDF gets; the last one may be shorter" min={1} value={ui.every} onChange={(every) => p.setUi((u) => ({ ...u, every }))} />
        </Row>
      ) : (
        <div className={styles.col}>
          <TextField
            aria-label="Page ranges"
            data-tip="Comma-separated pages or ranges, e.g. 1-3, 5, 8- (8- means page 8 to the end)"
            placeholder="1-3, 5, 8-"
            mono
            value={ui.ranges}
            invalid={!!inputError}
            onChange={(e) => p.setUi((u) => ({ ...u, ranges: e.target.value }))}
          />
          <ul className={styles.chips} aria-label="Parsed ranges" data-tip="How your ranges were understood; each chip becomes one PDF">
            {parsed.items.map((it, i) => (
              <li key={`${it.text}-${i}`} className={cx(styles.chip, it.error && styles.chipBad)} data-tip={it.error || "This range becomes one PDF"}>
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
      </Options>
      {count > 0 && (
        <p className={styles.note} data-tip="How many PDFs this split will produce">
          Creates {noun(count, "file", "files")}
        </p>
      )}
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
  const tb = (label: string, icon: string, tip: string, onClick: () => void, disabled = false) => (
    <IconButton key={label} icon={icon} label={label} data-tip={disabled ? "Select one or more pages first" : tip} disabled={disabled} onClick={onClick} />
  );
  return (
    <div className={styles.panel}>
      <div className={styles.toolbar} role="toolbar" aria-label="Page tools" data-tip="Edit the pages, then save the result as a new PDF">
        {tb("Rotate left", "rotate-ccw", "Turn the selected pages a quarter turn anticlockwise", () => setTiles(rotateTiles(tiles, selected, -90)), none)}
        {tb("Rotate right", "rotate-cw", "Turn the selected pages a quarter turn clockwise", () => setTiles(rotateTiles(tiles, selected, 90)), none)}
        {tb("Delete selected", "trash-2", "Leave the selected pages out of the new PDF (Delete key)", () => afterRemoval(deleteTiles(tiles, selected)), none)}
        <MenuButton
          size="sm"
          variant="ghost"
          icon="ellipsis"
          label="More…"
          tip="More page tools: keep only the selected pages, reverse the order, reset"
          items={() => [
            { id: "keep", label: "Keep only selected", icon: "check-check", disabled: none, tip: none ? "Select one or more pages first" : "Delete every page except the selected ones", onSelect: () => afterRemoval(keepOnly(tiles, selected)) },
            { id: "reverse", label: "Reverse", icon: "arrow-down-up", tip: "Flip the order of all pages, last first", onSelect: () => setTiles(reverseTiles(tiles)) },
            {
              id: "reset",
              label: "Reset",
              icon: "undo-2",
              tip: "Undo every change: all pages back in original order and rotation",
              onSelect: () => {
                setTiles(initialTiles(pages));
                setSelected(new Set());
              },
            },
          ]}
        />
        <span className={styles.summary} role="status" data-tip="What the new PDF will contain compared with the original">
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
  const level = LEVELS.find((l) => l.id === p.ui.level) ?? LEVELS[1];
  return (
    <div className={styles.panel}>
      <Options summary={level.title} tip="How much to shrink photos and scans" width={400}>
      <div role="radiogroup" aria-label="Compression level" className={styles.cardsCol}>
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={p.ui.level === l.id}
            className={cx(styles.card, p.ui.level === l.id && styles.cardOn)}
            data-tip={`${l.title}: ${l.note}. Smaller files lose more photo detail`}
            onClick={() => p.setUi((u) => ({ ...u, level: l.id }))}
          >
            <span className={styles.cardTitle}>{l.title}</span>
            <span className={styles.note}>{l.note}</span>
          </button>
        ))}
      </div>
      </Options>
      <p className={styles.note} data-tip="Compression only re-encodes embedded pictures, so text stays sharp">
        Text and vector graphics are never degraded; only photos and scans shrink.
      </p>
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
  const sizeName = p.ui.pageSize === "a4" ? "A4" : p.ui.pageSize === "letter" ? "Letter" : "Fit to image";
  return (
    <div className={styles.panel}>
      <Options summary={`${sizeName} · ${p.ui.margin === "small" ? "margin" : "no margin"}`} tip="Page size and margin of the new PDF" width={420}>
      <Row label="Page size" tip="Size of each page in the new PDF">
        <SegmentedControl
          aria-label="Page size"
          value={p.ui.pageSize}
          onChange={(pageSize) => p.setUi((u) => ({ ...u, pageSize }))}
          options={[
            { value: "a4", label: "A4", tip: "Each image is centred on an A4 page (210 × 297 mm)" },
            { value: "letter", label: "Letter", tip: "Each image is centred on a US Letter page (8.5 × 11 in)" },
            { value: "fit", label: "Fit to image", tip: "Every page takes the exact size of its image, with no white space" },
          ]}
        />
      </Row>
      <Switch
        label="Margin"
        tip="Leave a small white border around each image instead of running to the page edge"
        checked={p.ui.margin === "small"}
        onChange={(on) => p.setUi((u) => ({ ...u, margin: on ? "small" : "none" }))}
      />
      </Options>
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
  const summary = `${ui.imageFormat.toUpperCase()} · ${ui.dpi} dpi · ${mode === "all" ? "all pages" : ui.pageRange.trim() === "" ? "page range" : `pages ${ui.pageRange.trim()}`}`;
  return (
    <div className={styles.panel}>
      <Options summary={summary} tip="Image format, resolution and which pages" width={440}>
      <Row label="Format" tip="File type of each page image">
        <SegmentedControl
          aria-label="Image format"
          value={ui.imageFormat}
          onChange={(imageFormat) => p.setUi((u) => ({ ...u, imageFormat }))}
          options={[
            { value: "png", label: "PNG", tip: "Lossless and sharp for text; larger files" },
            { value: "jpg", label: "JPG", tip: "Smaller files, best for pages with photos" },
          ]}
        />
      </Row>
      <Row label="Resolution" tip="Dots per inch used to draw each page; higher is sharper but makes bigger files">
        <SegmentedControl
          aria-label="Resolution"
          value={String(ui.dpi) as "72" | "150" | "300"}
          onChange={(v) => p.setUi((u) => ({ ...u, dpi: Number(v) as 72 | 150 | 300 }))}
          options={[
            { value: "72", label: "72 · Screen", tip: "72 dpi: small images for viewing on screen" },
            { value: "150", label: "150 · Standard", tip: "150 dpi: sharp on screen, good for most uses" },
            { value: "300", label: "300 · Print", tip: "300 dpi: print quality; large files" },
          ]}
        />
      </Row>
      <Row label="Pages" tip="Which pages to turn into images">
        <SegmentedControl
          aria-label="Pages"
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "all") p.setUi((u) => ({ ...u, pageRange: "" }));
          }}
          options={[
            { value: "all", label: "All", tip: "Render every page of each PDF" },
            { value: "range", label: "Range", tip: "Render only the pages you list" },
          ]}
        />
        {mode === "range" && (
          <TextField
            aria-label="Page range"
            data-tip="Comma-separated pages or ranges, e.g. 1-3, 5, 8- (8- means page 8 to the end)"
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
      </Options>
      {count > 0 && (
        <p className={styles.note} data-tip="How many image files will be written">
          Creates {noun(count, "image", "images")}
        </p>
      )}
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
      <PasswordField label="New password" value={pw} onChange={setPw} tip="The password people must enter to open the new PDF; it is not stored anywhere" />
      <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} tip="Type the same password again to avoid typos" error={mismatch ? "Passwords don't match" : undefined} />
      <p className={styles.note} data-tip="Strong encryption; a lost password means the PDF cannot be opened by anyone">Uses AES-256. There's no way to recover a forgotten password.</p>
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
      <p className={styles.note} data-tip="Type the password in the field above; a copy without any password is saved">You need the current password; this tool can't crack PDFs.</p>
      <RunBar
        label={p.files.length > 1 ? `Unlock ${p.files.length} PDFs` : "Remove password"}
        reason={reasonFor(p) || (p.password === "" ? "Enter the PDF's password" : "")}
        running={p.running}
        onRun={() => p.run({ paths: paths(p.files), options: buildOptions(p.ui, PdfAction.ActionUnlock) })}
      />
    </div>
  );
}
