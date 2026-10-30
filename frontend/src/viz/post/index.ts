/** Imports every post effect so it registers itself (PX1 adds its lines in the block). */
import "./registry";
// --- PX1 post effects ---
// --- end PX1 ---

export { postDef, postDefs, registerPost } from "./registry";
export type { PostContext, PostDef, PostInstance } from "./registry";
