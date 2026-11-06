import { openToolItems } from "@/lib/openTool";

/** The tools the Visualizer is built from: the song can be opened in either, inline or in its own window. */
export function constituentItems(input: string) {
  return [...openToolItems("stems", [input], "viz"), ...openToolItems("bpm-key", [input], "viz")];
}
