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
import { EmbedContext, newEmbedLink, onEmbedUse, type EmbedContextValue } from "@/lib/embed";
import { getToolView } from "@/lib/toolActions";
import { popOutTool } from "@/lib/windows";
import { isReady, useModules } from "@/state/modules";
import type { Handoff } from "@/state/ui";
import { ClickIn } from "./ClickIn";
import { ErrorBoundary } from "./ErrorBoundary";
import { Spinner } from "./Spinner";

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
  const ctx = useMemo<EmbedContextValue>(
    () => ({ host, hostName, placement: "drawer", handoff, useLabel: label, onUse: onUse ? (paths) => useRefCb.current?.(paths) : undefined }),
    [host, hostName, handoff, label, onUse !== undefined], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Results from a popped-out window come back on this click-in's token.
  const link = useRef(newEmbedLink(host, hostName, onUse ? label : ""));
  useEffect(() => onEmbedUse(link.current.token, (paths) => useRefCb.current?.(paths)), []);

  const unavailable = !mod ? `${name} isn't available` : !isReady(mod) ? `${name} needs setup first: open it from the sidebar` : !View ? `${name} has no view yet` : "";

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
      {View ? (
        <EmbedContext.Provider value={ctx}>
          <ErrorBoundary label={name} resetKey={key}>
            <Suspense fallback={<Spinner />}>
              <View moduleId={module} />
            </Suspense>
          </ErrorBoundary>
        </EmbedContext.Provider>
      ) : null}
    </ClickIn>
  );
}
