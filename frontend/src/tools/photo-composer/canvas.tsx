/**
 * The canvas in its two forms: the interactive stage of the tool's window and
 * the read-only preview of a popped-out preview window (Phase 11, SPEC §5.1).
 * Both draw the store's document with this window's own bitmaps.
 */
import { useMemo } from "react";
import { findLayer } from "@/composer/model";
import { useComposerImages } from "./images";
import { Stage } from "./Stage";
import { useComposer, useDoc } from "./store";

const noop = (): void => undefined;

/** The editable stage (host window). */
export function ComposerStage() {
  const doc = useDoc();
  const images = useComposerImages((s) => s.images);
  const selectedId = useComposer((s) => s.selectedId);
  const multi = useComposer((s) => s.multi);
  const editingId = useComposer((s) => s.editingId);
  const adjustBg = useComposer((s) => s.adjustBg);
  const zoom = useComposer((s) => s.zoom);
  const pending = useComposer((s) => s.pending);
  const busyIds = useMemo(() => new Set(Object.keys(pending)), [pending]);
  if (!doc) return null;
  const st = useComposer.getState;
  const multiSelected = multi.length > 1;
  const hasBgPhoto = doc.background.kind === "image" && !!doc.background.image?.path;
  const selected = !multiSelected && selectedId ? findLayer(doc, selectedId) : undefined;
  return (
    <Stage
      doc={doc}
      images={images}
      selectedId={multiSelected ? null : selectedId}
      onSelect={(id) => st().select(id)}
      onSourceDrop={(paths, x, y) => void st().addPhotos(paths, { x, y })}
      onLive={(d) => st().setLive(d)}
      onCommit={(d, key) => st().commit(d, key)}
      editingId={editingId}
      onEditing={(id) => st().setEditing(id)}
      onTextChange={(id, text) => st().setText(id, text)}
      adjustBg={adjustBg && hasBgPhoto && !selected}
      busyIds={busyIds}
      zoom={zoom}
      onZoom={(z) => st().setZoom(z)}
    />
  );
}

/** The live render with the selection outline, read-only: the popped-out preview. */
export function ComposerPreview() {
  const doc = useDoc();
  const images = useComposerImages((s) => s.images);
  const selectedId = useComposer((s) => s.selectedId);
  const multi = useComposer((s) => s.multi);
  const pending = useComposer((s) => s.pending);
  const busyIds = useMemo(() => new Set(Object.keys(pending)), [pending]);
  if (!doc) return null;
  return (
    <Stage
      doc={doc}
      images={images}
      selectedId={multi.length > 1 ? null : selectedId}
      onSelect={noop}
      onLive={noop}
      onCommit={noop}
      editingId={null}
      onEditing={noop}
      onTextChange={noop}
      adjustBg={false}
      busyIds={busyIds}
      zoom={1}
      onZoom={noop}
      readOnly
    />
  );
}
