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
