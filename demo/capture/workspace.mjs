// Getting the demo media into the capture workspace's Library (copies only; demoAssets/ is never written).
import fs from "node:fs";
import path from "node:path";
import { isExcluded, listFiles } from "../roles.mjs";

function copyMissing(from, to) {
  let copied = 0;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let same = false;
  try {
    same = fs.statSync(to).size === fs.statSync(from).size;
  } catch {
    /* new file */
  }
  if (!same) {
    fs.copyFileSync(from, to);
    copied++;
  }
  return copied;
}

/**
 * Legacy mode (TOOLBOX_WORKSPACE not honoured yet): copies `assetsDir` into the
 * sandbox library, minus the privacy excludes. GPS is NOT stripped here, so
 * legacy captures must not show photo metadata.
 */
export function seedLibraryFromAssets(doc, assetsDir, libraryDir) {
  let n = 0;
  for (const rel of listFiles(assetsDir)) {
    if (isExcluded(doc, rel)) continue;
    n += copyMissing(path.join(assetsDir, ...rel.split("/")), path.join(libraryDir, ...rel.split("/")));
  }
  return n;
}

/** Copies the generated roles (make-assets output) into `<Library>/Extras/`. */
export function copyExtras(generatedDir, libraryDir) {
  let n = 0;
  for (const rel of listFiles(generatedDir)) n += copyMissing(path.join(generatedDir, ...rel.split("/")), path.join(libraryDir, "Extras", ...rel.split("/")));
  return n;
}

/**
 * Writes the capture workspace's `.toolbox/workspace.json` before its first launch, so the app's seed honours the
 * privacy excludes in roles.json (an env-created workspace starts with none) and strips photo locations.
 * An existing file only gets the excludes added; returns the files already seeded that the excludes cover
 * (they are deleted from the capture Library, never from demoAssets).
 */
export function ensureCaptureInfo(workspaceRoot, doc, baseline) {
  const norm = path.resolve(workspaceRoot).split(path.sep).join("/");
  if (!norm.includes("/.dev/workspaces/")) throw new Error(`ensureCaptureInfo: ${workspaceRoot} is not a capture workspace under .dev/workspaces`);
  const file = path.join(workspaceRoot, ".toolbox", "workspace.json");
  const exclude = [...(doc.exclude ?? [])];
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = Array.from({ length: 12 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const info = { id, name: "Demo", kind: "demo", root: workspaceRoot, baseline, present: true, keep: ["Demo Footage", "Extras"], exclude, stripLocation: true, created: Date.now() };
    fs.writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
    return [];
  }
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  const missing = exclude.filter((e) => !(info.exclude ?? []).includes(e));
  if (missing.length) {
    info.exclude = [...(info.exclude ?? []), ...missing];
    info.stripLocation = true;
    fs.writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
  }
  const lib = path.join(workspaceRoot, "Library");
  const removed = [];
  for (const rel of fs.existsSync(lib) ? listFiles(lib) : []) {
    if (isExcluded({ exclude }, rel)) {
      fs.rmSync(path.join(lib, rel), { force: true });
      removed.push(rel);
    }
  }
  return removed;
}
