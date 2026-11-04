import { createContext, useContext } from "react";

/**
 * The module id of the file tool a kit surface is rendered in. `FileToolLayout`
 * provides it, so `FileActions` can leave the current tool out of its "Send to"
 * menu without every tool passing `moduleId` down (the prop still wins).
 */
export const KitToolContext = createContext<string>("");

export function useKitTool(): string {
  return useContext(KitToolContext);
}
