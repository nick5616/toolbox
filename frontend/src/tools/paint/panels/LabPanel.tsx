import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { PaintService, type PaintOrigin } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { LabToolInfo, PerceptionToolInfo } from "@/paint/lab/types";
import { useEditor } from "../context";
import { runtime, useAIStatus } from "../engine-adapter";
import { defaultParams, usePaintUI } from "../store";
import { loadVariant, saveVariant, useVariants } from "../variants";
import { Device, TextButton } from "../ui";
import { GateBanner } from "./GateBanner";
import styles from "./panels.module.css";

/** Lab tools with no stroke: they run (or open a dialog) instead of becoming the tool in hand. */
export const LAB_ACTIONS = new Set(["select-subject", "extend-canvas", "upscale-canvas"]);

export function opOf(t: LabToolInfo): string | null {
  return t.kind === "perception" ? (t as PerceptionToolInfo).op : null;
}

/** Why a Lab tool can't be used now ("" = it can). */
export function gateReason(t: LabToolInfo, reasonFor: (op: string) => string): string {
  const op = opOf(t);
  return op ? reasonFor(op) : "";
}

export function useOrigins(): PaintOrigin[] {
  const [origins, setOrigins] = useState<PaintOrigin[]>(() => runtime.fallbackOrigins());
  useEffect(() => {
    let off = false;
    PaintService.Origins().then(
      (o) => {
        if (!off && o && o.length) setOrigins(o);
      },
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, []);
  return origins;
}

function DeviceFor({ info, origins, reason }: { info: LabToolInfo; origins: PaintOrigin[]; reason: string }) {
  const { engine, queue, openDialog } = useEditor();
  const tool = usePaintUI((s) => s.tool);
  const labToolId = usePaintUI((s) => s.labToolId);
  const stored = usePaintUI((s) => s.labParams[info.id]);
  const seed = usePaintUI((s) => s.labSeeds[info.id]) ?? { seed: 1, locked: false };
  const { setLabParam, setLabParams, setLabTool, setLabSeed, rollSeed, toggleSeedLock } = usePaintUI.getState();
  const [enabled, setEnabled] = useState(true);
  const { variants, refresh } = useVariants(info.id);
  const params = stored ?? defaultParams(info);
  const action = LAB_ACTIONS.has(info.id);
  const run = () => {
    if (info.id === "extend-canvas") return openDialog("extend");
    if (info.id === "upscale-canvas") return openDialog("upscale");
    runtime.runLabAction(info.id, { engine, queue, params }).catch((e) => toast({ title: toAppError(e).message, tone: "danger" }));
  };
  return (
    <Device
      info={info}
      params={params}
      onParam={(id, v) => setLabParam(info.id, id, v)}
      onParams={(p) => setLabParams(info.id, p)}
      seed={seed}
      onToggleSeedLock={() => toggleSeedLock(info.id)}
      onReroll={() => rollSeed(info.id)}
      enabled={enabled}
      onToggleEnabled={() => setEnabled((e) => !e)}
      origins={origins}
      selected={tool === "lab" && labToolId === info.id}
      onSelect={() => {
        if (reason || !enabled) return;
        if (action) run();
        else setLabTool(info);
      }}
      {...(reason ? { disabledReason: reason } : {})}
      variants={variants}
      onSaveVariant={(name) => void saveVariant(info.id, name, params, seed.seed).then(refresh, (e) => toast({ title: toAppError(e).message, tone: "danger" }))}
      onLoadVariant={(id) =>
        void loadVariant(id).then((v) => {
          if (!v) return;
          setLabParams(info.id, v.params);
          setLabSeed(info.id, v.seed);
        })
      }
      extra={
        action ? (
          <TextButton tip={reason || `Run ${info.label}`} disabled={!!reason || !enabled} reason={reason} onClick={run}>
            Run
          </TextButton>
        ) : null
      }
    />
  );
}

/** The Lab panel: every tool as a device, grouped Algorithmic / Perception, with the gate banner. */
export function LabPanel() {
  const tools = useMemo(() => runtime.labTools(), []);
  const ai = useAIStatus();
  const origins = useOrigins();
  const algo = tools.filter((t) => t.kind === "algorithmic");
  const perc = tools.filter((t) => t.kind === "perception");
  const blocked = perc.filter((t) => gateReason(t, ai.reasonFor)).length;
  return (
    <div className={styles.stack} data-testid="lab-panel">
      <GateBanner blocked={blocked} />
      <h4 className={styles.h}>Algorithmic: no training data</h4>
      {algo.map((t) => (
        <DeviceFor key={t.id} info={t} origins={origins} reason="" />
      ))}
      <h4 className={styles.h}>Perception: models trained on photos</h4>
      {perc.map((t) => (
        <DeviceFor key={t.id} info={t} origins={origins} reason={gateReason(t, ai.reasonFor)} />
      ))}
    </div>
  );
}
