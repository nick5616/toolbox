import { Button, SegmentedControl, Select, Slider, Switch, TextArea } from "@/components";
import type { ComposerLayer, ComposerLook, ComposerOutline, ComposerShadow } from "@/lib/api";
import { COMPOSER_FONTS, type MoveDirection } from "@/composer/model";
import { Colour, Group, LookControls, NumberField, Row } from "./controls";
import { roundTo } from "./logic";

export interface PropertiesPanelProps {
  layer: ComposerLayer;
  docWidth: number;
  docHeight: number;
  busy: boolean;
  onPatch: (patch: Partial<ComposerLayer>) => void;
  onArrange: (dir: MoveDirection) => void;
  onCrop: () => void;
  onRemoveBackground: () => void;
  onRestoreOriginal: () => void;
}

const pct = (v: number): string => `${Math.round(v * 100)}`;
const FONT_OPTIONS = COMPOSER_FONTS.map((f) => ({ value: f, label: f }));

/** Everything about the selected layer. */
export function PropertiesPanel({ layer, docWidth, docHeight, busy, onPatch, onArrange, onCrop, onRemoveBackground, onRestoreOriginal }: PropertiesPanelProps) {
  const px = (v: number): string => `${Math.round(v * docWidth)} px`;
  const setShadow = (p: Partial<ComposerShadow>) => onPatch({ shadow: { ...layer.shadow, ...p } });
  const setOutline = (p: Partial<ComposerOutline>) => onPatch({ outline: { ...layer.outline, ...p } });
  const setLook = (look: ComposerLook) => onPatch({ look });
  const im = layer.image;
  const t = layer.text;
  const cutOut = !!im?.ref.original;

  return (
    <div aria-label="Layer properties" role="group">
      <Group title="Position">
        <Row label="X">
          <NumberField label="X" unit="px" value={roundTo(layer.x * docWidth, 1)} onChange={(v) => onPatch({ x: v / docWidth })} />
        </Row>
        <Row label="Y">
          <NumberField label="Y" unit="px" value={roundTo(layer.y * docHeight, 1)} onChange={(v) => onPatch({ y: v / docHeight })} />
        </Row>
        <Row label={layer.kind === "text" ? "Text size" : "Size"}>
          <NumberField
            label="Size"
            unit="%"
            min={0.5}
            max={layer.kind === "text" ? 100 : 500}
            step={0.5}
            value={roundTo(layer.size * 100, 1)}
            onChange={(v) => onPatch({ size: v / 100 })}
          />
        </Row>
        <Row label="Rotation">
          <NumberField label="Rotation" unit="°" min={-3600} max={3600} value={roundTo(layer.rotation, 1)} onChange={(v) => onPatch({ rotation: v })} />
        </Row>
        <Row label="Flip">
          <Switch checked={layer.flipX} label="Mirror" onChange={(v) => onPatch({ flipX: v })} />
        </Row>
        <Row label="Opacity">
          <Slider aria-label="Opacity" min={0} max={1} step={0.01} value={layer.opacity} format={pct} onChange={(v) => onPatch({ opacity: v })} />
        </Row>
        <Row label="Arrange">
          <Button size="sm" variant="secondary" onClick={() => onArrange("up")}>
            Forward
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onArrange("down")}>
            Backward
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onArrange("top")}>
            Front
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onArrange("bottom")}>
            Back
          </Button>
        </Row>
      </Group>

      {im && (
        <Group title="Photo">
          <Row label="Crop">
            <Button size="sm" variant="secondary" icon="crop" onClick={onCrop}>
              Crop…
            </Button>
          </Row>
          <Row label="Corners">
            <Slider
              aria-label="Corner radius"
              min={0}
              max={0.5}
              step={0.005}
              value={im.radius}
              format={pct}
              onChange={(v) => onPatch({ image: { ...im, radius: v } })}
            />
          </Row>
          <Row label="Background">
            <Button size="sm" variant="secondary" icon="wand-sparkles" loading={busy} disabled={busy} onClick={onRemoveBackground}>
              Remove background
            </Button>
            {cutOut && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRestoreOriginal}>
                Restore original
              </Button>
            )}
          </Row>
        </Group>
      )}

      {t && (
        <Group title="Text">
          <TextArea
            aria-label="Text"
            minRows={2}
            maxRows={6}
            value={t.text}
            onChange={(e) => onPatch({ text: { ...t, text: e.target.value } })}
          />
          <Row label="Font">
            <Select size="sm" aria-label="Font" value={t.font as (typeof COMPOSER_FONTS)[number]} options={FONT_OPTIONS} onChange={(font) => onPatch({ text: { ...t, font } })} />
          </Row>
          <Row label="Style">
            <Switch checked={t.bold} label="Bold" onChange={(bold) => onPatch({ text: { ...t, bold } })} />
            <Switch checked={t.italic} label="Italic" onChange={(italic) => onPatch({ text: { ...t, italic } })} />
          </Row>
          <Row label="Colour">
            <Colour label="Text colour" value={t.color} onChange={(color) => onPatch({ text: { ...t, color } })} />
          </Row>
          <Row label="Align">
            <SegmentedControl
              size="sm"
              aria-label="Text alignment"
              value={t.align as "left" | "center" | "right"}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Centre" },
                { value: "right", label: "Right" },
              ]}
              onChange={(align) => onPatch({ text: { ...t, align } })}
            />
          </Row>
          <Row label="Line height">
            <Slider aria-label="Line height" min={0.8} max={2} step={0.05} value={t.lineHeight} format={(v) => v.toFixed(2)} onChange={(lineHeight) => onPatch({ text: { ...t, lineHeight } })} />
          </Row>
          <Row label="Pill">
            <Switch checked={!!t.pill} label="Background pill" onChange={(on) => onPatch({ text: { ...t, pill: on ? "#ffffff" : "" } })} />
          </Row>
          {t.pill && (
            <Row label="Pill colour">
              <Colour label="Pill colour" value={t.pill} onChange={(pill) => onPatch({ text: { ...t, pill } })} />
            </Row>
          )}
        </Group>
      )}

      {im && (
        <Group title="Look">
          <LookControls look={layer.look} onChange={setLook} />
        </Group>
      )}

      <Group title="Outline" actions={<Switch checked={layer.outline.on} label="Outline" onChange={(on) => setOutline({ on })} />}>
        {layer.outline.on && (
          <>
            <Row label="Width">
              <Slider aria-label="Outline width" min={0} max={0.06} step={0.001} value={layer.outline.width} format={px} onChange={(width) => setOutline({ width })} />
            </Row>
            <Row label="Colour">
              <Colour label="Outline colour" value={layer.outline.color} onChange={(color) => setOutline({ color })} />
            </Row>
          </>
        )}
      </Group>

      <Group title="Shadow" actions={<Switch checked={layer.shadow.on} label="Shadow" onChange={(on) => setShadow({ on })} />}>
        {layer.shadow.on && (
          <>
            <Row label="Blur">
              <Slider aria-label="Shadow blur" min={0} max={0.1} step={0.001} value={layer.shadow.blur} format={px} onChange={(blur) => setShadow({ blur })} />
            </Row>
            <Row label="Offset X">
              <Slider aria-label="Shadow offset X" min={-0.1} max={0.1} step={0.001} value={layer.shadow.offsetX} format={px} onChange={(offsetX) => setShadow({ offsetX })} />
            </Row>
            <Row label="Offset Y">
              <Slider aria-label="Shadow offset Y" min={-0.1} max={0.1} step={0.001} value={layer.shadow.offsetY} format={px} onChange={(offsetY) => setShadow({ offsetY })} />
            </Row>
            <Row label="Opacity">
              <Slider aria-label="Shadow opacity" min={0} max={1} step={0.01} value={layer.shadow.opacity} format={pct} onChange={(opacity) => setShadow({ opacity })} />
            </Row>
            <Row label="Colour">
              <Colour label="Shadow colour" value={layer.shadow.color} onChange={(color) => setShadow({ color })} />
            </Row>
          </>
        )}
      </Group>
    </div>
  );
}
