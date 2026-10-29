import { useMemo, useState } from "react";
import { Button, Select, TextField } from "@/components";
import { OutputBox, useDebounced } from "./shared";
import { formatInZone, localZone, parseTimeInput, relativeTime, toUnix, zoneList, type UnixUnit } from "./time.logic";
import styles from "../DevUtils.module.css";

type UnitChoice = UnixUnit | "auto";

export default function TimeUtil() {
  const [text, setText] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [unit, setUnit] = useState<UnitChoice>("auto");
  const [zone, setZone] = useState(localZone);
  const [now, setNow] = useState(() => Date.now());
  const debounced = useDebounced(text);
  const zones = useMemo(() => zoneList(), []);
  const zoneOptions = useMemo(() => zones.map((z) => ({ value: z, label: z })), [zones]);

  const parsed = useMemo(() => parseTimeInput(debounced, unit), [debounced, unit]);

  return (
    <div className={styles.util}>
      <div className={styles.row}>
        <TextField
          mono
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Timestamp or date"
          placeholder="1700000000 or 2023-11-14T22:13:20Z"
          wrapperClassName={styles.col}
          spellCheck={false}
        />
        <Select
          aria-label="Unit"
          value={unit}
          onChange={setUnit}
          options={[
            { value: "auto", label: "Auto-detect unit" },
            { value: "s", label: "Seconds" },
            { value: "ms", label: "Milliseconds" },
            { value: "us", label: "Microseconds" },
          ]}
        />
        <Button
          variant="secondary"
          icon="clock"
          onClick={() => {
            setNow(Date.now());
            setText(String(Date.now()));
            setUnit("ms");
          }}
        >
          Now
        </Button>
      </div>
      {!parsed.ok && <p className={styles.error}>{parsed.message}</p>}
      {parsed.ok && (
        <>
          <p className={styles.note}>Read as {parsed.unit === "iso" ? "an ISO 8601 date" : { s: "seconds", ms: "milliseconds", us: "microseconds" }[parsed.unit]}.</p>
          <div className={styles.cols}>
            <OutputBox label="Unix seconds" value={toUnix(parsed.date).s} />
            <OutputBox label="Unix milliseconds" value={toUnix(parsed.date).ms} />
            <OutputBox label="Unix microseconds" value={toUnix(parsed.date).us} />
            <OutputBox label="ISO 8601 (UTC)" value={parsed.date.toISOString()} />
            <OutputBox label={`Local (${localZone()})`} value={formatInZone(parsed.date, localZone())} />
            <OutputBox label="Relative" value={relativeTime(parsed.date, now)} />
          </div>
          <div className={styles.col}>
            <span className={styles.label}>Time zone</span>
            <Select aria-label="Time zone" value={zone} onChange={setZone} options={zoneOptions} />
          </div>
          <OutputBox label={`In ${zone}`} value={formatInZone(parsed.date, zone)} />
        </>
      )}
    </div>
  );
}
