// shotlist.json + shotlist.md: one entry per delivered file.
import fs from "node:fs";
import path from "node:path";

/**
 * results: [{scene: {number, id, title, tool, kind}, clips: [{file, duration, compressed}], stills: [rel], notes: [], vo: [], assets: []}]
 * Returns entries {n, file, tool, kind, duration, assets, shown, vo, compressed}.
 */
export function buildEntries(results) {
  const out = [];
  for (const r of results) {
    const base = {
      n: r.scene.number,
      scene: r.scene.id,
      tool: r.scene.tool ?? "",
      assets: [...(r.assets ?? [])],
      shown: (r.notes ?? []).join(" "),
      vo: (r.vo ?? []).join(" "),
    };
    for (const c of r.clips ?? []) out.push({ ...base, file: c.file, kind: r.scene.kind === "b" ? "b-roll" : "a-roll", duration: Math.round(c.duration * 10) / 10, compressed: c.compressed ?? "" });
    for (const s of r.stills ?? []) out.push({ ...base, file: s, kind: "still", duration: 0, compressed: "" });
  }
  return out.sort((a, b) => a.n - b.n || a.file.localeCompare(b.file));
}

/** Replaces the entries of the scenes that just ran, keeping everything else from an earlier shotlist. */
export function mergeEntries(old, fresh, ranScenes) {
  const ran = new Set(ranScenes);
  return [...old.filter((e) => !ran.has(e.scene)), ...fresh].sort((a, b) => a.n - b.n || a.file.localeCompare(b.file));
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderMarkdown(entries) {
  const lines = [
    "# Demo footage shot list",
    "",
    "| # | File | Tool | Duration | Assets | What's shown | Suggested VO line | Time compressed |",
    "|---|------|------|----------|--------|--------------|-------------------|-----------------|",
  ];
  for (const e of entries) {
    const dur = e.duration ? `${e.duration.toFixed(1)} s` : "";
    lines.push(`| ${String(e.n).padStart(2, "0")} | ${cell(e.file)} | ${cell(e.tool)} | ${dur} | ${cell(e.assets.join(", "))} | ${cell(e.shown)} | ${cell(e.vo)} | ${cell(e.compressed)} |`);
  }
  return lines.join("\n") + "\n";
}

export function writeShotlist(dir, entries, ranScenes = null) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonFile = path.join(dir, "shotlist.json");
  let all = entries;
  if (ranScenes) {
    try {
      all = mergeEntries(JSON.parse(fs.readFileSync(jsonFile, "utf8")), entries, ranScenes);
    } catch {
      /* first run */
    }
  }
  fs.writeFileSync(jsonFile, JSON.stringify(all, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "shotlist.md"), renderMarkdown(all));
  return all;
}
