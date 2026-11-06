/**
 * Post Builder (Phase 11, SPEC §5.2): a workspace. Header (Posts chip, save state |
 * undo · redo · ⋯ · Export), a rail (Sources, Format, Caption, Checks), the slide stage,
 * a side column (slide strip and, when the window is wide enough, the phone preview)
 * and the slide selection bar. The state is in `usePostBuilder`; this window hosts it
 * (`host.ts`) for popped-out panels and the phone preview.
 */
import { useCallback, useMemo, useState } from "react";
import { Button, ClickIn, ClickInHost, DropZone, EmptyState, Spinner, type MenuItem } from "@/components";
import { useBeforePopOut } from "@/lib/popout";
import { useCompositionInputs } from "@/state/composition";
import { useElementSize } from "@/lib/useElementSize";
import { StudioLayout, WorkspacePreviewFrame, WorkspaceRail } from "@/workspace";
import type { ToolViewProps } from "../index";
import { ProjectPickerDialog } from "./dialogs";
import { PostHeader } from "./Header";
import { usePostHost } from "./host";
import { altSummary, checksSummary, formatSummary, issuesBySlide, roomLeft, sourcesSummary } from "./logic";
import { PhonePreviewPart } from "./preview";
import { PostsPanelView } from "./panels";
import { pickMediaFiles, usePostDialogs } from "./postDialogs";
import { MODULE_ID, useDoc, usePostBuilder, useProjects, useSelectedSlide } from "./postStore";
import { SelectionBar } from "./SelectionBar";
import { SlideStage } from "./SlideStage";
import { SlideStrip } from "./SlideStrip";
import { postWorkspace as ws } from "./workspace";
import styles from "./PostBuilderView.module.css";

/** The window is wide enough for the phone preview beside the stage (px). */
const WIDE_PX = 1200;
const STRIP_PX = 170;
const PHONE_PX = 300;

export default function PostBuilderView(_props: ToolViewProps) {
  usePostHost();
  // While a post is open this window hosts its store for popped-out panels and the preview.
  ws.useHost();
  useBeforePopOut(MODULE_ID, () => usePostBuilder.getState().flush());

  const ready = usePostBuilder((s) => s.ready);
  const postId = usePostBuilder((s) => s.postId);
  const postCount = usePostBuilder((s) => s.posts.length);

  if (!ready) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }
  return (
    <ClickInHost className={styles.root}>{postCount === 0 || !postId ? <EmptyPosts /> : <Workspace />}</ClickInHost>
  );
}

function EmptyPosts() {
  const postCount = usePostBuilder((s) => s.posts.length);
  const dialogs = usePostDialogs();
  return (
    <div className={styles.empty}>
      <EmptyState icon="gallery-horizontal-end" title="Build a post" body="Put photos, clips, compositions and videos in order, write the caption, check it against Instagram's rules and export a folder you can upload from your phone." />
      <Button variant="primary" icon="plus" data-tip="Start a post from a folder of photos and clips, or empty" onClick={dialogs.openNew}>
        New post
      </Button>
      <DropZone id="tool-drop:post-builder" label="Drop photos and clips to start a post" />
      {postCount > 0 && (
        <div className={styles.stripWrap}>
          <PostsPanelView />
        </div>
      )}
      {dialogs.node}
    </div>
  );
}

