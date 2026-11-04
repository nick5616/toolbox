import { useState } from "react";
import { Button, ClickIn, Select, TextArea, type SelectOption } from "@/components";
import { useClickIn } from "@/components/ClickIn";
import styles from "./Chat.module.css";

/** "precise" / "balanced" / "creative" for a temperature, so the summary reads like a mode. */
export function temperatureWord(t: number): string {
  if (t < 0.4) return "precise";
  if (t <= 0.9) return "balanced";
  return "creative";
}

/** The one-line state shown on the Chat settings row: "Qwen3 4B · creative". */
export function chatSummary(modelLabel: string, temperature: number): string {
  return [modelLabel, temperatureWord(temperature)].filter(Boolean).join(" · ");
}

interface Props {
  modelId: string;
  modelOptions: SelectOption<string>[];
  temperature: number;
  /** The conversation's system prompt, or the draft for a new chat. */
  prompt: string;
  /** Shown as the placeholder (the default from Settings → Chat). */
  defaultPrompt: string;
  onModel: (id: string) => void;
  onSavePrompt: (text: string) => Promise<boolean>;
}

/** Model, system prompt and answer style in one click-in; replaces the old top bar and inline prompt panel. */
export function ChatSettingsDrawer(props: Props) {
  const label = props.modelOptions.find((o) => o.value === props.modelId)?.label ?? props.modelId;
  return (
    <ClickIn
      icon="settings-2"
      title="Chat settings"
      summary={chatSummary(label, props.temperature)}
      tip="Model, system prompt and answer style for this conversation"
      className={styles.settingsRow}
      width={380}
    >
      <Body {...props} />
    </ClickIn>
  );
}

function Body({ modelId, modelOptions, temperature, prompt, defaultPrompt, onModel, onSavePrompt }: Props) {
  const [text, setText] = useState(prompt);
  const { close } = useClickIn();
  return (
    <div className={styles.drawerBody}>
      <label className={styles.promptLabel} htmlFor="chat-model">
        Model
      </label>
      {modelOptions.length > 0 && (
        <Select<string>
          id="chat-model"
          aria-label="Model"
          data-tip="The model that answers in this conversation"
          value={modelId}
          options={modelOptions}
          onChange={onModel}
        />
      )}
      <label className={styles.promptLabel} htmlFor="chat-system-prompt">
        System prompt for this conversation
      </label>
      <TextArea
        id="chat-system-prompt"
        data-tip="Instructions the assistant follows for the whole conversation"
        value={text}
        minRows={4}
        maxLength={4000}
        placeholder={defaultPrompt}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.promptFoot}>
        <span className={styles.hint}>
          Answer style: {temperatureWord(temperature)} (temperature {temperature.toFixed(2)}). Change it in Settings → Chat.
        </span>
        <Button
          size="sm"
          variant="primary"
          data-tip="Use this system prompt for this conversation"
          onClick={() =>
            void onSavePrompt(text).then((ok) => {
              if (ok) close();
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}
