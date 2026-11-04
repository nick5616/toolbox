/**
 * The constituent drawer (Phase 11, SPEC §4.3): a tool's own view, embedded,
 * in a drawer over the shell's tool area. The CompositionBar's "Uses" chips
 * open it (`openConstituent(host, part)`); it's loaded with whatever files the
 * host reported through `useCompositionInputs`. Results stay in the Library:
 * there's no Use button here (a host that wants results back renders its own
 * <ToolClickIn onUse>).
 *
 * Render it once inside the <ClickInHost> that wraps the tool area (the Shell,
 * a tool window).
 */
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { ClickIn, ToolEmbed, toolUnavailableReason, useClickIn } from "@/components";
import { openTool } from "@/lib/openTool";
import { useCompositionInputsFor } from "@/state/composition";
import { useModules } from "@/state/modules";
import type { Handoff } from "@/state/ui";

export const CONSTITUENT_DRAWER_ID = "constituent";

interface Request {
  host: string;
  part: string;
  /** A new object per request, so asking for the same part again re-opens it. */
  nonce: number;
}

const useRequest = create<{ req: Request | null }>(() => ({ req: null }));
let nonce = 0;

/** True when `part` can open inside a drawer right now (it's ready and has a view). */
export function canOpenConstituent(part: string): boolean {
  return toolUnavailableReason(part) === "";
}

/** Asks the constituent drawer of the current window to open `part` for the tool `host`. */
export function openConstituent(host: string, part: string): void {
  useRequest.setState({ req: { host, part, nonce: ++nonce } });
}

function Body({ req }: { req: Request }) {
  const inputs = useCompositionInputsFor(req.host, req.part);
  const key = JSON.stringify(inputs);
  const handoff = useMemo<Handoff>(() => ({ moduleId: req.part, inputs: [...inputs] }), [req.part, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <ToolEmbed host={req.host} module={req.part} handoff={handoff} useLabel="" />;
}

export function ConstituentDrawer({ view }: { view: string }) {
  const req = useRequest((s) => s.req);
  const mod = useModules((s) => (req ? s.byId[req.part] : undefined));
  const { open, close, isOpen } = useClickIn();
  const inputs = useCompositionInputsFor(req?.host ?? "", req?.part ?? "");

  // Only requests made after this mounted open it (a stale one must not pop up when returning to a view).
  const seen = useRef(req);
  useEffect(() => {
    if (req === seen.current) return;
    seen.current = req;
    if (req && req.host === view) open(CONSTITUENT_DRAWER_ID);
  }, [req, view, open]);

  // Leaving the host closes it.
  useEffect(
    () => () => {
      useRequest.setState({ req: null });
    },
    [view],
  );
  const stillOpen = isOpen(CONSTITUENT_DRAWER_ID);
  useEffect(() => {
    if (stillOpen && req && req.host !== view) close();
  }, [stillOpen, req, view, close]);

  if (!req || req.host !== view || !mod) return null;
  return (
    <ClickIn
      headless
      flush
      id={CONSTITUENT_DRAWER_ID}
      icon={mod.icon}
      title={mod.name}
      width={520}
      onPopOut={() => openTool(req.part, inputs, {}, { window: true })}
    >
      <Body req={req} />
    </ClickIn>
  );
}
