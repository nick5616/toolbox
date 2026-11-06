import { useMemo } from "react";
import { SegmentedControl, Stepper, TextField } from "@/components";
import { clampWidth, formatBigInt, groupBits, parseBigInt, twosComplement, type Base } from "./numbers.logic";
import { OutputBox, useDebounced } from "./shared";
import { useUtilState } from "../store";
import styles from "../DevUtils.module.css";

const BASES: { base: Base; label: string }[] = [
  { base: 10, label: "Decimal" },
  { base: 16, label: "Hex" },
  { base: 8, label: "Octal" },
  { base: 2, label: "Binary" },
];

export default function NumbersUtil() {
  const [text, setText] = useUtilState("numbers", "text", "255");
  const [base, setBase] = useUtilState<Base>("numbers", "base", 10);
  const [width, setWidth] = useUtilState("numbers", "width", 32);
  const debounced = useDebounced(text);

  const value = useMemo(() => (debounced.trim() === "" ? null : parseBigInt(debounced, base)), [debounced, base]);
  const tc = useMemo(() => (value === null ? null : twosComplement(value, width)), [value, width]);
  const invalid = debounced.trim() !== "" && value === null;

  return (
    <div className={styles.util}>
      <div className={styles.row}>
        <SegmentedControl
          aria-label="Input base"
          value={String(base) as "10" | "16" | "8" | "2"}
          onChange={(b) => setBase(Number(b) as Base)}
          options={BASES.map((b) => ({ value: String(b.base) as "10" | "16" | "8" | "2", label: b.label, tip: `Read the number you type as ${b.label.toLowerCase()} (base ${b.base})` }))}
        />
        <Stepper value={width} min={8} max={64} step={8} unit="bit" onChange={(w) => setWidth(clampWidth(w))} aria-label="Bit width" data-tip="How many bits wide the number is, for two's complement (negative numbers)" />
      </div>
      <div className={styles.col}>
        <TextField mono value={text} invalid={invalid} onChange={(e) => setText(e.target.value)} aria-label="Number" data-tip="An integer in the base chosen above; underscores and a minus sign are fine" spellCheck={false} />
        {invalid && <p className={styles.error}>Not a valid base-{base} integer.</p>}
      </div>
      {value !== null && (
        <>
          <div className={styles.cols}>
            {BASES.map((b) => (
              <OutputBox key={b.base} label={b.label} value={formatBigInt(value, b.base)} filename="number.txt" />
            ))}
          </div>
          {tc && (
            <>
              <p className={tc.fits ? styles.note : styles.error}>
                {tc.fits ? `Two's complement in ${width} bits` : `Doesn't fit in ${width} bits; showing the low ${width} bits`}
              </p>
              <OutputBox label={`Bits (${width})`} value={groupBits(tc.bits)} filename="bits.txt" />
              <div className={styles.cols}>
                <OutputBox label="Hex" value={tc.hex} filename="hex.txt" />
                <OutputBox label="As unsigned" value={tc.unsigned.toString()} filename="unsigned.txt" />
                <OutputBox label="As signed" value={tc.signed.toString()} filename="signed.txt" />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
