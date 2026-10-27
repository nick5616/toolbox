// Minimal ambient typing so tests can read files with node:fs without adding @types/node.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
