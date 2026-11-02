import { useEffect, useMemo, useState } from "react";
import { SegmentedControl } from "@/components";
import { CropOverlay } from "@/components/media";
import { cropWindow } from "@/components/media/logic";
import { FilesService, type ComposerLayer } from "@/lib/api";
import { cropFromWindow } from "./logic";
import { Modal } from "./Modal";
import styles from "./CropDialog.module.css";

export interface CropDialogProps {
  layer: ComposerLayer;
  onApply: (crop: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}

type Shape = "current" | "original" | "1:1" | "4:5" | "3:4" | "16:9" | "9:16";

const RATIOS: Record<string, number> = { "1:1": 1, "4:5": 4 / 5, "3:4": 3 / 4, "16:9": 16 / 9, "9:16": 9 / 16 };
const MAX_W = 600;
const MAX_H = 380;

/** Crop of a layer's photo: pick a shape, then drag the window over the picture. */
export function CropDialog({ layer, onApply, onCancel }: CropDialogProps) {
  const ref = layer.image?.ref.path ?? "";
  const crop = layer.image?.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const full = crop.w >= 0.999 && crop.h >= 0.999;
  const [src, setSrc] = useState("");
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [shape, setShape] = useState<Shape>(full ? "original" : "current");
  const [center, setCenter] = useState({ x: crop.x + crop.w / 2, y: crop.y + crop.h / 2 });

  useEffect(() => {
    let off = false;
    FilesService.ImageThumb(ref, 800)
      .then((u) => !off && setSrc(u))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [ref]);

  const sourceAspect = nat ? nat.w / nat.h : 1;
  const aspect = useMemo(() => {
    if (shape === "original") return sourceAspect;
    if (shape === "current") return nat ? (crop.w * nat.w) / (crop.h * nat.h) : sourceAspect;
    return RATIOS[shape] ?? sourceAspect;
  }, [shape, nat, sourceAspect, crop.w, crop.h]);
  const win = cropWindow(aspect, sourceAspect);

  const dispW = nat ? Math.min(MAX_W, MAX_H * sourceAspect) : MAX_W;
  const dispH = nat ? dispW / sourceAspect : MAX_H;

  const options: Array<{ value: Shape; label: string }> = [
    ...(full ? [] : [{ value: "current" as const, label: "Current" }]),
    { value: "original", label: "Original" },
    { value: "1:1", label: "1:1" },
    { value: "4:5", label: "4:5" },
    { value: "3:4", label: "3:4" },
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
  ];

  const apply = () => {
    if (shape === "original") onApply({ x: 0, y: 0, w: 1, h: 1 });
    else onApply(cropFromWindow(win, center.x, center.y));
  };

  return (
    <Modal wide title="Crop photo" confirmLabel="Apply" confirmDisabled={!nat} onConfirm={apply} onCancel={onCancel}>
      <SegmentedControl<Shape> size="sm" aria-label="Crop shape" value={shape} options={options} onChange={setShape} />
      <div className={styles.frame} style={{ width: dispW, height: dispH }}>
        {src && (
          <img
            className={styles.img}
            src={src}
            alt="Photo to crop"
            draggable={false}
            onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          />
        )}
        {nat && shape !== "original" && (
          <CropOverlay
            rect={{ left: 0, top: 0, width: dispW, height: dispH }}
            aspect={aspect}
            sourceAspect={sourceAspect}
            x={center.x}
            y={center.y}
            onChange={(x, y) => setCenter({ x, y })}
          />
        )}
      </div>
    </Modal>
  );
}
