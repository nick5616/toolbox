import { OutputKind, type LibraryEntry, type Output } from "@/lib/api";

/** One file or folder the Library shows, whether a tool registered it or not. */
export interface LibItem {
  /** Output id when registered, else `path:<path>`. */
  key: string;
  path: string;
  name: string;
  kind: string;
  sizeBytes: number;
  /** Unix ms: when it was made (outputs) or last changed (plain files). */
  at: number;
  moduleId: string;
  /** "" for files no job made. */
  outputId: string;
  registered: boolean;
  missing: boolean;
  isDir: boolean;
  /** Library-relative path (folders and plain entries). */
  rel: string;
}

export function fromOutput(o: Output): LibItem {
  return {
    key: o.id,
    path: o.path,
    name: o.name,
    kind: o.kind,
    sizeBytes: o.sizeBytes,
    at: o.createdAt,
    moduleId: o.moduleId,
    outputId: o.id,
    registered: true,
    missing: o.missing,
    isDir: false,
    rel: "",
  };
}

export function fromEntry(e: LibraryEntry): LibItem {
  if (e.output) return { ...fromOutput(e.output), isDir: e.isDir, rel: e.rel };
  return {
    key: `path:${e.path}`,
    path: e.path,
    name: e.name,
    kind: e.kind,
    sizeBytes: e.sizeBytes,
    at: e.modTime,
    moduleId: "",
    outputId: "",
    registered: false,
    missing: false,
    isDir: e.isDir,
    rel: e.rel,
  };
}

/** A bare path (a lineage input, a deep link) as an item. */
export function fromPath(path: string): LibItem {
  return { key: `path:${path}`, path, name: baseOf(path), kind: kindOfPath(path), sizeBytes: 0, at: 0, moduleId: "", outputId: "", registered: false, missing: false, isDir: false, rel: "" };
}

export const kindIcon: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
  [OutputKind.KindDocument]: "file-text",
  [OutputKind.KindOther]: "file",
};

export function itemIcon(i: Pick<LibItem, "isDir" | "kind">): string {
  return i.isDir ? "folder" : (kindIcon[i.kind] ?? "file");
}

export function extOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif"];
const VIDEO_EXT = ["mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "flac", "ogg", "aac", "opus", "wma", "aiff", "aif", "mid", "midi"];

/** The kind by extension (for inputs that have no output row). */
export function kindOfPath(path: string): string {
  const ext = extOf(path);
  if (IMAGE_EXT.includes(ext)) return OutputKind.KindImage;
  if (VIDEO_EXT.includes(ext)) return OutputKind.KindVideo;
  if (AUDIO_EXT.includes(ext)) return OutputKind.KindAudio;
  if (["pdf", "doc", "docx", "txt", "md", "epub", "odt"].includes(ext)) return OutputKind.KindDocument;
  return OutputKind.KindOther;
}

export const TEXT_EXTENSIONS = ["txt", "srt", "lrc", "csv", "json", "md", "vtt", "log", "ass", "tsv", "yaml", "yml", "xml"];

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none";

export function previewKind(i: Pick<LibItem, "path" | "kind" | "isDir">): PreviewKind {
  if (i.isDir) return "none";
  const ext = extOf(i.path);
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  if (i.kind === OutputKind.KindImage) return "image";
  if (i.kind === OutputKind.KindVideo) return "video";
  if (i.kind === OutputKind.KindAudio) return "audio";
  return "none";
}

/** Does `path` live inside the library folder `root`? Unknown root counts as yes (the server decides). */
export function isInside(root: string, path: string): boolean {
  if (!root) return true;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(root);
  const p = norm(path);
  return p === r || p.startsWith(`${r}/`);
}

export function dirOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0 ? "" : path.slice(0, slash);
}

export function baseOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0 ? path : path.slice(slash + 1);
}
