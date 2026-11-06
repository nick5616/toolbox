// The layer model the engine keeps (the doc view in `engine.doc` is derived).

import type { Surface } from "./gl";
import type { LayerProps } from "./types";

export interface Layer {
  id: string;
  props: LayerProps;
  /** "tx_ty" → premultiplied tile surface. Absent = transparent. */
  tiles: Map<string, Surface>;
  /** Carried from the stored doc (Go bumps it); the engine never changes it. */
  rev: number;
}

export const MAX_LAYERS = 64;

export const DEFAULT_PROPS: LayerProps = {
  name: "Layer",
  hidden: false,
  locked: false,
  alphaLock: false,
  clip: false,
  reference: false,
  opacity: 1,
  blend: "normal",
};
