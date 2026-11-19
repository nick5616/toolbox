import { useUI } from "@/state/ui";

/** Opens Settings and scrolls to the Search section once it has rendered. */
export function openSettingsSearch(): void {
  useUI.getState().navigate("settings");
  let tries = 0;
  const tick = () => {
    const el = document.getElementById("settings-search");
    if (el) el.scrollIntoView?.({ block: "start" });
    else if (++tries < 20) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}
