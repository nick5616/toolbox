// Fails if `any` appears as a type in frontend/src (tests excluded).
// Enforces the "no any at module boundaries" rule mechanically.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const patterns = [/:\s*any\b/, /\bas\s+any\b/, /<any>/, /\bany\[\]/, /<any,/, /,\s*any>/];
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test") continue;
      walk(p);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      readFileSync(p, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (patterns.some((re) => re.test(line))) hits.push(`${relative(root, p)}:${i + 1}: ${line.trim()}`);
        });
    }
  }
}

walk(root);
if (hits.length) {
  console.error("Found `any` in frontend/src:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("check:any OK");
