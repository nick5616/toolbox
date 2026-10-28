import { useState } from "react";
import { Banner, Button, ConfirmDialog, toast } from "@/components";
import { PacksService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { usePacks } from "@/state/packs";
import styles from "./ToolsFolderBanner.module.css";

/** Warning shown when the configured tools folder doesn't exist (for example an unplugged drive). */
export function ToolsFolderBanner() {
  const toolsDir = usePacks((s) => s.toolsDir);
  const [picked, setPicked] = useState("");

  if (!toolsDir || toolsDir.available) return null;

  const choose = async () => {
    try {
      const p = await PacksService.PickToolsDir();
      if (p) setPicked(p);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message, description: toAppError(e).hint });
    }
  };
  const confirm = async () => {
    const dir = picked;
    setPicked("");
    try {
      // With nothing installed in the new folder yet, Install([], dir) only writes the pointer.
      const res = await PacksService.Install([], dir);
      if (res.restart) await PacksService.Relaunch();
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message, description: toAppError(e).hint });
    }
  };

  return (
    <>
      <Banner
        tone="warn"
        className={styles.banner}
        action={
          <Button size="sm" variant="secondary" onClick={() => void choose()}>
            Choose folder…
          </Button>
        }
      >
        Your tools folder <code className={styles.path}>{toolsDir.path}</code> isn't available. Connect the drive or choose another folder.
      </Banner>
      <ConfirmDialog
        open={picked !== ""}
        title="Use this tools folder?"
        body={
          <>
            Toolbox will use <code className={styles.path}>{picked}</code> and restart.
          </>
        }
        confirmLabel="Use folder and restart"
        onConfirm={() => void confirm()}
        onCancel={() => setPicked("")}
      />
    </>
  );
}
