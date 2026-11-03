/** The Inspector section of a visual clip (Part B; FX5 replaces this placeholder). */
import { Section } from "@/components";
import type { EditClip } from "@/lib/api";
import { parseVisualClip } from "@/viz/edit/schema";
import { visualLabel } from "./visualInfo";

export function VisualSection({ clip }: { clip: EditClip }) {
  return (
    <Section label="Visual">
      <p>{visualLabel(parseVisualClip(clip.visual).value.layer)}</p>
    </Section>
  );
}
