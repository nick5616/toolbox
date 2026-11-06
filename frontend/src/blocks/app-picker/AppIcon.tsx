// Wave 0 stub (SPEC.md §4.3, §5.1); WP-U1 implements it (FocusService.AppIcon,
// else a lettered tile). The export name and props (types.ts) are frozen.
import type { ReactElement } from "react";
import type { AppIconProps } from "./types";

export function AppIcon({ label, size = 20 }: AppIconProps): ReactElement {
  return <span style={{ display: "inline-block", width: size, height: size }} aria-label={label} />;
}
