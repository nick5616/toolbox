
import { Button, SegmentedControl, Stepper, Switch } from "@/components";
import { clampCount, generateIds, type IdKind } from "./uuid.logic";
import { OutputBox } from "./shared";
import { useUtilState } from "../store";
import styles from "../DevUtils.module.css";

export default function UuidUtil() {
  const [kind, setKind] = useUtilState<IdKind>("uuid", "kind", "v4");
  const [count, setCount] = useUtilState("uuid", "count", 5);
  const [upper, setUpper] = useUtilState("uuid", "upper", false);
  const [ids, setIds] = useUtilState<string[]>("uuid", "ids", () => generateIds("v4", 5, false));

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
            { value: "v4", label: "UUID v4", tip: "Fully random ID; the most common kind" },
            { value: "v7", label: "UUID v7", tip: "Random ID that starts with the time, so new ones sort after older ones" },
            { value: "ulid", label: "ULID", tip: "Shorter time-sortable ID made of letters and digits" },
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
          data-tip="How many IDs to make (1 to 1000)"
        />
        <Switch
          checked={upper}
          onChange={(u) => {
            setUpper(u);
            regenerate(kind, count, u);
          }}
          label="Upper case"
          tip="Show letters in the IDs as capitals"
        />
        <Button variant="primary" icon="rotate-cw" data-tip="Make a fresh set of IDs" onClick={() => regenerate()}>
          Generate
        </Button>
      </div>
      <OutputBox label={`${ids.length} ${ids.length === 1 ? "ID" : "IDs"} (Copy all)`} value={all} filename="uuids.txt" />
    </div>
  );
}
