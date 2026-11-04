/**
 * The slide selection bar (Phase 11, SPEC §5.2): one line under the stage about
 * the selected slide. "Slide n · kind", then Framing / Trim and Alt text (panels),
 * Edit (Photo Composer or the Sequence Editor, here or in its own window) and, for
 * photo slides, Remove background and Upscale opened inside the post. Nothing wraps:
 * what doesn't fit goes into a More menu (its click-ins stay mounted so the menu can
 * open their drawers).
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { MenuButton, ToolClickIn, useClickIn } from "@/components";
import { toolDrawerId } from "@/components/ToolClickIn";
import { useElementSize } from "@/lib/useElementSize";
import { fitBar, OneLineBar, panelDrawerId, WorkspacePanel } from "@/workspace";
import { altSummary, framingSummary, isPending } from "./logic";
import { MODULE_ID, usePostBuilder, useSelectedSlide } from "./postStore";
import { KIND_LABEL } from "./SlideStrip";
import { postWorkspace as ws } from "./workspace";
import styles from "./SelectionBar.module.css";

interface BarItem {
  key: string;
  /** Estimated width in px (decides what fits). */
  width: number;
  node: ReactNode;
  /** The More menu entry when it doesn't fit. */
  menu?: { label: string; icon?: string; tip?: string; onSelect: () => void };
  /** A click-in: kept mounted (hidden) while in the More menu. */
  keepMounted?: boolean;
}

/** A `OneLineBar` that also keeps the click-ins that don't fit mounted, so the More menu can open them. */
export function FitBar({ items, label }: { items: readonly BarItem[]; label: string }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(el);
  const widths = useMemo(() => Object.fromEntries(items.map((i) => [i.key, i.width])), [items]);
  const n = fitBar(
    items.map((i) => i.key),
    widths,
    width,
  );
  const hidden = items.slice(n).filter((i) => i.keepMounted);
  return (
    <div ref={setEl} className={styles.wrap}>
      <OneLineBar
        aria-label={label}
        widths={widths}
        overflow={(keys) =>
          keys.flatMap((k) => {
            const it = items.find((i) => i.key === k);
            return it?.menu ? [{ id: k, label: it.menu.label, icon: it.menu.icon, tip: it.menu.tip, onSelect: it.menu.onSelect }] : [];
          })
        }
      >
        {items.map((i) => (
          <Fragment key={i.key}>{i.node}</Fragment>
        ))}
      </OneLineBar>
      {hidden.length > 0 && <span hidden>{hidden.map((i) => <span key={i.key}>{i.node}</span>)}</span>}
    </div>
  );
}

export function SelectionBar() {
  const { slide, index } = useSelectedSlide();
  const { open, close } = useClickIn();
  const st = usePostBuilder.getState;

  const items = useMemo<BarItem[]>(() => {
    if (!slide) return [];
    const out: BarItem[] = [{ key: "name", width: 120, node: <span className={styles.name}>{`Slide ${index + 1} · ${KIND_LABEL[slide.kind] ?? slide.kind}`}</span> }];
    const pending = isPending(slide);
    if (slide.kind !== "video" && !pending) {
      out.push({
        key: "framing",
        width: 100,
        keepMounted: true,
        node: <WorkspacePanel ws={ws} panel="framing" summary={framingSummary(slide)} showSummary={false} className={styles.chip} />,
        menu: { label: "Framing", icon: "crop", tip: "Zoom, rotate and reposition the picture", onSelect: () => open(panelDrawerId("framing")) },
      });
    }
    if (slide.kind === "clip") {
      out.push({
        key: "trim",
        width: 84,
        keepMounted: true,
        node: <WorkspacePanel ws={ws} panel="trim" showSummary={false} className={styles.chip} />,
        menu: { label: "Trim", icon: "scissors", tip: "Where the clip starts and ends", onSelect: () => open(panelDrawerId("trim")) },
      });
    }
    out.push({
      key: "alt",
      width: 108,
      keepMounted: true,
      node: <WorkspacePanel ws={ws} panel="alt" summary={altSummary(slide, index)} showSummary={false} className={styles.chip} />,
      menu: { label: "Alt text", icon: "text", tip: "Describe this slide for screen readers", onSelect: () => open(panelDrawerId("alt")) },
    });
    if ((slide.kind === "composition" || slide.kind === "video") && !pending) {
      const what = slide.kind === "composition" ? "composition" : "video";
      out.push({
        key: "edit",
        width: 84,
        node: (
          <MenuButton
            size="sm"
            variant="secondary"
            icon="pencil"
            label="Edit"
            tip={slide.kind === "composition" ? "Edit this composition in Photo Composer" : "Edit this video in the Sequence Editor"}
            items={() => [
              { id: "edit-here", label: "Edit here", icon: "pencil", tip: `Open the ${what}'s editor in this window`, onSelect: () => void st().editSlide(slide.id, "here") },
              { id: "edit-window", label: "Edit in its own window", icon: "app-window", tip: "Open the editor in a separate window; this post refreshes when you close it", onSelect: () => void st().editSlide(slide.id, "window") },
            ]}
          />
        ),
        menu: { label: "Edit in its own window", icon: "pencil", tip: `Edit this ${what}`, onSelect: () => void st().editSlide(slide.id, "window") },
      });
    }
    if (slide.kind === "photo") {
      const inputs = slide.path ? [slide.path] : [];
      const use = (paths: string[]): void => {
        const first = paths[0];
        if (!first) return;
        void st().usePhoto(slide.id, first);
        close();
      };
      out.push(
        {
          key: "bg",
          width: 178,
          keepMounted: true,
          node: (
            <ToolClickIn
              host={MODULE_ID}
              module="bg-remover"
              title="Remove background"
              icon="wand-sparkles"
              tip="Cut the subject out of this photo, then use the result for this slide"
              inputs={inputs}
              useLabel="Use for this slide"
              width={560}
              onUse={use}
              className={styles.chip}
            />
          ),
          menu: { label: "Remove background", icon: "wand-sparkles", tip: "Cut the subject out of this photo", onSelect: () => open(toolDrawerId("bg-remover")) },
        },
        {
          key: "upscale",
          width: 110,
          keepMounted: true,
          node: (
            <ToolClickIn
              host={MODULE_ID}
              module="upscaler"
              title="Upscale"
              icon="maximize-2"
              tip="Make this photo larger and sharper, then use the result for this slide"
              inputs={inputs}
              useLabel="Use for this slide"
              width={760}
              onUse={use}
              className={styles.chip}
            />
          ),
          menu: { label: "Upscale", icon: "maximize-2", tip: "Enlarge this photo", onSelect: () => open(toolDrawerId("upscaler")) },
        },
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide, index, open, close]);

  if (items.length === 0) return null;
  return <FitBar items={items} label="Selection" />;
}
