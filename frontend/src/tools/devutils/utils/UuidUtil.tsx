import { useState } from "react";
import { Button, SegmentedControl, Stepper, Switch } from "@/components";
import { clampCount, generateIds, type IdKind } from "./uuid.logic";
import { OutputBox } from "./shared";
import styles from "../DevUtils.module.css";

export default function UuidUtil() {
  const [kind, setKind] = useState<IdKind>("v4");
  const [count, setCount] = useState(5);
  const [upper, setUpper] = useState(false);
  const [ids, setIds] = useState<string[]>(() => generateIds("v4", 5, false));

  const regenerate = (k = kind, n = count, u = upper) => setIds(generateIds(k, n, u));
  const all = ids.join("\n");

  return (
    <div className={styles.util}>
      <div className={styles.row}>
        <SegmentedControl
          aria-label="ID type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            regenerate(k);
          }}
          options={[
            { value: "v4", label: "UUID v4" },
            { value: "v7", label: "UUID v7" },
            { value: "ulid", label: "ULID" },
          ]}
        />
        <Stepper
          value={count}
          min={1}
          max={1000}
          onChange={(n) => {
            const c = clampCount(n);
            setCount(c);
            regenerate(kind, c);
          }}
          aria-label="Count"
        />
        <Switch
          checked={upper}
          onChange={(u) => {
            setUpper(u);
            regenerate(kind, count, u);
          }}
          label="Upper case"
        />
        <Button variant="primary" icon="rotate-cw" onClick={() => regenerate()}>
          Generate
        </Button>
      </div>
      <OutputBox label={`${ids.length} ${ids.length === 1 ? "ID" : "IDs"} (Copy all)`} value={all} />
    </div>
  );
}
