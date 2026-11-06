// Pipeline variables (SPEC.md §4.3). Mirrors core.ExpandVars/TemplateVars;
// both are tested against core/testdata/vars.json.

const NAME = /^[a-z][a-z0-9_]{0,31}$/;

export interface TemplatePart {
  /** Literal text, or a variable name when `variable` is true. */
  text: string;
  variable: boolean;
}

/** Splits a template into literal text and {variable} references. */
export function parseTemplate(tpl: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const lit = (s: string) => {
    const last = parts[parts.length - 1];
    if (last && !last.variable) last.text += s;
    else parts.push({ text: s, variable: false });
  };
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === "{" && tpl[i + 1] === "{") {
      lit("{");
      i += 2;
    } else if (c === "}" && tpl[i + 1] === "}") {
      lit("}");
      i += 2;
    } else if (c === "{") {
      const end = tpl.indexOf("}", i + 1);
      const name = end >= 0 ? tpl.slice(i + 1, end) : "";
      if (end >= 0 && NAME.test(name)) {
        parts.push({ text: name, variable: true });
        i = end + 1;
      } else {
        lit("{");
        i++;
      }
    } else {
      let j = i + 1;
      while (j < tpl.length && tpl[j] !== "{" && tpl[j] !== "}") j++;
      lit(tpl.slice(i, j));
      i = j;
    }
  }
  return parts;
}

/** Variable names used in tpl, once each, in order of first use. */
export function templateVars(tpl: string): string[] {
  const out: string[] = [];
  for (const p of parseTemplate(tpl)) if (p.variable && !out.includes(p.text)) out.push(p.text);
  return out;
}

/** Expands tpl; later maps win; unknown names become "" and are listed in missing. */
export function expandVars(tpl: string, ...maps: Array<Record<string, string>>): { out: string; missing: string[] } {
  const missing: string[] = [];
  let out = "";
  for (const p of parseTemplate(tpl)) {
    if (!p.variable) {
      out += p.text;
      continue;
    }
    let found: string | undefined;
    for (let i = maps.length - 1; i >= 0 && found === undefined; i--) found = maps[i]?.[p.text];
    if (found !== undefined) out += found;
    else if (!missing.includes(p.text)) missing.push(p.text);
  }
  return { out, missing };
}

/** Escapes literal braces so text can be inserted into a template as-is. */
export function escapeTemplate(text: string): string {
  return text.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

/** The built-in variables every step can use (SPEC.md §4.3). */
export const BUILTIN_VARS: ReadonlyArray<{ name: string; label: string }> = [
  { name: "item", label: "Item name" },
  { name: "name", label: "File name" },
  { name: "ext", label: "Extension" },
  { name: "role", label: "Role (e.g. Bass)" },
  { name: "n", label: "Item number" },
  { name: "date", label: "Date" },
  { name: "time", label: "Time" },
  { name: "weekday", label: "Weekday" },
  { name: "pipeline", label: "Pipeline name" },
];
