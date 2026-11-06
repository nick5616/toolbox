/**
 * Post Builder's panels (Phase 11, SPEC §5.2). Each takes no props and reads
 * `usePostBuilder`, so it renders the same in a click-in drawer and popped out
 * into its own window (where its actions run on the host).
 */
import { useCallback } from "react";
import { PostsStrip } from "./PostsStrip";
import { AltPanel, CaptionPanel, ChecksPanel, ShapePanel } from "./SidePanel";
import { ClipControls, FramingPanel } from "./SlideStage";
import { SourcesPanel } from "./SourcesPanel";
import { usePostDialogs } from "./postDialogs";
import { diffDoc, useDoc, usePostBuilder, useSelectedSlide } from "./postStore";
import type { PostDoc } from "./logic";
import styles from "./panels.module.css";

export function PostsPanelView() {
  const posts = usePostBuilder((s) => s.posts);
  const postId = usePostBuilder((s) => s.postId);
  const dialogs = usePostDialogs();
  const st = usePostBuilder.getState;
  return (
    <>
      <PostsStrip
        column
        posts={posts}
        currentId={postId}
        onSelect={(id) => void st().openPost(id)}
        onNew={dialogs.openNew}
        onDuplicate={(id) => void st().duplicatePost(id)}
        onRename={dialogs.openRename}
        onDelete={dialogs.openDelete}
      />
      {dialogs.node}
    </>
  );
}

export function SourcesPanelView() {
  const doc = useDoc();
  const postId = usePostBuilder((s) => s.postId);
  const saved = usePostBuilder((s) => s.saveState === "saved");
  const { slide } = useSelectedSlide();
  const st = usePostBuilder.getState;
  // The Sources panel edits the pool with functions; the store takes the changed fields.
  const update = useCallback((fn: (d: PostDoc) => PostDoc) => {
    const d = usePostBuilder.getState().history?.present;
    if (!d) return;
    const patch = diffDoc(d, fn(d));
    if (Object.keys(patch).length > 0) usePostBuilder.getState().patchDoc(patch, "");
  }, []);
  if (!doc) return null;
  return (
    <SourcesPanel
      postId={postId}
      doc={doc}
      format={doc.format}
      saved={saved}
      selectedSlide={slide}
      update={update}
      onAddSlides={(paths) => void st().addPaths(paths)}
      onBuild={(inputs, build) => void st().buildSlide(inputs, build)}
    />
  );
}

export function FormatPanelView() {
  const doc = useDoc();
  if (!doc) return null;
  return (
    <div className={styles.pad}>
      <ShapePanel doc={doc} onChange={(patch) => usePostBuilder.getState().patchDoc(patch)} />
    </div>
  );
}

export function CaptionPanelView() {
  const doc = useDoc();
  const limits = usePostBuilder((s) => s.limits);
  if (!doc) return null;
  return (
    <div className={styles.pad}>
      <CaptionPanel caption={doc.caption} limits={limits} onChange={(caption) => usePostBuilder.getState().setCaption(caption)} />
    </div>
  );
}

export function FramingPanelView() {
  const { slide } = useSelectedSlide();
  if (!slide || slide.kind === "video") return <p className={styles.note}>Select a photo, clip or composition to frame it.</p>;
  return (
    <div className={styles.pad}>
      <FramingPanel slide={slide} onChange={(patch) => usePostBuilder.getState().patchSlide(slide.id, patch)} />
    </div>
  );
}

export function TrimPanelView() {
  const { slide } = useSelectedSlide();
  const doc = useDoc();
  const limits = usePostBuilder((s) => s.limits);
  if (!slide || slide.kind !== "clip") return <p className={styles.note}>Select a clip to choose where it starts and ends.</p>;
  return (
    <div className={styles.pad}>
      <ClipControls
        slide={slide}
        format={doc?.format ?? "carousel"}
        limits={limits}
        onChange={(patch) => usePostBuilder.getState().patchSlide(slide.id, patch)}
        onSeek={(ms) => usePostBuilder.getState().setStill({ id: slide.id, ms })}
      />
    </div>
  );
}

export function AltPanelView() {
  const { slide, index } = useSelectedSlide();
  const limits = usePostBuilder((s) => s.limits);
  return (
    <div className={styles.pad}>
      <AltPanel slide={slide} index={index} limits={limits} onChange={(text) => slide && usePostBuilder.getState().setAltText(slide.id, text)} />
    </div>
  );
}

export function ChecksPanelView() {
  const doc = useDoc();
  const issues = usePostBuilder((s) => s.issues);
  if (!doc) return null;
  return (
    <div className={styles.pad}>
      <ChecksPanel issues={issues} slides={doc.slides} onSelect={(id) => usePostBuilder.getState().select(id)} />
    </div>
  );
}
