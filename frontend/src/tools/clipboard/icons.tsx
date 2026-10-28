// The shared Icon map has no pin/pause glyphs; these come straight from lucide.
import { Pause, Pin, PinOff } from "lucide-react";

interface GlyphProps {
  size?: number;
  className?: string;
}

export function PinGlyph({ size = 14, className }: GlyphProps) {
  return <Pin size={size} strokeWidth={1.75} className={className} aria-hidden="true" />;
}

export function PinOffGlyph({ size = 14, className }: GlyphProps) {
  return <PinOff size={size} strokeWidth={1.75} className={className} aria-hidden="true" />;
}

export function PauseGlyph({ size = 14, className }: GlyphProps) {
  return <Pause size={size} strokeWidth={1.75} className={className} aria-hidden="true" />;
}
