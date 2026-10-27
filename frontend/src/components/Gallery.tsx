import { useState, type ReactNode } from "react";
import { Badge } from "./Badge";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { DropZone } from "./DropZone";
import { EmptyState } from "./EmptyState";
import { Field } from "./Field";
import { FileList } from "./FileList";
import { Icon, iconNames } from "./Icon";
import { IconButton } from "./IconButton";
import { Kbd } from "./Kbd";
import { Meter, type MeterStatus } from "./Meter";
import { PathText } from "./PathText";
import { SegmentedControl } from "./SegmentedControl";
import { Section } from "./Section";
import { Select } from "./Select";
import { Spinner } from "./Spinner";
import { StatusChip } from "./StatusChip";
import { Stepper } from "./Stepper";
import { Switch } from "./Switch";
import { TextArea } from "./TextArea";
import { TextField } from "./TextField";
import { TimecodeInput } from "./TimecodeInput";
import { Toaster } from "./Toaster";
import { toast } from "./toast";
import { Tooltip } from "./Tooltip";
import styles from "./Gallery.module.css";

type Theme = "dark" | "light";
type Mode = "audio" | "video" | "image";

const statuses: MeterStatus[] = ["queued", "running", "done", "failed", "cancelled"];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>{label}</div>
      <div className={styles.rowBody}>{children}</div>
    </div>
  );
}

