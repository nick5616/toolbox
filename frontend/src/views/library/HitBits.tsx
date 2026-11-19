import { Badge, Icon, cx } from "@/components";
import { extOf, type HitInfo, type LibItem } from "./items";
import { posBadge, sourceIcons, splitSnippet, strengthInfo } from "./searchHits";
import styles from "./Search.module.css";

/** The strength dot of a concept or text hit: colour by level, % in the tooltip. Label and name hits have none. */
export function StrengthDot({ hit }: { hit: HitInfo }) {
  const s = strengthInfo(hit);
  if (!s.level) return null;
  return <span className={cx(styles.dot, styles[`dot_${s.level}`])} role="img" aria-label={s.label} data-strength={s.level} data-tip={s.tip} />;
}

/** Picture text / document / speech: where the words were found. */
export function SourceIcons({ hit }: { hit: HitInfo }) {
  const list = sourceIcons(hit.via);
  if (list.length === 0) return null;
  return (
    <span className={styles.sources}>
      {list.map((s) => (
        <span key={s.via} className={styles.source} role="img" aria-label={s.tip} data-tip={s.tip}>
          <Icon name={s.icon} size={12} />
        </span>
      ))}
    </span>
  );
}

/** One line of the matched text with the matched words in bold. Rendered as React text, never as HTML. */
export function Snippet({ text }: { text: string }) {
  if (!text) return null;
  const parts = splitSnippet(text);
  return (
    <span className={styles.snippet} data-testid="snippet" data-tip={parts.map((p) => p.text).join("")}>
      {parts.map((p, i) => (p.bold ? <mark key={i} className={styles.mark}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

/** `0:42` for a moment, `p. 3` for a page. */
export function PosBadge({ item }: { item: LibItem }) {
  if (!item.hit) return null;
  const b = posBadge(item.kind, extOf(item.path), item.hit.pos);
  if (!b) return null;
  return (
    <span className={styles.pos} data-tip={b.tip}>
      {b.text}
    </span>
  );
}

export function ProjectBadge({ item }: { item: LibItem }) {
  if (!item.hit?.projectId) return null;
  return (
    <Badge tone="accent" tip="A project of yours; opening it opens its tool">
      Project
    </Badge>
  );
}

/** Everything a hit adds beside a card's name or in a row. */
export function HitMeta({ item }: { item: LibItem }) {
  if (!item.hit) return null;
  return (
    <>
      <StrengthDot hit={item.hit} />
      <SourceIcons hit={item.hit} />
      <PosBadge item={item} />
      <ProjectBadge item={item} />
    </>
  );
}
