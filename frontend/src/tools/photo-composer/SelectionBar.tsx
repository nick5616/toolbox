/**
 * The selection bar (Phase 11, SPEC §5.1): one line under the canvas about what
 * is selected. A photo layer: name, opacity, delete, then Layer, Crop, Remove
 * background and the Erase object / Upscale tools opened inside the composer.
 * A text layer: Layer and Text style. Several layers: cut them out together.
 * Nothing wraps: what doesn't fit goes into a More menu (its click-ins stay
 * mounted so the menu can open their drawers).
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Button, IconButton, Slider, ToolClickIn, useClickIn } from "@/components";
import { toolDrawerId } from "@/components/ToolClickIn";
import { useElementSize } from "@/lib/useElementSize";
import { fitBar, OneLineBar, panelDrawerId, WorkspacePanel } from "@/workspace";
import { useComposer, useSelectedLayers, MODULE_ID } from "./store";
import { composerWorkspace as ws } from "./workspace";
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

/** An `OneLineBar` that also keeps the click-ins that don't fit mounted, so the More menu can open them. */
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

const pct = (v: number): string => `${Math.round(v * 100)}`;

export function SelectionBar() {
  const selected = useSelectedLayers();
  const pending = useComposer((s) => s.pending);
  const { open, close } = useClickIn();
  const st = useComposer.getState;

  const items = useMemo<BarItem[]>(() => {
    if (selected.length === 0) return [];
    const ids = selected.map((l) => l.id);
    const del: BarItem = {
      key: "delete",
      width: 34,
      node: <IconButton size="sm" icon="trash-2" label="Delete layer" data-tip="Remove the selected layer(s) (you can undo it)" onClick={() => st().deleteLayers(ids)} />,
      menu: { label: "Delete", icon: "trash-2", tip: "Remove the selected layer(s)", onSelect: () => st().deleteLayers(ids) },
    };
    const removable = selected.filter((l) => l.kind === "image" && !!l.image && !pending[l.id] && (selected.length === 1 || !l.image.ref.original));
    const anyBusy = selected.some((l) => !!pending[l.id]);
    const cut = (): void => void st().removeBackgrounds(removable.map((l) => l.id));

    if (selected.length > 1) {
      const restorable = selected.filter((l) => !!l.image?.ref.original);
      return [
        { key: "name", width: 100, node: <span className={styles.name}>{`${selected.length} layers`}</span> },
        {
          key: "cutout",
          width: 170,
          node: (
            <Button
              size="sm"
              variant="secondary"
              icon="wand-sparkles"
              data-tip={removable.length > 0 ? "Cut the subject out of every selected photo" : "None of the selected layers is a photo that can be cut out"}
              disabled={removable.length === 0}
              loading={anyBusy && removable.length === 0}
              onClick={cut}
            >
              {`Remove background (${removable.length})`}
            </Button>
          ),
          menu: { label: `Remove background (${removable.length})`, icon: "wand-sparkles", onSelect: cut },
        },
        {
          key: "restore",
          width: 130,
          node: (
            <Button
              size="sm"
              variant="secondary"
              icon="undo-2"
              data-tip={restorable.length === 0 ? "None of the selected photos has been cut out" : "Bring back the original photos, undoing the cut-outs"}
              disabled={restorable.length === 0}
              onClick={() => st().restoreOriginals(restorable.map((l) => l.id))}
            >
              Restore originals
            </Button>
          ),
          menu: { label: "Restore originals", icon: "undo-2", onSelect: () => st().restoreOriginals(restorable.map((l) => l.id)) },
        },
        del,
      ];
    }

    const layer = selected[0];
    if (!layer) return [];
    const common: BarItem[] = [
      { key: "name", width: 100, node: <span className={styles.name} title={layer.name}>{layer.name}</span> },
      {
        key: "opacity",
        width: 130,
        node: (
          <span className={styles.opacity}>
            <Slider
              aria-label="Opacity"
              data-tip="How solid the layer is; lower lets what is behind show through"
              min={0}
              max={1}
              step={0.01}
              value={layer.opacity}
              format={pct}
              onChange={(v) => st().patchLayer(layer.id, { opacity: v })}
            />
          </span>
        ),
      },
      del,
      {
        key: "layer",
        width: 84,
        keepMounted: true,
        node: <WorkspacePanel ws={ws} panel="layer" showSummary={false} className={styles.chip} />,
        menu: { label: "Layer", icon: "sliders-horizontal", tip: "Position, size, outline and shadow", onSelect: () => open(panelDrawerId("layer")) },
      },
    ];
    if (layer.kind === "text") {
      return [
        ...common,
        {
          key: "text",
          width: 112,
          keepMounted: true,
          node: <WorkspacePanel ws={ws} panel="text" showSummary={false} className={styles.chip} />,
          menu: { label: "Text style", icon: "case-sensitive", tip: "The words, font and colour", onSelect: () => open(panelDrawerId("text")) },
        },
      ];
    }
    const path = layer.image?.ref.path ?? "";
    const use = (paths: string[]): void => {
      const first = paths[0];
      if (!first) return;
      void st().replaceSource(layer.id, first);
      close();
    };
    return [
      ...common,
      {
        key: "crop",
        width: 82,
        node: (
          <Button size="sm" variant="secondary" icon="crop" className={styles.chip} data-tip="Choose a crop shape and which part of the photo to keep" onClick={() => st().setCropId(layer.id)}>
            Crop…
          </Button>
        ),
        menu: { label: "Crop…", icon: "crop", tip: "Choose which part of the photo to keep", onSelect: () => st().setCropId(layer.id) },
      },
      {
        key: "cutout",
        width: 150,
        node: (
          <Button
            size="sm"
            variant="secondary"
            icon="wand-sparkles"
            className={styles.chip}
            data-tip={removable.length > 0 ? "Cut the subject out of the selected photo with the AI engine, leaving a transparent background" : "This photo is being cut out"}
            disabled={removable.length === 0}
            loading={anyBusy && removable.length === 0}
            onClick={cut}
          >
            Remove background
          </Button>
        ),
        menu: { label: "Remove background", icon: "wand-sparkles", tip: "Cut the subject out of the photo", onSelect: cut },
      },
      {
        key: "erase",
        width: 128,
        keepMounted: true,
        node: (
          <ToolClickIn
            host={MODULE_ID}
            module="object-eraser"
            title="Erase object"
            icon="eraser"
            tip="Paint over something in this photo to remove it, then use the result as this layer"
            inputs={path ? [path] : []}
            useLabel="Use as this layer"
            width={760}
            onUse={use}
            className={styles.chip}
          />
        ),
        menu: { label: "Erase object", icon: "eraser", tip: "Remove something from this photo", onSelect: () => open(toolDrawerId("object-eraser")) },
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
            tip="Make this photo larger and sharper, then use the result as this layer"
            inputs={path ? [path] : []}
            useLabel="Use as this layer"
            width={760}
            onUse={use}
            className={styles.chip}
          />
        ),
        menu: { label: "Upscale", icon: "maximize-2", tip: "Enlarge this photo", onSelect: () => open(toolDrawerId("upscaler")) },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, pending, open, close]);

  if (items.length === 0) return null;
  return <FitBar items={items} label="Selection" />;
}
