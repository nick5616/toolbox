/**
 * The Photo Composer's panels (Phase 11, SPEC §5.1). Each takes no props and
 * reads `useComposer`, so it renders the same in a click-in drawer and popped
 * out into its own window (where its actions run on the host).
 */
import { useMemo } from "react";
import { Button, Select, SegmentedControl } from "@/components";
import { LAYOUTS } from "@/composer/layouts";
import { ASPECTS, layerList } from "@/composer/model";
import { BackgroundPanel } from "./BackgroundPanel";
import { Group, Row } from "./controls";
import { LayersPanel } from "./LayersPanel";
import { LayerSections, TextSections } from "./PropertiesPanel";
import { SourcesPanel } from "./SourcesPanel";
import { useComposer, useDoc, useSelectedLayers } from "./store";
import styles from "./panels.module.css";

function useBusyIds(): ReadonlySet<string> {
  const pending = useComposer((s) => s.pending);
  return useMemo(() => new Set(Object.keys(pending)), [pending]);
}

export function LayersPanelView() {
  const doc = useDoc();
  const selectedId = useComposer((s) => s.selectedId);
  const multi = useComposer((s) => s.multi);
  const busyLabels = useComposer((s) => s.busyLabels);
  const busyIds = useBusyIds();
  const layers = useMemo(() => (doc ? layerList(doc) : []), [doc]);
  const multiSet = useMemo(() => (multi.length > 1 ? new Set(multi) : undefined), [multi]);
  const st = useComposer.getState;
  return (
    <LayersPanel
      layers={layers}
      selectedId={selectedId}
      multi={multiSet}
      busyIds={busyIds}
      busyLabels={busyLabels}
      onSelect={(id, mods) => st().select(id, mods)}
      onPatch={(id, patch) => st().patchLayer(id, patch)}
      onDuplicate={(id) => st().duplicateLayer(id)}
      onDelete={(id) => st().deleteLayers([id])}
      onReorder={(id, index) => st().reorderLayer(id, index)}
    />
  );
}

export function LayerPanelView() {
  const doc = useDoc();
  const selected = useSelectedLayers();
  const busyIds = useBusyIds();
  const st = useComposer.getState;
  if (!doc || selected.length === 0) {
    return (
      <p className={styles.note} data-tip="Click a layer on the canvas or in Layers first">
        Select a layer to edit it.
      </p>
    );
  }
  const layer = selected[0];
  if (selected.length > 1 || !layer) {
    return <p className={styles.note}>{selected.length} layers selected. Use the bar under the canvas to cut them out or restore them.</p>;
  }
  return (
    <div className={styles.pad}>
      <LayerSections
        layer={layer}
        docWidth={doc.width}
        docHeight={doc.height}
        busy={busyIds.has(layer.id)}
        onPatch={(patch) => st().patchLayer(layer.id, patch)}
        onArrange={(dir) => st().arrangeLayer(layer.id, dir)}
        onRestoreOriginal={() => st().restoreOriginals([layer.id])}
      />
    </div>
  );
}

export function TextPanelView() {
  const selected = useSelectedLayers();
  const layer = selected.length === 1 ? selected[0] : undefined;
  if (!layer?.text) return <p className={styles.note}>Select a text layer to style it.</p>;
  return (
    <div className={styles.pad}>
      <TextSections layer={layer} onPatch={(patch) => useComposer.getState().patchLayer(layer.id, patch)} />
    </div>
  );
}

export function BackgroundPanelView() {
  const doc = useDoc();
  const adjust = useComposer((s) => s.adjustBg);
  if (!doc) return null;
  const st = useComposer.getState;
  return (
    <div className={styles.pad}>
      <BackgroundPanel
        background={doc.background}
        adjust={adjust}
        onAdjust={(on) => st().setAdjustBg(on)}
        onChange={(bg) => st().setBackground(bg)}
        onChoosePhoto={() => void st().chooseBackground()}
      />
    </div>
  );
}

export function LayoutsPanelView() {
  const doc = useDoc();
  const photos = doc ? layerList(doc).filter((l) => l.kind === "image").length : 0;
  const st = useComposer.getState;
  return (
    <div className={styles.pad} role="group" aria-label="Layouts">
      <Group title="Layouts" tip="Arrange all the photos automatically in a ready-made layout">
        {LAYOUTS.map((l) => (
          <Button
            key={l.id}
            size="sm"
            variant="secondary"
            className={styles.layout}
            data-tip={`Arrange the photos as ${l.label.toLowerCase()}: ${l.hint.toLowerCase()}`}
            onClick={() => st().applyLayoutKind(l.id)}
          >
            {`${l.label} - ${l.hint}`}
          </Button>
        ))}
        <Button size="sm" variant="ghost" icon="refresh-cw" data-tip="Re-roll the current layout for a different arrangement" onClick={() => st().shuffleLayout()}>
          Shuffle (same layout, new arrangement)
        </Button>
        <p className={styles.note}>{photos === 0 ? "Add some photos first." : `Applies to the ${photos} ${photos === 1 ? "photo" : "photos"} on the canvas.`}</p>
      </Group>
    </div>
  );
}

export function SourcesPanelView() {
  const postId = useComposer((s) => s.postSlide?.postId ?? "");
  if (!postId) return <p className={styles.note}>Photos of the post this composition belongs to show up here. Use + Add photo to bring in your own.</p>;
  return <SourcesPanel postId={postId} onAdd={(paths) => void useComposer.getState().addPhotos(paths)} />;
}

export function CanvasPanelView() {
  const doc = useDoc();
  if (!doc) return null;
  const st = useComposer.getState;
  return (
    <div className={styles.pad} role="group" aria-label="Canvas">
      <Group title="Canvas" tip="The shape and size of the finished picture">
        <Row label="Shape" tip="Canvas shape and size in pixels, for example 4:5 portrait or a 9:16 story">
          <Select
            size="sm"
            aria-label="Canvas shape"
            value={doc.aspect}
            options={ASPECTS.map((a) => ({ value: a.id, label: `${a.label} (${a.width}×${a.height})` }))}
            onChange={(aspect) => st().setCanvas({ aspect })}
          />
        </Row>
        <Row label="Size" tip="The exported picture's size in pixels">
          <span className={styles.value}>{`${doc.width} × ${doc.height} px`}</span>
        </Row>
        <Row label="File type" tip="JPG is smaller and best for photos and Instagram; PNG is lossless and keeps transparency">
          <SegmentedControl<"jpg" | "png">
            size="sm"
            aria-label="File type"
            value={doc.format === "png" ? "png" : "jpg"}
            options={[
              { value: "jpg", label: "JPG", tip: "Smaller file, best for photos and Instagram" },
              { value: "png", label: "PNG", tip: "Lossless file, keeps transparency; larger" },
            ]}
            onChange={(format) => st().setCanvas({ format })}
          />
        </Row>
      </Group>
    </div>
  );
}
