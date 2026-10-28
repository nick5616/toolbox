import { Fragment, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "./cx";
import { toast } from "./toast";
import styles from "./Markdown.module.css";

export interface MarkdownProps {
  /** Markdown source. Rendered as React elements only; HTML is shown as text. */
  text: string;
  className?: string;
}

async function copyText(text: string, title: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title, tone: "success", duration: 1800 });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

// ---- inline -----------------------------------------------------------------

const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/g;

function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} className={styles.inlineCode}>
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const url = m[3];
      out.push(
        <span key={k} className={styles.link}>
          {renderInline(m[2], k)}
          <button
            type="button"
            className={styles.linkCopy}
            title={url}
            aria-label={`Copy link ${url}`}
            onClick={() => void copyText(url, "Link copied")}
          >
            <Icon name="copy" size={11} />
          </button>
        </span>,
      );
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<strong key={k}>{renderInline((m[4] ?? m[5]) as string, k)}</strong>);
    } else {
      out.push(<em key={k}>{renderInline((m[6] ?? m[7]) as string, k)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderLines(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}-br${i}`} />);
    out.push(<Fragment key={`${key}-l${i}`}>{renderInline(line, `${key}-${i}`)}</Fragment>);
  });
  return out;
}

// ---- blocks -----------------------------------------------------------------

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)[^\n]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST.test(line) || HR.test(line);
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang || "text"}</span>
        <button type="button" className={styles.codeCopy} onClick={() => void copyText(code, "Code copied")}>
          <Icon name="copy" size={12} />
          Copy
        </button>
      </div>
      <pre className={styles.pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
  start: number;
}

function renderList(items: ListItem[], from: number, key: string): { node: ReactNode; next: number } {
  const first = items[from]!;
  const ordered = first.ordered;
  const lis: ReactNode[] = [];
  let i = from;
  while (i < items.length) {
    const it = items[i]!;
    if (it.indent !== first.indent || it.ordered !== ordered) break;
    i++;
    let nested: ReactNode = null;
    const nextItem = items[i];
    if (nextItem && nextItem.indent > first.indent) {
      const r = renderList(items, i, `${key}-${i}n`);
      nested = r.node;
      i = r.next;
    }
    lis.push(
      <li key={`${key}-${i}`}>
        {renderInline(it.text, `${key}-${i}`)}
        {nested}
      </li>,
    );
  }
  const node = ordered ? (
    <ol key={key} start={first.start !== 1 ? first.start : undefined}>
      {lis}
    </ol>
  ) : (
    <ul key={key}>{lis}</ul>
  );
  return { node, next: Math.max(i, from + 1) };
}

function parseBlocks(src: string, key: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const k = `${key}${n++}`;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closer = new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or end of input while streaming)
      out.push(<CodeBlock key={k} lang={fence[2] ?? ""} code={body.join("\n")} />);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const Tag = `h${h[1]!.length}` as "h1";
      out.push(
        <Tag key={k} className={styles.heading}>
          {renderInline(h[2] ?? "", k)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (HR.test(line) && !LIST.test(line)) {
      out.push(<hr key={k} className={styles.hr} />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1] ?? "");
        i++;
      }
      out.push(
        <blockquote key={k} className={styles.quote}>
          {parseBlocks(body.join("\n"), `${k}q`)}
        </blockquote>,
      );
      continue;
    }
    if (LIST.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const lm = LIST.exec(cur);
        if (lm) {
          const marker = lm[2]!;
          const ordered = /\d/.test(marker);
          items.push({
            indent: lm[1]!.replace(/\t/g, "  ").length,
            ordered,
            text: lm[3] ?? "",
            start: ordered ? parseInt(marker, 10) : 1,
          });
          i++;
        } else if (cur.trim() !== "" && /^\s+\S/.test(cur) && !startsBlock(cur) && items.length > 0) {
          items[items.length - 1]!.text += ` ${cur.trim()}`;
          i++;
        } else if (cur.trim() === "" && LIST.test(lines[i + 1] ?? "")) {
          i++; // loose list: a blank line between items
        } else {
          break;
        }
      }
      let at = 0;
      while (at < items.length) {
        const r = renderList(items, at, `${k}-${at}`);
        out.push(r.node);
        at = r.next;
      }
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (para.length === 0 || !startsBlock(lines[i]!))) {
      para.push(lines[i]!);
      i++;
    }
    out.push(<p key={k}>{renderLines(para, k)}</p>);
  }
  return out;
}

/**
 * Small in-house Markdown renderer for chat answers (SPEC §4.5). Produces React
 * elements only (never raw HTML): paragraphs, headings, lists, blockquotes,
 * bold/italic, inline code and fenced code blocks with a Copy button. Links are
 * shown as text with a copy action; nothing navigates.
 */
export function Markdown({ text, className }: MarkdownProps) {
  return <div className={cx(styles.md, className)}>{parseBlocks(text, "b")}</div>;
}
