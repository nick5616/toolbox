import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { create } from "zustand";

export type UtilId = "json" | "base64" | "url" | "hash" | "uuid" | "jwt" | "time" | "numbers" | "color" | "regex" | "diff" | "text";

export interface UtilInfo {
  id: UtilId;
  name: string;
  icon: string;
  keywords: string[];
  Component: LazyExoticComponent<ComponentType>;
}

export const UTILS: readonly UtilInfo[] = [
  { id: "json", name: "JSON", icon: "file-json", keywords: ["yaml", "format", "minify", "validate"], Component: lazy(() => import("./utils/JsonUtil")) },
  { id: "base64", name: "Base64", icon: "arrow-left-right", keywords: ["encode", "decode", "data url"], Component: lazy(() => import("./utils/Base64Util")) },
  { id: "url", name: "URL", icon: "link", keywords: ["encode", "decode", "query", "parse"], Component: lazy(() => import("./utils/UrlUtil")) },
  { id: "hash", name: "Hash", icon: "hash", keywords: ["md5", "sha", "crc32", "checksum"], Component: lazy(() => import("./utils/HashUtil")) },
  { id: "uuid", name: "UUID", icon: "fingerprint", keywords: ["ulid", "guid", "id", "v4", "v7"], Component: lazy(() => import("./utils/UuidUtil")) },
  { id: "jwt", name: "JWT", icon: "key-round", keywords: ["token", "decode", "bearer"], Component: lazy(() => import("./utils/JwtUtil")) },
  { id: "time", name: "Time", icon: "clock", keywords: ["unix", "epoch", "timestamp", "date", "time zone"], Component: lazy(() => import("./utils/TimeUtil")) },
  { id: "numbers", name: "Numbers", icon: "binary", keywords: ["hex", "binary", "octal", "base", "twos complement"], Component: lazy(() => import("./utils/NumbersUtil")) },
  { id: "color", name: "Colour", icon: "palette", keywords: ["color", "hex", "rgb", "hsl", "oklch", "contrast", "wcag"], Component: lazy(() => import("./utils/ColorUtil")) },
  { id: "regex", name: "Regex", icon: "regex", keywords: ["regular expression", "match", "replace"], Component: lazy(() => import("./utils/RegexUtil")) },
  { id: "diff", name: "Diff", icon: "diff", keywords: ["compare", "text", "lines"], Component: lazy(() => import("./utils/DiffUtil")) },
  { id: "text", name: "Text", icon: "case-sensitive", keywords: ["case", "slug", "count", "sort", "dedupe"], Component: lazy(() => import("./utils/TextUtil")) },
];

export function isUtilId(v: unknown): v is UtilId {
  return typeof v === "string" && UTILS.some((u) => u.id === v);
}

interface DevUtilsNav {
  /** Set by the palette or a drop; null means "use the remembered one". */
  selected: UtilId | null;
  select: (id: UtilId) => void;
}

export const useDevUtilsNav = create<DevUtilsNav>((set) => ({
  selected: null,
  select: (id) => set({ selected: id }),
}));

/** Case-insensitive match on name and keywords. */
export function filterUtils(query: string): UtilInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...UTILS];
  return UTILS.filter((u) => u.name.toLowerCase().includes(q) || u.id.includes(q) || u.keywords.some((k) => k.includes(q)));
}
