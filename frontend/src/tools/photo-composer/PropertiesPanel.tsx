import { Button, SegmentedControl, Select, Slider, Switch, TextArea } from "@/components";
import type { ComposerLayer, ComposerLook, ComposerOutline, ComposerShadow } from "@/lib/api";
import { COMPOSER_FONTS, type MoveDirection } from "@/composer/model";
import { Colour, Group, LookControls, NumberField, Row } from "./controls";
import { roundTo } from "./logic";

export interface LayerSectionsProps {
  layer: ComposerLayer;
  docWidth: number;
  docHeight: number;
  /** A job is working on the layer's photo. */
  busy: boolean;
  onPatch: (patch: Partial<ComposerLayer>) => void;
  onArrange: (dir: MoveDirection) => void;
  onRestoreOriginal: () => void;
}

const pct = (v: number): string => `${Math.round(v * 100)}`;
const FONT_OPTIONS = COMPOSER_FONTS.map((f) => ({ value: f, label: f }));

/**
 * The Layer panel: where the layer is and how it looks (position, size,
 * rotation, opacity, arrange, photo corners and look, outline, shadow). Crop
 * and Remove background are on the selection bar; the words are in Text style.
 */
export function LayerSections({ layer, docWidth, docHeight, busy, onPatch, onArrange, onRestoreOriginal }: LayerSectionsProps) {
  const px = (v: number): string => `${Math.round(v * docWidth)} px`;
  const setShadow = (p: Partial<ComposerShadow>) => onPatch({ shadow: { ...layer.shadow, ...p } });
  const setOutline = (p: Partial<ComposerOutline>) => onPatch({ outline: { ...layer.outline, ...p } });
  const setLook = (look: ComposerLook) => onPatch({ look });
  const im = layer.image;
  const cutOut = !!im?.ref.original;

  return (
    <div aria-label="Layer properties" role="group">
      <Group title="Position" tip="Where the layer is and how big, rotated and see-through it is">
        <Row label="X" tip="Horizontal position of the layer centre, in pixels from the left">
          <NumberField label="X" unit="px" value={roundTo(layer.x * docWidth, 1)} onChange={(v) => onPatch({ x: v / docWidth })} />
        </Row>
        <Row label="Y" tip="Vertical position of the layer centre, in pixels from the top">
          <NumberField label="Y" unit="px" value={roundTo(layer.y * docHeight, 1)} onChange={(v) => onPatch({ y: v / docHeight })} />
        </Row>
        <Row label={layer.kind === "text" ? "Text size" : "Size"} tip={layer.kind === "text" ? "Text size as a percentage of the canvas width" : "Layer size as a percentage of the canvas width"}>
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
        <Row label="Rotation" tip="Turn the layer, in degrees (you can also drag the circle on the canvas)">
          <NumberField label="Rotation" unit="°" min={-3600} max={3600} value={roundTo(layer.rotation, 1)} onChange={(v) => onPatch({ rotation: v })} />
        </Row>
        <Row label="Flip">
          <Switch checked={layer.flipX} label="Mirror" tip="Flip the layer left to right" onChange={(v) => onPatch({ flipX: v })} />
        </Row>
        <Row label="Opacity" tip="How solid the layer is; lower lets what is behind show through">
          <Slider aria-label="Layer opacity" min={0} max={1} step={0.01} value={layer.opacity} format={pct} onChange={(v) => onPatch({ opacity: v })} />
        </Row>
        <Row label="Arrange" tip="Change which layers cover which">
          <Button size="sm" variant="secondary" data-tip="Move this layer one step toward the front" onClick={() => onArrange("up")}>
            Forward
          </Button>
          <Button size="sm" variant="secondary" data-tip="Move this layer one step toward the back" onClick={() => onArrange("down")}>
            Backward
          </Button>
          <Button size="sm" variant="ghost" data-tip="Bring this layer in front of all others" onClick={() => onArrange("top")}>
            Front
          </Button>
          <Button size="sm" variant="ghost" data-tip="Send this layer behind all others" onClick={() => onArrange("bottom")}>
            Back
          </Button>
        </Row>
      </Group>

      {im && (
        <Group title="Photo" tip="Rounded corners and the original of this photo">
          <Row label="Corners" tip="Round the photo's corners; all the way up makes a circle or pill">
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
          <Row label="Template">
            <Switch
              checked={layer.slot}
              label="Template slot"
              tip="A pipeline's Fill a template step puts one photo here. If no photo is marked, every visible photo is a slot"
              onChange={(slot) => onPatch({ slot })}
            />
          </Row>
          {cutOut && (
            <Row label="Original">
              <Button size="sm" variant="ghost" data-tip="Put the original photo back, with its background" disabled={busy} onClick={onRestoreOriginal}>
                Restore original
              </Button>
            </Row>
          )}
        </Group>
      )}

      {im && (
        <Group title="Look" tip="Colour adjustments for this photo">
          <LookControls look={layer.look} onChange={setLook} />
        </Group>
      )}

      <Group title="Outline" tip="A coloured border around the layer's shape" actions={<Switch checked={layer.outline.on} label="Outline" tip="Draw an outline around the layer" onChange={(on) => setOutline({ on })} />}>
        {layer.outline.on && (
          <>
            <Row label="Width" tip="Thickness of the outline in pixels">
              <Slider aria-label="Outline width" min={0} max={0.06} step={0.001} value={layer.outline.width} format={px} onChange={(width) => setOutline({ width })} />
            </Row>
            <Row label="Colour" tip="Colour of the outline">
              <Colour label="Outline colour" value={layer.outline.color} onChange={(color) => setOutline({ color })} />
            </Row>
          </>
        )}
      </Group>

      <Group title="Shadow" tip="A soft shadow behind the layer" actions={<Switch checked={layer.shadow.on} label="Shadow" tip="Draw a shadow behind the layer" onChange={(on) => setShadow({ on })} />}>
        {layer.shadow.on && (
          <>
            <Row label="Blur" tip="How soft the shadow edge is, in pixels">
              <Slider aria-label="Shadow blur" min={0} max={0.1} step={0.001} value={layer.shadow.blur} format={px} onChange={(blur) => setShadow({ blur })} />
            </Row>
            <Row label="Offset X" tip="Move the shadow sideways, in pixels">
              <Slider aria-label="Shadow offset X" min={-0.1} max={0.1} step={0.001} value={layer.shadow.offsetX} format={px} onChange={(offsetX) => setShadow({ offsetX })} />
            </Row>
            <Row label="Offset Y" tip="Move the shadow up or down, in pixels">
              <Slider aria-label="Shadow offset Y" min={-0.1} max={0.1} step={0.001} value={layer.shadow.offsetY} format={px} onChange={(offsetY) => setShadow({ offsetY })} />
            </Row>
            <Row label="Opacity" tip="How dark the shadow is">
              <Slider aria-label="Shadow opacity" min={0} max={1} step={0.01} value={layer.shadow.opacity} format={pct} onChange={(opacity) => setShadow({ opacity })} />
            </Row>
            <Row label="Colour" tip="Colour of the shadow">
              <Colour label="Shadow colour" value={layer.shadow.color} onChange={(color) => setShadow({ color })} />
            </Row>
          </>
        )}
      </Group>
    </div>
  );
}

