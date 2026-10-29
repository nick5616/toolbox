import { useMemo, useState } from "react";
import { Badge, TextField } from "@/components";
import { contrastRatio, formatHex, formatHsl, formatOklch, formatRgb, parseColor, wcag, type Rgb } from "./color.logic";
import { OutputBox, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

function Swatch({ color }: { color: Rgb | null }) {
  return (
    <div className={styles.swatch} aria-hidden="true">
      {color && <div className={styles.swatchFill} style={{ background: `rgb(${color.r} ${color.g} ${color.b} / ${color.a})` }} />}
    </div>
  );
}

function Pass({ label, ok }: { label: string; ok: boolean }) {
  return (
    <Badge tone={ok ? "ok" : "danger"}>
      {label}: {ok ? "Pass" : "Fail"}
    </Badge>
  );
}

export default function ColorUtil() {
  const [text, setText] = useState("#3366cc");
  const [fg, setFg] = useState("#1a1a1a");
  const [bg, setBg] = useState("#ffffff");
  const dText = useDebounced(text);
  const dFg = useDebounced(fg);
  const dBg = useDebounced(bg);

  const color = useMemo(() => parseColor(dText), [dText]);
  const cFg = useMemo(() => parseColor(dFg), [dFg]);
  const cBg = useMemo(() => parseColor(dBg), [dBg]);
  const ratio = cFg && cBg ? contrastRatio(cFg, cBg) : null;
  const badges = ratio === null ? null : wcag(ratio);

  return (
    <div className={styles.util}>
      <div className={styles.row}>
        <Swatch color={color} />
        <div className={styles.col} style={{ flex: 1 }}>
          <TextField
            mono
            value={text}
            invalid={dText.trim() !== "" && !color}
            onChange={(e) => setText(e.target.value)}
            aria-label="Colour"
            placeholder="#3366cc, rgb(51 102 204), hsl(220 60% 50%), oklch(55% 0.17 260)"
            spellCheck={false}
          />
          {dText.trim() !== "" && !color && <p className={styles.error}>Not a recognised colour.</p>}
        </div>
      </div>
      {color && (
        <div className={styles.cols}>
          <OutputBox label="Hex" value={formatHex(color)} />
          <OutputBox label="RGB" value={formatRgb(color)} />
          <OutputBox label="HSL" value={formatHsl(color)} />
          <OutputBox label="OKLCH" value={formatOklch(color)} />
        </div>
      )}

      <div className={styles.col}>
        <span className={styles.label}>Contrast (WCAG)</span>
        <div className={styles.cols}>
          <div className={styles.row}>
            <Swatch color={cFg} />
            <TextField mono value={fg} invalid={dFg.trim() !== "" && !cFg} onChange={(e) => setFg(e.target.value)} aria-label="Text colour" spellCheck={false} />
          </div>
          <div className={styles.row}>
            <Swatch color={cBg} />
            <TextField mono value={bg} invalid={dBg.trim() !== "" && !cBg} onChange={(e) => setBg(e.target.value)} aria-label="Background colour" spellCheck={false} />
          </div>
        </div>
        {ratio !== null && badges && cFg && cBg && (
          <>
            <div className={styles.contrastSample} style={{ color: formatHex({ ...cFg, a: 1 }), background: formatHex({ ...cBg, a: 1 }) }}>
              The quick brown fox jumps over the lazy dog
            </div>
            <div className={styles.row}>
              <strong aria-label="Contrast ratio">{ratio.toFixed(2)}:1</strong>
              <Pass label="AA normal" ok={badges.aaNormal} />
              <Pass label="AA large" ok={badges.aaLarge} />
              <Pass label="AAA normal" ok={badges.aaaNormal} />
              <Pass label="AAA large" ok={badges.aaaLarge} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
