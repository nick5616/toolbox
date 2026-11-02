import { useState } from "react";
import { Button, Field, SegmentedControl, Select, Switch, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { SlideBuild } from "@/state/ui";
import { Modal } from "./Modal";
import { AUDIO_EXTS, fileName } from "./pool";
import styles from "./dialogs.module.css";

// "Make a collage…" and "Stitch into a video…" (SPEC.md §B13.4).

type CollageBuild = Extract<SlideBuild, { kind: "collage" }>;
type StitchBuild = Extract<SlideBuild, { kind: "stitch" }>;

export const COLLAGE_LAYOUTS: { value: CollageBuild["layout"]; label: string }[] = [
  { value: "scatter", label: "Scatter" },
  { value: "grid", label: "Grid" },
  { value: "stack", label: "Stack" },
  { value: "polaroids", label: "Polaroids" },
];

export const TRANSITIONS: { value: string; label: string }[] = [
  { value: "cut", label: "Cut" },
  { value: "fade", label: "Fade" },
  { value: "dip", label: "Dip to black" },
  { value: "slide", label: "Slide" },
];

export interface CollageDialogProps {
  /** The selected photos, in selection order (the first can be the background). */
  photos: { path: string; name: string }[];
  onConfirm: (build: CollageBuild) => void;
  onClose: () => void;
}

export function CollageDialog({ photos, onConfirm, onClose }: CollageDialogProps) {
  const [bg, setBg] = useState<"photo" | "color">("photo");
  const [color, setColor] = useState("#f3eee6");
  const [cutouts, setCutouts] = useState(true);
  const [layout, setLayout] = useState<CollageBuild["layout"]>("scatter");
  const first = photos[0];
  return (
    <Modal
      title="Make a collage"
      confirmLabel="Make collage"
      confirmDisabled={photos.length < 2}
      onConfirm={() => onConfirm({ kind: "collage", background: bg === "photo" && first ? first.path : "", color, cutouts, layout })}
      onClose={onClose}
    >
      <p className={styles.note}>
        {photos.length} {photos.length === 1 ? "photo" : "photos"} go into a new composition for this slide. Your files are not changed.
      </p>
      <Field label="Background">
        <SegmentedControl
          value={bg}
          onChange={setBg}
          aria-label="Background"
          options={[
            { value: "photo", label: first ? `First photo (${first.name})` : "First photo" },
            { value: "color", label: "A colour" },
          ]}
        />
      </Field>
      {bg === "color" && (
        <Field label="Colour">{(c) => <input {...c} type="color" value={color} onChange={(e) => setColor(e.target.value)} />}</Field>
      )}
      <Switch checked={cutouts} onChange={setCutouts} label="Cut out the others" aria-label="Cut out the others" />
      <Field label="Layout">{(c) => <Select id={c.id} value={layout} onChange={setLayout} options={COLLAGE_LAYOUTS} />}</Field>
    </Modal>
  );
}

export interface StitchDialogProps {
  count: number;
  onConfirm: (build: StitchBuild) => void;
  onClose: () => void;
}

export function StitchDialog({ count, onConfirm, onClose }: StitchDialogProps) {
  const [order, setOrder] = useState<StitchBuild["order"]>("date-taken");
  const [music, setMusic] = useState("");
  const [beatCut, setBeatCut] = useState(true);
  const [transition, setTransition] = useState("fade");

  const pickSong = async () => {
    try {
      const picked = (await FilesService.PickWith("Choose a song", AUDIO_EXTS, false)) ?? [];
      if (picked[0]) setMusic(picked[0]);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };

  return (
    <Modal
      title="Stitch into a video"
      confirmLabel="Make video"
      confirmDisabled={count < 1}
      onConfirm={() => onConfirm({ kind: "stitch", music, beatCut: music ? beatCut : false, order, transition })}
      onClose={onClose}
    >
      <p className={styles.note}>
        {count} {count === 1 ? "clip or photo goes" : "clips and photos go"} into a new video for this slide. Your files are not changed.
      </p>
      <Field label="Order">
        <SegmentedControl
          value={order}
          onChange={setOrder}
          aria-label="Order"
          options={[
            { value: "date-taken", label: "Date taken" },
            { value: "as-given", label: "As selected" },
          ]}
        />
      </Field>
      <div className={styles.files}>
        <Button size="sm" variant="secondary" icon="music" onClick={() => void pickSong()}>
          {music ? "Change song…" : "Choose a song…"}
        </Button>
        {music ? (
          <>
            <span className={styles.note} title={music}>
              {fileName(music)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setMusic("")}>
              No song
            </Button>
          </>
        ) : (
          <span className={styles.note}>No song</span>
        )}
      </div>
      <Switch checked={music ? beatCut : false} disabled={!music} onChange={setBeatCut} label="Cut on the beat" aria-label="Cut on the beat" />
      <Field label="Transition">{(c) => <Select id={c.id} value={transition} onChange={setTransition} options={TRANSITIONS} />}</Field>
    </Modal>
  );
}
