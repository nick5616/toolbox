/**
 * Imports every layer type so it registers itself. One line per layer file;
 * builders add their lines in their own marked block to avoid conflicts.
 */
import "./gradient";
import "./bars";
// --- L1 backgrounds ---
import "./nebula";
import "./aurora";
import "./ink";
import "./synthgrid";
import "./tunnel";
import "./starfield";
import "./terrain";
import "./image";
import "./kaleido";
// --- end L1 ---
// --- L2 shapes + highway ---
import "./radial";
import "./ribbons";
import "./wavering";
import "./oscilloscope";
import "./lissajous";
import "./helix";
import "./vortex";
import "./geometry";
import "./pitchribbon";
import "./highway";
// --- end L2 ---
// --- L3 particles, accents, motifs ---
import "./embers";
import "./bursts";
import "./fireflies";
import "./ripples";
import "./shockwave";
import "./sweep";
import "./lightrays";
import "./frame";
import "./motif";
// --- end L3 ---

export { layerDef, layerDefs, registerLayer } from "./registry";
export type { FrameInput, LayerContext, LayerDef, LayerInstance, ParamSpec, ParamValues } from "./registry";
