/** The Visualizer's part: its live preview, popped out into its own window. */
import { lazy } from "react";
import { definePart } from "@/parts/registry";
import { startVisualizerReplica } from "./bridge";

export const PREVIEW_PART = "visualizer.preview";

definePart({
  id: PREVIEW_PART,
  host: "visualizer",
  title: "Preview",
  icon: "monitor",
  tip: "The live preview of the design, with its own player",
  width: 960,
  height: 640,
  component: lazy(() => import("./PreviewPart")),
  connect: () => Promise.resolve(startVisualizerReplica()),
});
