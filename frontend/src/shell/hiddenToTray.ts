import { toast } from "@/components";

const KEY = "toolbox.hiddenToTrayNotified";

/**
 * Tells the user (once per install) that closing the window kept Toolbox
 * running in the tray. The window is hidden when the event arrives, so the
 * toast waits until it is visible again.
 */
export function notifyHiddenToTray(): void {
  try {
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, "1");
  } catch {
    /* storage unavailable: show it anyway */
  }
  const show = () =>
    toast({
      title: "Toolbox is still running in the tray",
      description: "Quit from the tray icon's menu.",
      duration: 8000,
    });
  if (!document.hidden) {
    show();
    return;
  }
  const onVisible = () => {
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", onVisible);
    show();
  };
  document.addEventListener("visibilitychange", onVisible);
}