function Workspace() {
  const st = usePostBuilder.getState;
  const doc = useDoc();
  const selectedId = usePostBuilder((s) => s.selectedId);
  const limits = usePostBuilder((s) => s.limits);
  const issues = usePostBuilder((s) => s.issues);
  const still = usePostBuilder((s) => s.still);
  const loadError = usePostBuilder((s) => s.loadError);
  const comps = usePostBuilder((s) => s.comps);
  const videos = usePostBuilder((s) => s.videos);
  const projects = useProjects();
  const { slide: selected, index } = useSelectedSlide();
  const slideIssues = useMemo(() => issuesBySlide(issues), [issues]);
  const [pick, setPick] = useState<"composition" | "video" | null>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const width = useElementSize(root).width;
  const wide = width === 0 || width >= WIDE_PX;

  // What the constituents get: the selected slide's photo.
  const photoPath = selected?.kind === "photo" ? selected.path : "";
  const photoInputs = useMemo(() => (photoPath ? [photoPath] : []), [photoPath]);
  useCompositionInputs(MODULE_ID, { "bg-remover": photoInputs, upscaler: photoInputs, "photo-composer": photoInputs });

  const addItems = useCallback((): MenuItem[] => {
    const d = usePostBuilder.getState().history?.present;
    const full = !d || roomLeft(d, usePostBuilder.getState().limits) === 0;
    const why = "This post is full";
    return [
      { id: "files", label: "Photos & clips…", tip: full ? why : "Pick photos and videos from your computer; each becomes a slide", icon: "image", disabled: full, onSelect: () => void pickMediaFiles().then((p) => st().addPaths(p)) },
      { id: "new-comp", label: "New composition", tip: full ? why : "Design a collage or graphic in Photo Composer and use it as a slide", icon: "layers", disabled: full, onSelect: () => void st().newProjectSlide("composition") },
      { id: "new-video", label: "New video", tip: full ? why : "Edit a video in Video Editor and use it as a slide", icon: "clapperboard", disabled: full, onSelect: () => void st().newProjectSlide("video") },
      { id: "old-comp", label: "Existing composition…", tip: full ? why : "Use a composition you already made in Photo Composer", icon: "layers", disabled: full, onSelect: () => setPick("composition") },
      { id: "old-video", label: "Existing video…", tip: full ? why : "Use a video you already made in Video Editor", icon: "clapperboard", disabled: full, onSelect: () => setPick("video") },
    ];
  }, [st]);

  const summaries = {
    sources: doc ? sourcesSummary(doc) : "",
    format: doc ? formatSummary(doc) : "",
    caption: doc ? (doc.caption.trim() ? `${doc.caption.trim().length} characters` : "Empty") : "",
    checks: checksSummary(issues),
    alt: altSummary(selected, index),
  };

  const phone = !wide ? (
    <ClickIn variant="icon" icon="smartphone" title="Phone preview" tip="Roughly how the post will look in Instagram on a phone" part={ws.previewPart} width={340}>
      <PhonePreviewPart />
    </ClickIn>
  ) : null;

  const stage = loadError && !doc ? (
    <EmptyState icon="circle-alert" title="This post can't be opened" body={loadError} />
  ) : !doc ? (
    <div className={styles.center}>
      <Spinner />
    </div>
  ) : selected ? (
    <div className={styles.stage}>
      <SlideStage
        key={selected.id}
        slide={selected}
        aspect={doc.aspect}
        project={projects.get(selected.projectId)}
        onChange={(patch) => st().patchSlide(selected.id, patch)}
        onEdit={(where) => void st().editSlide(selected.id, where)}
        stillMs={still && still.id === selected.id ? still.ms : selected.inMs}
      />
    </div>
  ) : (
    <div className={styles.dropArea}>
      <DropZone id="tool-drop:post-builder" label="Drop photos and clips" hint="or use Add in the slides list" />
    </div>
  );

  const side = doc ? (
    <div className={styles.side}>
      <div className={styles.strip} style={{ width: STRIP_PX }}>
        <SlideStrip
          slides={doc.slides}
          selectedId={selectedId}
          aspect={doc.aspect}
          issues={slideIssues}
          projects={projects}
          maxSlides={doc.format === "reel" ? 1 : limits.maxSlides}
          addItems={addItems}
          onSelect={(id) => st().select(id)}
          onReorder={(from, to) => st().reorderSlides(from, to)}
          onDelete={(id) => st().deleteSlide(id)}
          onDuplicate={(id) => st().copySlide(id)}
          onSourceDrop={(paths, drop) => st().dropSources(paths, drop)}
        />
      </div>
      {wide && (
        <div className={styles.phone}>
          <WorkspacePreviewFrame ws={ws}>
            <PhonePreviewPart />
          </WorkspacePreviewFrame>
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <div ref={setRoot} className={styles.fill}>
      <StudioLayout
        header={<PostHeader />}
        rail={
          <WorkspaceRail
            ws={ws}
            panels={["sources", "format", "caption", "checks"]}
            summaries={summaries}
            badges={{ checks: issues.length || undefined }}
            extra={phone ? [{ id: "phone", caption: "Phone", node: phone }] : []}
          />
        }
        stage={stage}
        side={side}
        sideWidth={wide ? STRIP_PX + PHONE_PX + 40 : STRIP_PX + 28}
        bottom={doc ? <SelectionBar /> : undefined}
      />
      {pick && (
        <ProjectPickerDialog
          title={pick === "composition" ? "Choose a composition" : "Choose a video"}
          projects={pick === "composition" ? comps : videos}
          emptyText={pick === "composition" ? "No compositions yet. Make one with New composition." : "No videos yet. Make one with New video."}
          onPick={(p) => {
            setPick(null);
            st().addExisting(p.id, pick);
          }}
          onClose={() => setPick(null)}
        />
      )}
    </div>
  );
}
