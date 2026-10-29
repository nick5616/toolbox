import type { CSSProperties } from "react";
import type { ContentRect } from "@/components/media";
import { SIZE_FRACTION } from "./options";

export interface CueOverlayProps {
  rect: ContentRect;
  /** The text to draw; "" draws nothing. */
  text: string;
  style: string;
  size: string;
  position: string;
  font?: string;
}

// These colours mimic what FFmpeg burns into the video (SPEC.md §5.4), so they
// are content, not UI chrome, and deliberately don't come from the theme tokens.
const WHITE = "#ffffff";
const BLACK = "#000000";
const YELLOW = "#ffe14d";

/** Font size (px) the burned text would have at this picture size. */
export function burnFontPx(width: number, height: number, size: string): number {
  const frac = SIZE_FRACTION[size] ?? SIZE_FRACTION.m ?? 0.055;
  const shorter = Math.min(width, height);
  return shorter * frac * (height > width ? 1.25 : 1);
}

export function overlayTextStyle(style: string, fontPx: number, font?: string): CSSProperties {
  const base: CSSProperties = {
    fontFamily: font ? `"${font}", system-ui, sans-serif` : "system-ui, sans-serif",
    fontSize: fontPx,
    lineHeight: 1.2,
    textAlign: "center",
    whiteSpace: "pre-wrap",
    color: WHITE,
  };
  switch (style) {
    case "boxed":
      return { ...base, background: "rgba(0,0,0,0.55)", padding: `${fontPx * 0.15}px ${fontPx * 0.4}px`, borderRadius: 2 };
    case "yellow":
      return { ...base, color: YELLOW, fontWeight: 700, WebkitTextStroke: `${fontPx * 0.06}px ${BLACK}`, paintOrder: "stroke fill" };
    case "minimal":
      return { ...base, textShadow: `0 ${fontPx * 0.05}px ${fontPx * 0.15}px rgba(0,0,0,0.8)` };
    default:
      return { ...base, WebkitTextStroke: `${fontPx * 0.06}px ${BLACK}`, paintOrder: "stroke fill" };
  }
}

/** The current cue drawn over the picture, approximating the chosen burn style. */
export function CueOverlay({ rect, text, style, size, position, font }: CueOverlayProps) {
  if (!text || rect.width <= 0 || rect.height <= 0) return null;
  const fontPx = burnFontPx(rect.width, rect.height, size);
  const margin = rect.height * 0.06;
  const place: CSSProperties = position === "top" ? { top: margin } : { bottom: margin };
  return (
    <div
      aria-hidden
      data-testid="cue-overlay"
      style={{
        position: "absolute",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ position: "absolute", maxWidth: "90%", ...place }}>
        <span style={{ ...overlayTextStyle(style, fontPx, font), display: "inline-block" }}>{text}</span>
      </div>
    </div>
  );
}
