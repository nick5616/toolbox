import { Button, SegmentedControl, Slider, Switch } from "@/components";
import type { ComposerBackground } from "@/lib/api";
import { Colour, Group, LookControls, NumberField, Row } from "./controls";

export interface BackgroundPanelProps {
  background: ComposerBackground;
  adjust: boolean;
  onAdjust: (on: boolean) => void;
  onChange: (b: ComposerBackground) => void;
  onChoosePhoto: () => void;
  onChoosePhotoFromLibrary?: () => void;
}

type Kind = "color" | "gradient" | "image";

const pct = (v: number): string => `${Math.round(v * 100)}`;

/** The canvas background (shown when no layer is selected). */
export function BackgroundPanel({ background: b, adjust, onAdjust, onChange, onChoosePhoto, onChoosePhotoFromLibrary }: BackgroundPanelProps) {
  const set = (patch: Partial<ComposerBackground>) => onChange({ ...b, ...patch });
  const hasPhoto = !!b.image?.path;
  return (
    <div role="group" aria-label="Background">
      <Group title="Background" tip="What shows behind all the layers">
        <SegmentedControl<Kind>
          size="sm"
          fullWidth
          aria-label="Background kind"
          value={b.kind as Kind}
          options={[
            { value: "color", label: "Colour", tip: "A single flat colour" },
            { value: "gradient", label: "Gradient", tip: "A smooth blend between two colours" },
            { value: "image", label: "Photo", tip: "Use one of your photos as the background" },
          ]}
          onChange={(kind) => {
            if (kind === "image" && !hasPhoto) {
              onChoosePhoto();
              return;
            }
            set({ kind });
          }}
        />
        {!hasPhoto && onChoosePhotoFromLibrary && (
          <Row label="Photo" tip="Use one of the files Toolbox already made as the background">
            <Button size="sm" variant="secondary" icon="history" data-tip="Pick a background photo from files Toolbox already made (the Library)" onClick={onChoosePhotoFromLibrary}>
              From Library…
            </Button>
          </Row>
        )}
        <Row label={b.kind === "gradient" ? "From" : "Colour"} tip={b.kind === "gradient" ? "Colour at the start of the gradient" : "Background colour"}>
          <Colour label="Background colour" value={b.color} onChange={(color) => set({ color })} />
        </Row>
        {b.kind === "gradient" && (
          <>
            <Row label="To" tip="Colour at the end of the gradient">
              <Colour label="Gradient end colour" value={b.color2} onChange={(color2) => set({ color2 })} />
            </Row>
            <Row label="Angle" tip="Direction of the gradient in degrees; 0 runs left to right">
              <NumberField label="Gradient angle" unit="°" min={-360} max={360} value={b.angle} onChange={(angle) => set({ angle: Math.round(angle) })} />
            </Row>
          </>
        )}
      </Group>
      {b.kind === "image" && hasPhoto && (
        <Group title="Photo" tip="Settings for the background photo">
          <Row label="Photo">
            <Button size="sm" variant="secondary" icon="image" data-tip="Pick a different background photo" onClick={onChoosePhoto}>
              Replace…
            </Button>
          </Row>
          {onChoosePhotoFromLibrary && (
            <Row label="Library">
              <Button size="sm" variant="secondary" icon="history" data-tip="Pick a background photo from files Toolbox already made (the Library)" onClick={onChoosePhotoFromLibrary}>
                From Library…
              </Button>
            </Row>
          )}
          <Row label="Adjust">
            <Switch checked={adjust} label="Adjust background" tip="Drag and scroll on the canvas to move and zoom the background photo instead of the layers" onChange={onAdjust} />
          </Row>
          {adjust && <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-subtle)" }}>Drag on the canvas to move the photo; scroll to zoom.</p>}
          <Row label="Zoom" tip="Enlarge the background photo; 1x fills the canvas exactly">
            <Slider aria-label="Background zoom" min={1} max={4} step={0.01} value={b.zoom} format={(v) => `${v.toFixed(2)}x`} onChange={(zoom) => set({ zoom })} />
          </Row>
          <Row label="Blur" tip="Soften the background photo so the layers stand out">
            <Slider aria-label="Background blur" min={0} max={1} step={0.01} value={b.blur} format={pct} onChange={(blur) => set({ blur })} />
          </Row>
          <LookControls look={b.look} onChange={(look) => set({ look })} />
        </Group>
      )}
    </div>
  );
}
