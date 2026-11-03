/** The Inspector section of a text clip (Part B; FX4 replaces this placeholder). */
import { Section } from "@/components";
import type { EditClip } from "@/lib/api";

export function TextSection({ clip }: { clip: EditClip }) {
  return (
    <Section label="Text">
      <p>{clip.text ? "Text clip" : "No text"}</p>
    </Section>
  );
}
