import { Button, SegmentedControl, Slider, Switch } from "@/components";
import type { ComposerBackground } from "@/lib/api";
import { Colour, Group, LookControls, NumberField, Row } from "./controls";

export interface BackgroundPanelProps {
  background: ComposerBackground;
  adjust: boolean;
  onAdjust: (on: boolean) => void;
  onChange: (b: ComposerBackground) => void;
  onChoosePhoto: () => void;
}

type Kind = "color" | "gradient" | "image";

const pct = (v: number): string => `${Math.round(v * 100)}`;

/** The canvas background (shown when no layer is selected). */
export function BackgroundPanel({ background: b, adjust, onAdjust, onChange, onChoosePhoto }: BackgroundPanelProps) {
  const set = (patch: Partial<ComposerBackground>) => onChange({ ...b, ...patch });
  const hasPhoto = !!b.image?.path;
  return (
    <div role="group" aria-label="Background">
      <Group title="Background">
        <SegmentedControl<Kind>
          size="sm"
          fullWidth
          aria-label="Background kind"
          value={b.kind as Kind}
          options={[
            { value: "color", label: "Colour" },
            { value: "gradient", label: "Gradient" },
            { value: "image", label: "Photo" },
          ]}
          onChange={(kind) => {
            if (kind === "image" && !hasPhoto) {
              onChoosePhoto();
              return;
            }
            set({ kind });
          }}
        />
        <Row label={b.kind === "gradient" ? "From" : "Colour"}>
          <Colour label="Background colour" value={b.color} onChange={(color) => set({ color })} />
        </Row>
        {b.kind === "gradient" && (
          <>
            <Row label="To">
              <Colour label="Gradient end colour" value={b.color2} onChange={(color2) => set({ color2 })} />
            </Row>
            <Row label="Angle">
              <NumberField label="Gradient angle" unit="°" min={-360} max={360} value={b.angle} onChange={(angle) => set({ angle: Math.round(angle) })} />
            </Row>
          </>
        )}
      </Group>
      {b.kind === "image" && hasPhoto && (
        <Group title="Photo">
          <Row label="Photo">
            <Button size="sm" variant="secondary" icon="image" onClick={onChoosePhoto}>
              Replace…
            </Button>
          </Row>
          <Row label="Adjust">
            <Switch checked={adjust} label="Adjust background" onChange={onAdjust} />
          </Row>
          {adjust && <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-subtle)" }}>Drag on the canvas to move the photo; scroll to zoom.</p>}
          <Row label="Zoom">
            <Slider aria-label="Background zoom" min={1} max={4} step={0.01} value={b.zoom} format={(v) => `${v.toFixed(2)}x`} onChange={(zoom) => set({ zoom })} />
          </Row>
          <Row label="Blur">
            <Slider aria-label="Background blur" min={0} max={1} step={0.01} value={b.blur} format={pct} onChange={(blur) => set({ blur })} />
          </Row>
          <LookControls look={b.look} onChange={(look) => set({ look })} />
        </Group>
      )}
    </div>
  );
}
