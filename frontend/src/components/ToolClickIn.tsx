/**
 * A constituent tool inside its host (Phase 11, SPEC §4): a click-in whose
 * drawer renders another tool's own view, preloaded with `inputs`, and whose
 * Pop out opens that tool in its own window with the same handoff. Results
 * come back through `onUse` from either place ("Use as layer").
 *
 *   <ToolClickIn host="photo-composer" module="object-eraser" inputs={[layer.path]}
 *     useLabel="Use as this layer" onUse={(paths) => replaceLayer(paths[0])} />
 *
 * The host never imports the constituent: views come from lib/toolActions.
 */
import { Suspense, useEffect, useMemo, useRef } from "react";
import { newEmbedLink, onEmbedUse, EmbedContext, type EmbedContextValue } from "@/lib/embed";
import { getToolView } from "@/lib/toolActions";
import { popOutTool } from "@/lib/windows";
import { isReady, useModules } from "@/state/modules";
import type { Handoff } from "@/state/ui";
import { ClickIn, ClickInHost } from "./ClickIn";
import { ErrorBoundary } from "./ErrorBoundary";
import { Spinner } from "./Spinner";
import styles from "./ToolClickIn.module.css";

export interface ToolClickInProps {
  /** The host tool's module id (where results go back). */
  host: string;
  /** The constituent's module id. */
  module: string;
  /** Files handed to it (a new array content = a new handoff). */
  inputs?: string[];
  /** Extra handoff fields (`text`, `seed`, …). */
  extra?: Omit<Handoff, "moduleId" | "inputs" | "embed">;
  /** Returns result files; omit for a constituent whose results stay in the Library. */
  onUse?: (paths: string[]) => void;
  /** The Use button's label (default "Use in <host>"). */
  useLabel?: string;
  /** Launcher title and icon (default: the module's name and icon). */
  title?: string;
  icon?: string;
  summary?: string;
  tip?: string;
  variant?: "row" | "icon";
  /** Drawer width in px (default 520; tools with a canvas pass more). */
  width?: number;
  /** Drawer id (default `tool:<module>`). */
  id?: string;
  /** Extra reason it can't open (e.g. "Select a photo layer"). */
  disabledReason?: string;
  className?: string;
}

export const toolDrawerId = (module: string): string => `tool:${module}`;

export function ToolClickIn({
  host,
  module,
  inputs = [],
  extra,
  onUse,
  useLabel,
  title,
  icon,
  summary,
  tip,
  variant = "row",
  width = 520,
  id,
  disabledReason,
  className,
}: ToolClickInProps) {
  const mod = useModules((s) => s.byId[module]);
  const hostName = useModules((s) => s.byId[host]?.name ?? host);
  const name = mod?.name ?? module;
  const View = getToolView(module);
  const label = useLabel ?? `Use in ${hostName}`;

  // A new handoff object only when the inputs or extras change.
  const key = JSON.stringify([inputs, extra ?? null]);
  const handoff = useMemo<Handoff>(() => ({ moduleId: module, inputs: [...inputs], ...(extra ?? {}) }), [module, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const useRefCb = useRef(onUse);
  useRefCb.current = onUse;

  // Results from a popped-out window come back on this click-in's token.
  const link = useRef(newEmbedLink(host, hostName, onUse ? label : ""));
  useEffect(() => onEmbedUse(link.current.token, (paths) => useRefCb.current?.(paths)), []);

  const unavailable = toolUnavailableReason(module);

  const popOut = async () => {
    link.current = { ...link.current, hostName, useLabel: onUse ? label : "" };
    await popOutTool(module, { title: `${name} — Toolbox`, handoff: { ...handoff, embed: link.current } });
  };

  return (
    <ClickIn
      id={id ?? toolDrawerId(module)}
      icon={icon ?? mod?.icon ?? "box"}
      title={title ?? name}
      summary={summary}
      tip={tip ?? `Open ${name} here, with ${inputs.length === 1 ? "this file" : inputs.length > 1 ? "these files" : "nothing loaded yet"}`}
      variant={variant}
      width={width}
      flush
      onPopOut={unavailable ? undefined : popOut}
      disabledReason={disabledReason || unavailable || undefined}
      className={className}
    >
      {View ? <ToolEmbed host={host} module={module} handoff={handoff} useLabel={label} onUse={onUse ? (paths) => useRefCb.current?.(paths) : undefined} /> : null}
    </ClickIn>
  );
}

/** Why `module` can't be opened as a constituent right now ("" when it can). */
export function toolUnavailableReason(module: string): string {
  const mod = useModules.getState().byId[module];
  const name = mod?.name ?? module;
  if (!mod) return `${name} isn't available`;
  if (!isReady(mod)) return `${name} needs setup first: open it from the sidebar`;
  if (!getToolView(module)) return `${name} has no view yet`;
  return "";
}

function EmbedBody({ module, name, resetKey }: { module: string; name: string; resetKey: string }) {
  const View = getToolView(module);
  if (!View) return null;
  return (
    <ClickInHost mode="inline" className={styles.embed}>
      <ErrorBoundary label={name} resetKey={resetKey}>
        <Suspense fallback={<Spinner />}>
          <View moduleId={module} />
        </Suspense>
      </ErrorBoundary>
    </ClickInHost>
  );
}

export interface ToolEmbedProps {
  host: string;
  module: string;
  handoff: Handoff;
  useLabel: string;
  onUse?: (paths: string[]) => void;
  placement?: "drawer" | "window";
}

/**
 * A tool's own view inside an embed context with an inline click-in host: the
 * body of every constituent drawer (<ToolClickIn>, the shell's constituent
 * drawer). Remounts nothing when `handoff` stays the same object.
 */
export function ToolEmbed({ host, module, handoff, useLabel, onUse, placement = "drawer" }: ToolEmbedProps) {
  const hostName = useModules((s) => s.byId[host]?.name ?? host);
  const name = useModules((s) => s.byId[module]?.name ?? module);
  const cb = useRef(onUse);
  cb.current = onUse;
  const has = onUse !== undefined;
  const ctx = useMemo<EmbedContextValue>(
    () => ({ host, hostName, placement, handoff, useLabel, onUse: has ? (paths) => cb.current?.(paths) : undefined }),
    [host, hostName, placement, handoff, useLabel, has],
  );
  return (
    <EmbedContext.Provider value={ctx}>
      <EmbedBody module={module} name={name} resetKey={JSON.stringify(handoff.inputs)} />
    </EmbedContext.Provider>
  );
}