/** Dev-only screen showing every component and state. */
export function Gallery() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [mode, setMode] = useState<Mode>("audio");
  const [select, setSelect] = useState<"mp3" | "m4a" | "opus">("m4a");
  const [on, setOn] = useState(true);
  const [steps, setSteps] = useState(3);
  const [text, setText] = useState("");
  const [area, setArea] = useState("Line one\nLine two");
  const [tc, setTc] = useState("1:05.5");
  const [files, setFiles] = useState([
    { path: "C:\\Users\\nick\\Music\\Sessions\\2026\\October\\a-very-long-folder-name\\take-03.wav", size: 48_123_456 },
    { path: "/Users/nick/Movies/clip.mp4", size: 1_234_567_890 },
  ]);

  const applyTheme = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Component gallery</h1>
        <SegmentedControl<Theme>
          aria-label="Theme"
          value={theme}
          onChange={applyTheme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
      </header>

      <Section label="Buttons">
        <Row label="Variants">
          <Button variant="primary" icon="download" kbd="Mod+Enter">
            Download
          </Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon="trash-2">
            Delete
          </Button>
        </Row>
        <Row label="Small">
          <Button size="sm" variant="primary">
            Primary
          </Button>
          <Button size="sm">Secondary</Button>
          <Button size="sm" variant="ghost">
            Ghost
          </Button>
          <Button size="sm" variant="danger">
            Danger
          </Button>
        </Row>
        <Row label="States">
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button disabled>Disabled</Button>
          <IconButton icon="settings" label="Settings" kbd="Mod+Comma" />
          <IconButton icon="trash-2" label="Delete" variant="danger" />
          <IconButton icon="panel-left" label="Toggle sidebar" pressed />
          <IconButton icon="x" label="Small close" size="sm" />
        </Row>
      </Section>

      <Section label="Inputs">
        <Row label="Segmented">
          <SegmentedControl<Mode>
            aria-label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "audio", label: "Audio" },
              { value: "video", label: "Video" },
              { value: "image", label: "Image", disabled: true },
            ]}
          />
          <SegmentedControl<Mode>
            size="sm"
            aria-label="Mode small"
            value={mode}
            onChange={setMode}
            options={[
              { value: "audio", label: "Audio" },
              { value: "video", label: "Video" },
            ]}
          />
        </Row>
        <Row label="Select">
          <Select aria-label="Format" value={select} onChange={setSelect} options={[
            { value: "mp3", label: "MP3" },
            { value: "m4a", label: "M4A" },
            { value: "opus", label: "Opus" },
          ]} />
          <Select aria-label="Disabled" value="mp3" onChange={() => {}} disabled options={[{ value: "mp3", label: "Disabled" }]} />
        </Row>
        <Row label="Switch">
          <Switch checked={on} onChange={setOn} label="Embed thumbnail" />
          <Switch checked={false} onChange={() => {}} label="Off" />
          <Switch checked disabled onChange={() => {}} label="Disabled" />
        </Row>
        <Row label="Stepper">
          <Stepper aria-label="Concurrency" value={steps} onChange={setSteps} min={1} max={8} />
          <Stepper aria-label="Disabled" value={2} onChange={() => {}} disabled />
        </Row>
        <Row label="Text">
          <TextField aria-label="URL" placeholder="Paste a URL" icon="link" value={text} onChange={(e) => setText(e.target.value)} />
          <TextField aria-label="Invalid" invalid mono defaultValue="not a url" />
          <TextField aria-label="Disabled" disabled defaultValue="Disabled" />
        </Row>
        <Row label="TextArea">
          <TextArea aria-label="Notes" value={area} onChange={(e) => setArea(e.target.value)} minRows={2} maxRows={5} />
        </Row>
        <Row label="Timecode">
          <TimecodeInput aria-label="Start" value={tc} onChange={setTc} />
          <TimecodeInput aria-label="End (invalid)" value="9:99:" onChange={() => {}} invalid />
          <TimecodeInput aria-label="Empty" value="" onChange={() => {}} />
        </Row>
        <Row label="Field">
          <Field label="Output folder" hint="Relative to your library">
            {(c) => <TextField {...c} defaultValue="Downloads" />}
          </Field>
          <Field label="Start" error="Must be before the end" required>
            {(c) => <TimecodeInput {...c} value="2:00.0" onChange={() => {}} />}
          </Field>
        </Row>
      </Section>

      <Section label="Progress">
        {statuses.map((s) => (
          <Row key={s} label={s}>
            <div className={styles.meterCell}>
              <Meter status={s} value={s === "done" ? 1 : s === "queued" ? 0 : 0.42} />
            </div>
            <StatusChip status={s} />
          </Row>
        ))}
        <Row label="indeterminate">
          <div className={styles.meterCell}>
            <Meter status="running" value={-1} />
          </div>
        </Row>
        <Row label="small">
          <div className={styles.meterCell}>
            <Meter size="sm" value={0.7} />
          </div>
        </Row>
      </Section>

      <Section label="Display">
        <Row label="Badges">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="ok">OK</Badge>
          <Badge tone="warn">Warn</Badge>
          <Badge tone="danger">Danger</Badge>
          <Badge mono>v2026.10</Badge>
        </Row>
        <Row label="Kbd">
          <Kbd combo="Mod+K" />
          <Kbd combo="Mod+Shift+Enter" />
          <Kbd combo="Escape" />
        </Row>
        <Row label="Tooltip">
          <Tooltip label="Hover for 400 ms">
            <Button variant="ghost">Hover me</Button>
          </Tooltip>
          <Spinner />
        </Row>
        <Row label="Path">
          <div className={styles.pathCell}>
            <PathText copy path="C:\Users\nick\Toolbox\Downloads\Some Artist - An Extremely Long Track Name (Remastered 2026).m4a" />
          </div>
        </Row>
        <Row label="Icons">
          {iconNames.map((n) => (
            <Tooltip key={n} label={n}>
              <span className={styles.iconCell}>
                <Icon name={n} />
              </span>
            </Tooltip>
          ))}
          <Tooltip label="unknown falls back to box">
            <span className={styles.iconCell}>
              <Icon name="definitely-not-an-icon" />
            </span>
          </Tooltip>
        </Row>
      </Section>

      <Section label="Banners">
        <Banner tone="info" title="Heads up">
          yt-dlp updates are checked weekly.
        </Banner>
        <Banner tone="warn" title="ffmpeg not found" action={<Button size="sm">Install</Button>}>
          Some formats are unavailable.
        </Banner>
        <Banner tone="danger" title="Download failed" action={<Button size="sm">Retry</Button>}>
          The server returned HTTP 403.
        </Banner>
      </Section>

      <Section label="Files">
        <DropZone id="gallery-drop" hint="Audio, video or images">
          <Button size="sm">Browse</Button>
        </DropZone>
        <FileList
          aria-label="Selected files"
          files={files}
          onRemove={(p) => setFiles((fs) => fs.filter((f) => f.path !== p))}
          empty="No files"
        />
        <FileList files={[]} empty="No files selected" />
      </Section>

      <Section label="Empty state">
        <EmptyState
          icon="download"
          title="Nothing downloaded yet"
          body="Paste a link above to start."
          action={<Button variant="primary">Paste URL</Button>}
        />
        <EmptyState size="lg" icon="wand-sparkles" title="Coming soon" body="This tool is not available yet." />
      </Section>

      <Section label="Toasts">
        <Row label="Fire">
          <Button onClick={() => toast({ title: "Saved" })}>Neutral</Button>
          <Button onClick={() => toast({ title: "Download complete", description: "track.m4a", tone: "success", action: { label: "Show in folder", onClick: () => {} } })}>
            Success
          </Button>
          <Button onClick={() => toast({ title: "Low disk space", tone: "warn" })}>Warn</Button>
          <Button onClick={() => toast({ title: "Download failed", description: "HTTP 403", tone: "danger" })}>Danger</Button>
        </Row>
      </Section>
      <Toaster />
    </div>
  );
}
