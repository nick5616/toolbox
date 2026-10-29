import type { Command } from "@/lib/commands";
import { useUI } from "@/state/ui";
import { UTILS, useDevUtilsNav } from "./registry";

/** Palette entries for Dev Utilities: one per utility. Merged by shell/useBuiltinCommands. */
export function devutilsCommands(): Command[] {
  return UTILS.map((u) => ({
    id: `dev-utils.${u.id}`,
    title: `Dev Utilities: ${u.name}`,
    section: "Tools",
    icon: u.icon,
    keywords: ["developer", ...u.keywords],
    run: () => {
      useDevUtilsNav.getState().select(u.id);
      useUI.getState().navigate("dev-utils");
    },
  }));
}
