import { useEffect, useState, type ReactElement } from "react";
import { FocusService } from "@/lib/api";
import { tileLetter } from "./rules";
import type { AppIconProps } from "./types";
import styles from "./AppIcon.module.css";

// Icons are looked up once per path for the life of the window; "" means "none, show the tile".
const cache = new Map<string, Promise<string>>();

/** Pre-fills the cache with an icon that came with an app listing (no extra call). */
export function seedAppIcon(path: string, icon: string): void {
  if (icon && !cache.has(path)) cache.set(path, Promise.resolve(icon));
}

/** Test hook. */
export function clearAppIconCache(): void {
  cache.clear();
}

function lookup(path: string): Promise<string> {
  let p = cache.get(path);
  if (!p) {
    p = Promise.resolve(FocusService.AppIcon(path)).catch(() => "");
    cache.set(path, p);
  }
  return p;
}

/** A program's icon (PNG data URL from the engine), else a lettered tile. */
export function AppIcon({ path, label, size = 20 }: AppIconProps): ReactElement {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    setSrc("");
    if (path) void lookup(path).then((v) => live && setSrc(v));
    return () => {
      live = false;
    };
  }, [path]);

  const box = { width: size, height: size };
  if (src) return <img className={styles.img} style={box} src={src} alt="" aria-hidden="true" draggable={false} />;
  return (
    <span className={styles.tile} style={{ ...box, fontSize: Math.max(9, Math.round(size * 0.55)) }} aria-hidden="true" data-testid="app-icon-tile">
      {tileLetter(label)}
    </span>
  );
}
