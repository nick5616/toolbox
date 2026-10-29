import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner, Button, EmptyState, IconButton, Select, TextArea, toast, type SelectOption } from "@/components";
import {
  ChatBackend,
  ChatServerState,
  ChatService,
  ErrorCode,
  type ChatConversation,
  type ChatDone,
  type ChatModelInfo,
  type ChatSendResult,
  type ChatStatus,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { on } from "@/lib/events";
import { useSettings } from "@/state/settings";
import type { ToolViewProps } from "@/tools";
import { DepsGate, setRequiresOverride, useDepsGate } from "../_kit";
import { Composer } from "./Composer";
import { ConversationList } from "./ConversationList";
import { ModelCards } from "./ModelCards";
import { Thread } from "./Thread";
import { isOllamaModel } from "./grouping";
import { isStreaming, useThread, type BeginOptions } from "./useThread";
import styles from "./Chat.module.css";

export const LLAMA_RUNTIME_ID = "llama-runtime";
const EMPTY_STATUS: ChatStatus = { state: ChatServerState.ChatStopped, model: "", backend: ChatBackend.$zero, error: "", notice: "", busy: "" };

function backendLabel(b: ChatBackend): string {
  if (b === ChatBackend.ChatBackendGPU) return "GPU";
  if (b === ChatBackend.ChatBackendCPU) return "CPU";
  if (b === ChatBackend.ChatBackendOllama) return "Ollama";
  return "";
}

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({
    title: err.message,
    description: err.hint,
    tone: err.code === ErrorCode.CodeConflict ? "warn" : "danger",
  });
}

