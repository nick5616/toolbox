// Roles: names for the demo media (demo/roles.json), resolved to files in a workspace Library.
import fs from "node:fs";
import path from "node:path";

export function loadRoles(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!j || typeof j.roles !== "object") throw new Error(`${file}: no roles`);
  return j;
}

/** Case-insensitive `*` / `?` match of a whole relative path (forward slashes). */
export function globMatch(pattern, name) {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(name);
}

/** True when `rel` is excluded: a pattern matches the whole path or just its file name. */
export function isExcluded(doc, rel) {
  const base = rel.split("/").pop();
  return (doc.exclude ?? []).some((p) => globMatch(p, rel) || globMatch(p, base));
}

/**
 * The library-relative files a role stands for. `listing` is every relative
 * path available (forward slashes). Missing files are still returned for
 * `files` roles, so callers can report them; `glob` roles return what matches.
 */
export function expandRole(doc, name, listing, seen = new Set()) {
  const role = doc.roles[name];
  if (!role) throw new Error(`unknown role "${name}"`);
  if (seen.has(name)) throw new Error(`role "${name}" refers to itself`);
  const next = new Set(seen).add(name);
  if (role.of) return role.of.flatMap((n) => expandRole(doc, n, listing, next));
  if (role.files) return [...role.files];
  if (role.glob) {
    const hits = listing.filter((rel) => !isExcluded(doc, rel) && role.glob.some((g) => globMatch(g, rel)));
    return hits.sort((a, b) => a.localeCompare(b));
  }
  throw new Error(`role "${name}" has no files, glob or of`);
}

/** Absolute paths of a role inside `libraryDir`, in order. */
export function resolveRole(doc, name, libraryDir, listing) {
  return expandRole(doc, name, listing).map((rel) => path.join(libraryDir, ...rel.split("/")));
}

/** Which of a role's files are present: {name, files, missing, ok}. */
export function roleStatus(doc, name, listing) {
  const have = new Set(listing.map((r) => r.toLowerCase()));
  const files = expandRole(doc, name, listing);
  const missing = files.filter((f) => !have.has(f.toLowerCase()));
  return { name, files, missing, ok: files.length > 0 && missing.length === 0 };
}

/** Every file under `dir` as forward-slash relative paths ([] when it doesn't exist). Skips hidden entries and links. */
export function listFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * What exists before (or without) a workspace: demoAssets/ minus the excluded
 * files, plus the generated folder presented as Extras/.
 */
export function sourceListing(doc, { assetsDir, generatedDir }) {
  const src = listFiles(assetsDir).filter((r) => !isExcluded(doc, r));
  const gen = listFiles(generatedDir).map((r) => `Extras/${r}`);
  return [...src, ...gen];
}
