import { parse as parseYamlText, stringify as stringifyYamlValue } from "yaml";

export type IndentChoice = "2" | "4" | "tab";

export interface JsonError {
  message: string;
  offset: number;
  line: number;
  col: number;
}

/** 1-based line and column of a string offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const upTo = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = upTo.split("\n");
  return { line: lines.length, col: (lines[lines.length - 1] ?? "").length + 1 };
}

interface ScanFailure {
  message: string;
  offset: number;
}

class Scanner {
  i = 0;
  constructor(readonly s: string) {}
  fail(message: string, at = this.i): never {
    const f: ScanFailure = { message, offset: at };
    throw f;
  }
  ws() {
    while (this.i < this.s.length && " \t\n\r".includes(this.s.charAt(this.i))) this.i++;
  }
  value(depth = 0) {
    if (depth > 512) this.fail("Nesting is too deep");
    this.ws();
    if (this.i >= this.s.length) this.fail("Unexpected end of input");
    const c = this.s.charAt(this.i);
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') return this.string();
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    for (const lit of ["true", "false", "null"]) {
      if (this.s.startsWith(lit, this.i)) {
        this.i += lit.length;
        return;
      }
    }
    this.fail(`Unexpected character ${JSON.stringify(c)}`);
  }
  object(depth: number) {
    this.i++;
    this.ws();
    if (this.s.charAt(this.i) === "}") {
      this.i++;
      return;
    }
    for (;;) {
      this.ws();
      if (this.s.charAt(this.i) !== '"') this.fail(this.i >= this.s.length ? "Unexpected end of input" : "Expected a property name in double quotes");
      this.string();
      this.ws();
      if (this.s.charAt(this.i) !== ":") this.fail(this.i >= this.s.length ? "Unexpected end of input" : "Expected ':' after the property name");
      this.i++;
      this.value(depth + 1);
      this.ws();
      const c = this.s.charAt(this.i);
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        return;
      }
      this.fail(this.i >= this.s.length ? "Unexpected end of input" : "Expected ',' or '}'");
    }
  }
  array(depth: number) {
    this.i++;
    this.ws();
    if (this.s.charAt(this.i) === "]") {
      this.i++;
      return;
    }
    for (;;) {
      this.value(depth + 1);
      this.ws();
      const c = this.s.charAt(this.i);
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return;
      }
      this.fail(this.i >= this.s.length ? "Unexpected end of input" : "Expected ',' or ']'");
    }
  }
  string() {
    const start = this.i;
    this.i++;
    while (this.i < this.s.length) {
      const c = this.s.charAt(this.i);
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === "\\") {
        const e = this.s.charAt(this.i + 1);
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.s.slice(this.i + 2, this.i + 6))) this.fail("Invalid \\u escape", this.i);
          this.i += 6;
          continue;
        }
        if (e === "" || !'"\\/bfnrt'.includes(e)) this.fail("Invalid escape sequence", this.i);
        this.i += 2;
        continue;
      }
      if (c < " ") this.fail("Control character in string (use \\n or \\t)");
      this.i++;
    }
    this.fail("Unterminated string", start);
  }
  number() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) this.fail("Invalid number");
    this.i += m[0].length;
  }
}

/** Returns where a document stops being valid JSON, or null when it is valid. */
export function findJsonError(text: string): JsonError | null {
  const sc = new Scanner(text);
  try {
    sc.value();
    sc.ws();
    if (sc.i < text.length) sc.fail("Unexpected content after the JSON value");
    return null;
  } catch (e) {
    if (typeof e === "object" && e !== null && "offset" in e && "message" in e) {
      const f = e as ScanFailure;
      return { message: f.message, offset: f.offset, ...lineCol(text, f.offset) };
    }
    throw e;
  }
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: JsonError };

export function parseJson(text: string): ParseResult {
  const err = findJsonError(text);
  if (err) return { ok: false, error: err };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: { message: "Invalid JSON", offset: 0, line: 1, col: 1 } };
  }
}

export function indentString(choice: IndentChoice): string | number {
  return choice === "tab" ? "\t" : Number(choice);
}

export function formatJson(value: unknown, indent: IndentChoice): string {
  return JSON.stringify(value, null, indentString(indent));
}

export function minifyJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Recursively sorts object keys (arrays keep their order). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** The offending line and a caret under the column. */
export function caretExcerpt(text: string, err: JsonError): string {
  const line = text.split("\n")[err.line - 1] ?? "";
  const long = line.length > 200;
  const start = long ? Math.max(0, err.col - 60) : 0;
  const shown = long ? line.slice(start, err.col + 60) : line;
  const col = err.col - start;
  return `${shown}\n${" ".repeat(Math.max(0, col - 1))}^`;
}

// --- YAML adapter (the only place the `yaml` package is used) ---

export function jsonToYaml(value: unknown): string {
  return stringifyYamlValue(value, { indent: 2 });
}

export type YamlResult = { ok: true; value: unknown } | { ok: false; message: string };

export function parseYaml(text: string): YamlResult {
  try {
    return { ok: true, value: parseYamlText(text) as unknown };
  } catch (e) {
    const msg = e instanceof Error ? (e.message.split("\n")[0] ?? "Invalid YAML") : "Invalid YAML";
    return { ok: false, message: msg };
  }
}
