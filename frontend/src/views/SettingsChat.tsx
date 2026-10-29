import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ConfirmDialog, Field, Section, Select, Slider, Switch, TextArea, TextField, toast } from "@/components";
import { ChatService, type ChatModelInfo, type ChatSettings } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatSize } from "@/views/setup/packSizes";
import { useSettings } from "@/state/settings";
import { ModelCards } from "@/tools/chat/ModelCards";
import styles from "./SettingsChat.module.css";

const CONTEXT_SIZES = ["4096", "8192", "16384", "32768"].map((v) => ({ value: v, label: `${Number(v).toLocaleString("en-US")} tokens` }));

type TestResult = { tone: "ok" | "warn"; text: string } | null;

/** Settings → Chat (SPEC §4.5). */
export function SettingsChat() {
  const chat = useSettings((s) => s.settings.chat);
  const [prompt, setPrompt] = useState(chat.systemPrompt);
  const [temp, setTemp] = useState(chat.temperature);
  const [url, setUrl] = useState(chat.ollamaURL);
  const [urlError, setUrlError] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult>(null);
  const [models, setModels] = useState<ChatModelInfo[]>([]);
  const [deleting, setDeleting] = useState<ChatModelInfo | null>(null);
  const tempTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(chat);
  latest.current = chat;

  const loadModels = useCallback(async () => {
    try {
      setModels((await ChatService.Catalog()) ?? []);
    } catch {
      setModels([]);
    }
  }, []);
  useEffect(() => {
    void loadModels();
    return () => clearTimeout(tempTimer.current);
  }, [loadModels]);

  const save = async (patch: Partial<ChatSettings>): Promise<boolean> => {
    try {
      await useSettings.getState().update({ chat: { ...latest.current, ...patch } });
      return true;
    } catch (e) {
      const err = toAppError(e);
      if (patch.ollamaURL !== undefined) setUrlError(err.fields?.ollamaURL ?? err.message);
      else toast({ tone: "danger", title: err.message, description: err.hint });
      return false;
    }
  };

  const saveUrl = async (): Promise<boolean> => {
    const next = url.trim();
    if (next === chat.ollamaURL) {
      setUrlError("");
      return true;
    }
    const ok = await save({ ollamaURL: next });
    if (ok) setUrlError("");
    return ok;
  };

  const testOllama = async () => {
    setTesting(true);
    setResult(null);
    try {
      if (!(await saveUrl())) return;
      if (!url.trim()) {
        setResult({ tone: "warn", text: "Enter a URL such as http://127.0.0.1:11434 first." });
        return;
      }
      const list = (await ChatService.Catalog()) ?? [];
      setModels(list);
      const n = list.filter((m) => m.ollama).length;
      setResult(
        n > 0
          ? { tone: "ok", text: `Connected. ${n} Ollama model${n === 1 ? "" : "s"} found.` }
          : { tone: "warn", text: "No Ollama models found. Is Ollama running at that address?" },
      );
    } catch (e) {
      setResult({ tone: "warn", text: toAppError(e).message });
    } finally {
      setTesting(false);
    }
  };

  const changeTemp = (v: number) => {
    setTemp(v);
    clearTimeout(tempTimer.current);
    tempTimer.current = setTimeout(() => void save({ temperature: v }), 400);
  };

  const remove = async (m: ChatModelInfo) => {
    setDeleting(null);
    try {
      await ChatService.DeleteModel(m.id);
      toast({ title: `${m.label} deleted` });
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
    await loadModels();
  };

  const installed = models.filter((m) => m.installed && !m.ollama);
  const choices = models.filter((m) => m.installed);
  const modelOptions = choices.map((m) => ({ value: m.id, label: m.ollama ? `${m.label} (via Ollama)` : m.label }));
  if (!choices.some((m) => m.id === chat.defaultModel)) modelOptions.unshift({ value: chat.defaultModel, label: chat.defaultModel });

  return (
    <Section label="Chat">
      <div className={styles.stack}>
        <Field label="Default model">
          {(c) => <Select<string> {...c} value={chat.defaultModel} options={modelOptions} onChange={(v) => void save({ defaultModel: v })} />}
        </Field>

        <Field label="System prompt" hint="Used for new conversations. Up to 4,000 characters.">
          {(c) => (
            <TextArea
              {...c}
              value={prompt}
              minRows={3}
              maxLength={4000}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt !== chat.systemPrompt && void save({ systemPrompt: prompt })}
            />
          )}
        </Field>

        <Field label="Temperature">
          {(c) => <Slider id={c.id} min={0} max={2} step={0.05} value={temp} onChange={changeTemp} format={(v) => v.toFixed(2)} />}
        </Field>

        <Field label="Context size">
          {(c) => (
            <Select<string>
              {...c}
              value={String(chat.contextSize)}
              options={CONTEXT_SIZES}
              onChange={(v) => void save({ contextSize: Number(v) })}
            />
          )}
        </Field>

        <Switch checked={chat.gpu} onChange={(gpu) => void save({ gpu })} label="Use GPU" />

        <Field label="Ollama URL" error={urlError} hint="Optional. Leave empty to use only the built-in models.">
          {(c) => (
            <div className={styles.urlRow}>
              <TextField
                {...c}
                mono
                placeholder="http://127.0.0.1:11434"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => void saveUrl()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveUrl();
                }}
              />
              <Button size="sm" variant="secondary" loading={testing} onClick={() => void testOllama()}>
                Test
              </Button>
            </div>
          )}
        </Field>
        {result && (
          <p className={result.tone === "ok" ? styles.ok : styles.warn} role="status">
            {result.text}
          </p>
        )}
        <p className={styles.note}>Ollama has no access control; any app on this computer can use it.</p>

        <div className={styles.models}>
          <h4 className={styles.subtitle}>Installed models</h4>
          {installed.length === 0 ? (
            <p className={styles.note}>No models downloaded yet.</p>
          ) : (
            <ul className={styles.list}>
              {installed.map((m) => (
                <li key={m.id} className={styles.modelRow}>
                  <span className={styles.modelName}>{m.label}</span>
                  <span className={styles.size}>{formatSize(m.bytes)}</span>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${m.label}`} onClick={() => setDeleting(m)}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ModelCards models={models} onChanged={() => void loadModels()} />
      </div>
      <ConfirmDialog
        open={deleting !== null}
        tone="danger"
        title={deleting ? `Delete ${deleting.label}?` : "Delete model?"}
        body={deleting ? `This frees ${formatSize(deleting.bytes)}. You can download it again later.` : undefined}
        confirmLabel="Delete"
        onConfirm={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </Section>
  );
}
