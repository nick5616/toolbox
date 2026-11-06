import { useState } from "react";
import { PacksService } from "@/lib/api";
import { toast } from "@/components/toast";
import { toAppError } from "@/lib/errors";
import { useJobs } from "@/state/jobs";
import { usePacks } from "@/state/packs";
import { PackState } from "@/lib/api";
import { TextButton } from "../ui";
import styles from "./panels.module.css";

/**
 * One gate banner for the perception tools (SPEC §1.4.2): names what's
 * missing and carries the pack button. Renders nothing when every tool can run.
 */
export function GateBanner({ blocked }: { blocked: number }) {
  const packs = usePacks((s) => s.list);
  const [busy, setBusy] = useState(false);
  if (blocked === 0) return null;
  const pack = packs.find((p) => p.unlocks.some((u) => u.moduleId === "paint"));
  const canInstall = pack && pack.state !== PackState.PackInstalled && pack.state !== PackState.PackUnsupported;
  const install = async () => {
    if (!pack) return;
    setBusy(true);
    try {
      const res = await PacksService.Install([pack.id], "");
      for (const j of res.jobs ?? []) useJobs.getState().upsert(j);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.gate} role="status" data-testid="gate-banner">
      <span>
        {blocked === 1 ? "One Lab tool needs" : `${blocked} Lab tools need`} the AI engine or a model that isn't installed. Drawing and the algorithmic tools work without it.
      </span>
      {canInstall ? (
        <TextButton primary icon="import" disabled={busy || !!pack?.jobId} reason="An install is already running" tip={`Install the ${pack?.name} pack: the AI engine and the models these tools use`} onClick={() => void install()}>
          Install the {pack?.name} pack
        </TextButton>
      ) : null}
    </div>
  );
}