export interface TextSectionsProps {
  layer: ComposerLayer;
  onPatch: (patch: Partial<ComposerLayer>) => void;
}

/** The Text style panel: the words and how they look. */
export function TextSections({ layer, onPatch }: TextSectionsProps) {
  const t = layer.text;
  if (!t) return null;
  return (
    <div aria-label="Text style" role="group">
      <Group title="Text" tip="The words and their style">
        <TextArea
          aria-label="Text"
          data-tip="The text shown on the canvas (you can also double-click it there)"
          minRows={2}
          maxRows={6}
          value={t.text}
          onChange={(e) => onPatch({ text: { ...t, text: e.target.value } })}
        />
        <Row label="Font" tip="Typeface for the text">
          <Select size="sm" aria-label="Font" value={t.font as (typeof COMPOSER_FONTS)[number]} options={FONT_OPTIONS} onChange={(font) => onPatch({ text: { ...t, font } })} />
        </Row>
        <Row label="Style">
          <Switch checked={t.bold} label="Bold" tip="Make the text bold" onChange={(bold) => onPatch({ text: { ...t, bold } })} />
          <Switch checked={t.italic} label="Italic" tip="Slant the text" onChange={(italic) => onPatch({ text: { ...t, italic } })} />
        </Row>
        <Row label="Colour" tip="Colour of the text">
          <Colour label="Text colour" value={t.color} onChange={(color) => onPatch({ text: { ...t, color } })} />
        </Row>
        <Row label="Align">
          <SegmentedControl
            size="sm"
            aria-label="Text alignment"
            value={t.align as "left" | "center" | "right"}
            options={[
              { value: "left", label: "Left", tip: "Line up the lines of text on the left" },
              { value: "center", label: "Centre", tip: "Centre the lines of text" },
              { value: "right", label: "Right", tip: "Line up the lines of text on the right" },
            ]}
            onChange={(align) => onPatch({ text: { ...t, align } })}
          />
        </Row>
        <Row label="Line height" tip="Space between lines of text; 1 is tight, 2 is airy">
          <Slider aria-label="Line height" min={0.8} max={2} step={0.05} value={t.lineHeight} format={(v) => v.toFixed(2)} onChange={(lineHeight) => onPatch({ text: { ...t, lineHeight } })} />
        </Row>
        <Row label="Pill">
          <Switch checked={!!t.pill} label="Background pill" tip="Put a rounded coloured bar behind the text" onChange={(on) => onPatch({ text: { ...t, pill: on ? "#ffffff" : "" } })} />
        </Row>
        {t.pill && (
          <Row label="Pill colour" tip="Colour of the bar behind the text">
            <Colour label="Pill colour" value={t.pill} onChange={(pill) => onPatch({ text: { ...t, pill } })} />
          </Row>
        )}
      </Group>
    </div>
  );
}
