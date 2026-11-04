/**
 * A launcher for one editor panel (Phase 10 SPEC §5.5): a click-in whose
 * drawer shows `getEditorPanel(id)` and whose Pop out opens the panel part
 * ("<moduleId>.panel", `?panel=<id>`, one window per panel).
 */
import { ClickIn, ErrorBoundary } from "@/components";
import { getEditorPanel, panelPartId } from "./panels";
import { useEditorProfile } from "./profileContext";

/** The drawer id of a panel: how code opens it with `useClickIn().open`. */
export const panelDrawerId = (panelId: string): string => `panel:${panelId}`;

const DRAWER_WIDTH: Record<string, number> = { media: 420, "clip-effects": 400, "clip-text-style": 400, captions: 420, markers: 380 };

export interface PanelClickInProps {
  panel: string;
  variant?: "row" | "icon";
  summary?: string;
  /** Show the summary on the launcher (else only in its tooltip). */
  showSummary?: boolean;
  badge?: number;
  className?: string;
}

export function PanelClickIn({ panel, variant = "row", summary, showSummary = true, badge, className }: PanelClickInProps) {
  const profile = useEditorProfile();
  const def = getEditorPanel(panel);
  if (!def) return null;
  const Body = def.component;
  return (
    <ClickIn
      id={panelDrawerId(panel)}
      icon={def.icon}
      title={def.title}
      summary={showSummary ? summary : undefined}
      tip={summary ? `${def.tip} (${summary})` : def.tip}
      part={panelPartId(profile.moduleId)}
      instance={panel}
      params={{ panel }}
      variant={variant}
      badge={badge}
      width={DRAWER_WIDTH[panel]}
      flush
      popOutSize={{ width: def.width ?? 380, height: def.height ?? 720 }}
      className={className}
    >
      <ErrorBoundary label={def.title} resetKey={panel} compact>
        <Body />
      </ErrorBoundary>
    </ClickIn>
  );
}
