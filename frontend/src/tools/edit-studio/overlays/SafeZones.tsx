/** Shaded edges Instagram's interface covers (§14.3): 9:16 and 4:5 only. */
import { safeZones } from "./overlayGeometry";
import styles from "./overlays.module.css";

export function SafeZones({ aspect, width, height, k }: { aspect: string; width: number; height: number; k: number }) {
  const zones = safeZones(aspect, width, height);
  if (!zones.length) return null;
  const font = 11 * k;
  return (
    <g data-testid="safe-zones" aria-label="Safe zones">
      {zones.map((z) => (
        <g key={z.id} data-zone={z.id} data-tip="Instagram covers this part with its own buttons and captions: keep faces and text out of it">
          <rect className={styles.zone} x={z.x} y={z.y} width={z.w} height={z.h} />
          {z.id === "left" || z.id === "right" ? (
            <text className={styles.zoneLabel} fontSize={font} transform={`translate(${z.x + z.w / 2 + font * 0.35} ${z.y + z.h / 2}) rotate(-90)`} textAnchor="middle">
              {z.label}
            </text>
          ) : (
            <text className={styles.zoneLabel} fontSize={font} x={z.x + 6 * k} y={z.y + font + 4 * k}>
              {z.label}
            </text>
          )}
        </g>
      ))}
    </g>
  );
}
