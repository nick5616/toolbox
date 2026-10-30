/**
 * Imports every layer type so it registers itself. One line per layer file;
 * builders add their lines in their own marked block to avoid conflicts.
 */
import "./gradient";
import "./bars";
// --- L1 backgrounds ---
// --- end L1 ---
// --- L2 shapes + highway ---
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