export default function ChatView({ moduleId }: ToolViewProps) {
  const defaults = useSettings((s) => s.settings.chat);

  const [models, setModels] = useState<ChatModelInfo[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [convs, setConvs] = useState<ChatConversation[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [status, setStatus] = useState<ChatStatus>(EMPTY_STATUS);

  const loadList = useCallback(async (q: string, cursor: string) => {
    try {
      const page = await ChatService.Conversations(q, cursor);
      const items = page.items ?? [];
      setConvs((cur) => (cursor ? [...cur, ...items] : items));
      setNextCursor(page.nextCursor);
    } catch (e) {
      fail(e);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      setModels((await ChatService.Catalog()) ?? []);
    } catch (e) {
      fail(e);
    } finally {
      setModelsLoaded(true);
    }
  }, []);

  const refreshList = useCallback(() => void loadList(search, ""), [loadList, search]);
  const onDone = useCallback(
    (_d: ChatDone) => {
      refreshList();
    },
    [refreshList],
  );
  const thread = useThread(activeId, onDone);
  const { messages } = thread;

  useEffect(() => {
    void loadModels();
    ChatService.Status().then(setStatus, () => undefined);
    return on("chat:status", setStatus);
  }, [loadModels]);

  useEffect(() => {
    const t = setTimeout(() => void loadList(search, ""), search.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [search, loadList]);

  const installed = useMemo(() => models.filter((m) => m.installed), [models]);
  const modelId = active?.model ?? draftModel;
  const local = !isOllamaModel(modelId) && modelId !== "";

  useEffect(() => {
    if (draftModel || installed.length === 0) return;
    const pref = installed.find((m) => m.id === defaults.defaultModel) ?? installed[0];
    if (pref) setDraftModel(pref.id);
  }, [installed, draftModel, defaults.defaultModel]);

  // The chat engine is only needed for local models (SPEC §4.5).
  useEffect(() => {
    setRequiresOverride(moduleId, isOllamaModel(modelId) ? null : [LLAMA_RUNTIME_ID]);
    return () => setRequiresOverride(moduleId, null);
  }, [moduleId, modelId]);
  const gate = useDepsGate(moduleId);

  const generating = messages.some(isStreaming);
  const loading = status.state === ChatServerState.ChatStarting;
  const noModel = installed.length === 0;
  const blocked = noModel || (gate.blocked && local) || (modelsLoaded && !modelId);
  const blockedReason = noModel ? "Download a model to start" : gate.blocked && local ? gate.reason : undefined;

  const select = async (id: string) => {
    setActiveId(id);
    setShowPrompt(false);
    try {
      const view = await ChatService.Conversation(id);
      setActive(view.conversation);
      await thread.load(id);
    } catch (e) {
      fail(e);
    }
  };

  const newChat = () => {
    setActiveId(null);
    setActive(null);
    setShowPrompt(false);
    thread.clear();
  };

  const ensureConversation = async (): Promise<ChatConversation> => {
    if (active) return active;
    let c = await ChatService.NewConversation(modelId);
    if (draftPrompt.trim()) {
      c = await ChatService.UpdateConversation(c.id, { title: null, model: null, systemPrompt: draftPrompt });
    }
    setActive(c);
    setActiveId(c.id);
    thread.clear();
    return c;
  };

  const run = async (fn: (id: string) => Promise<ChatSendResult>, opts: BeginOptions): Promise<boolean> => {
    try {
      const c = await ensureConversation();
      const res = await fn(c.id);
      thread.begin(c.id, res, opts);
      refreshList();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const send = (text: string) => run((id) => ChatService.Send(id, text), { userText: text });
  const retry = () => void run((id) => ChatService.Regenerate(id), { dropLastAssistant: true });
  const edit = (messageId: string, text: string) =>
    void run((id) => ChatService.EditAndResend(id, messageId, text), { userText: text, truncateFrom: messageId });
  const stop = () => {
    if (activeId) void ChatService.Stop(activeId).catch(fail);
  };

  const changeModel = async (id: string) => {
    if (!active) {
      setDraftModel(id);
      return;
    }
    try {
      setActive(await ChatService.UpdateConversation(active.id, { title: null, model: id, systemPrompt: null }));
    } catch (e) {
      fail(e);
    }
  };

  const savePrompt = async () => {
    if (!active) {
      setDraftPrompt(promptText);
      setShowPrompt(false);
      return;
    }
    try {
      setActive(await ChatService.UpdateConversation(active.id, { title: null, model: null, systemPrompt: promptText }));
      setShowPrompt(false);
    } catch (e) {
      fail(e);
    }
  };

  const togglePrompt = () => {
    if (!showPrompt) setPromptText(active ? active.systemPrompt : draftPrompt);
    setShowPrompt((v) => !v);
  };

  const rename = async (id: string, title: string) => {
    try {
      const c = await ChatService.UpdateConversation(id, { title, model: null, systemPrompt: null });
      if (active?.id === id) setActive(c);
      refreshList();
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (id: string) => {
    try {
      await ChatService.DeleteConversation(id);
      if (activeId === id) newChat();
      refreshList();
    } catch (e) {
      fail(e);
    }
  };

  const exportChat = async (id: string) => {
    try {
      const path = await ChatService.Export(id);
      toast({ title: "Chat exported", description: path, tone: "success" });
    } catch (e) {
      fail(e);
    }
  };

  const modelOptions: SelectOption<string>[] = installed.map((m) => ({
    value: m.id,
    label: m.ollama ? `${m.label} (via Ollama)` : m.label,
  }));
  if (modelId && !installed.some((m) => m.id === modelId)) modelOptions.unshift({ value: modelId, label: modelId });

  return (
    <div className={styles.root}>
      <ConversationList
        items={convs}
        activeId={activeId}
        search={search}
        onSearch={setSearch}
        onSelect={(id) => void select(id)}
        onNew={newChat}
        onRename={(id, t) => void rename(id, t)}
        onDelete={(id) => void remove(id)}
        onExport={(id) => void exportChat(id)}
        hasMore={nextCursor !== ""}
        onMore={() => void loadList(search, nextCursor)}
      />
      <section className={styles.main} aria-label="Chat">
        <header className={styles.topbar}>
          {modelOptions.length > 0 && (
            <Select<string>
              size="sm"
              aria-label="Model"
              value={modelId}
              options={modelOptions}
              onChange={(v) => void changeModel(v)}
            />
          )}
          <span className={styles.spacer} />
          <IconButton
            icon="settings"
            label="Chat settings"
            pressed={showPrompt}
            onClick={togglePrompt}
            disabled={noModel}
          />
        </header>
        {showPrompt && (
          <div className={styles.promptPanel}>
            <label className={styles.promptLabel} htmlFor="chat-system-prompt">
              System prompt for this conversation
            </label>
            <TextArea
              id="chat-system-prompt"
              value={promptText}
              minRows={3}
              maxLength={4000}
              placeholder={defaults.systemPrompt}
              onChange={(e) => setPromptText(e.target.value)}
            />
            <div className={styles.promptFoot}>
              <span className={styles.hint}>Temperature is set in Settings → Chat.</span>
              <Button size="sm" variant="primary" onClick={() => void savePrompt()}>
                Save
              </Button>
            </div>
          </div>
        )}
        <DepsGate moduleId={moduleId} />
        {status.state === ChatServerState.ChatError && (
          <Banner tone="danger" title="The chat engine had a problem">
            {status.error}
          </Banner>
        )}
        {status.notice && <Banner tone="info">{status.notice}</Banner>}

        {noModel && modelsLoaded ? (
          <div className={styles.empty}>
            <EmptyState
              icon="message-square"
              title="Download a model to start chatting"
              body="Models run on this computer. Nothing you write leaves it."
            />
            <ModelCards models={models} onChanged={() => void loadModels()} />
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState icon="message-square" title="Start a conversation" body="Answers are generated on this computer." />
          </div>
        ) : (
          <Thread
            messages={messages}
            busy={generating}
            backendLabel={backendLabel(status.backend)}
            onRetry={retry}
            onEdit={edit}
          />
        )}

        {thread.trimmed && <p className={styles.trimmed}>Older messages were left out to fit the context</p>}
        <Composer
          loading={loading}
          blocked={blocked}
          blockedReason={blockedReason}
          generating={generating}
          onSend={send}
          onStop={stop}
        />
      </section>
    </div>
  );
}
