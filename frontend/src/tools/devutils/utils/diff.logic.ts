export type DiffKind = "eq" | "del" | "add";

export interface DiffOp {
  kind: DiffKind;
  text: string;
  /** 1-based line numbers in the left/right text (when the line exists there). */
  a?: number;
  b?: number;
}

export interface DiffOptions {
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

export function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function keyOf(line: string, o: DiffOptions): string {
  let k = line;
  if (o.ignoreWhitespace) k = k.replace(/\s+/g, " ").trim();
  if (o.ignoreCase) k = k.toLowerCase();
  return k;
}

const MAX_EDIT_DISTANCE = 3000;

type Step = { kind: DiffKind; i: number; j: number };

/** Myers O(ND) shortest edit script over arrays of comparison keys. */
function myers(a: readonly string[], b: readonly string[]): Step[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d-1 .. d+1] as it was before round d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    // Too different to align cheaply: show everything as removed then added.
    const steps: Step[] = [];
    for (let i = 0; i < n; i++) steps.push({ kind: "del", i, j: 0 });
    for (let j = 0; j < m; j++) steps.push({ kind: "add", i: n, j });
    return steps;
  }
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const vv = trace[d]!;
    const at = (k: number) => vv[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      steps.push({ kind: "eq", i: x, j: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        steps.push({ kind: "add", i: x, j: y });
      } else {
        x--;
        steps.push({ kind: "del", i: x, j: y });
      }
    }
  }
  return steps.reverse();
}

export const MAX_DIFF_LINES = 20000;

export function diffLines(left: string, right: string, opts: DiffOptions): DiffOp[] {
  const A = splitLines(left);
  const B = splitLines(right);
  const ka = A.map((l) => keyOf(l, opts));
  const kb = B.map((l) => keyOf(l, opts));
  // Trim the common prefix and suffix so Myers only sees the changed middle.
  let pre = 0;
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++;
  let suf = 0;
  while (suf < ka.length - pre && suf < kb.length - pre && ka[ka.length - 1 - suf] === kb[kb.length - 1 - suf]) suf++;
  const out: DiffOp[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: "eq", text: B[i]!, a: i + 1, b: i + 1 });
  const midA = ka.slice(pre, ka.length - suf);
  const midB = kb.slice(pre, kb.length - suf);
  for (const s of myers(midA, midB)) {
    if (s.kind === "eq") out.push({ kind: "eq", text: B[pre + s.j]!, a: pre + s.i + 1, b: pre + s.j + 1 });
    else if (s.kind === "del") out.push({ kind: "del", text: A[pre + s.i]!, a: pre + s.i + 1 });
    else out.push({ kind: "add", text: B[pre + s.j]!, b: pre + s.j + 1 });
  }
  for (let t = 0; t < suf; t++) {
    const i = ka.length - suf + t;
    const j = kb.length - suf + t;
    out.push({ kind: "eq", text: B[j]!, a: i + 1, b: j + 1 });
  }
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(ops: readonly DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.kind === "add") added++;
    else if (o.kind === "del") removed++;
  }
  return { added, removed };
}

export interface SideRow {
  left?: DiffOp;
  right?: DiffOp;
}

/** Pairs each run of deletions with the following run of additions. */
export function sideBySide(ops: readonly DiffOp[]): SideRow[] {
  const rows: SideRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind === "eq") {
      rows.push({ left: op, right: op });
      i++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (i < ops.length && ops[i]!.kind === "del") dels.push(ops[i++]!);
    while (i < ops.length && ops[i]!.kind === "add") adds.push(ops[i++]!);
    for (let r = 0; r < Math.max(dels.length, adds.length); r++) {
      const row: SideRow = {};
      if (dels[r]) row.left = dels[r]!;
      if (adds[r]) row.right = adds[r]!;
      rows.push(row);
    }
  }
  return rows;
}

/** A unified-diff view with `context` lines around changes; gaps become "@@" separators. */
export function unifiedText(ops: readonly DiffOp[], context = 3): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.kind === "eq") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const lines: string[] = [];
  let gap = false;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap && lines.length > 0) lines.push("@@");
    gap = false;
    lines.push((o.kind === "add" ? "+" : o.kind === "del" ? "-" : " ") + o.text);
  });
  return lines.join("\n");
}
