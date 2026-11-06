import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner, Button, ClickIn, ClickInHost, EmptyState, toast, useClickIn, type SelectOption } from "@/components";
import { ToolHeader } from "@/components/ToolHeader";
import {
  ChatBackend,
  ChatServerState,
  ChatService,
  ErrorCode,
  LibraryService,
  type ChatConversation,
  type ChatDone,
  type ChatModelInfo,
  type ChatSendResult,
  type ChatStatus,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useEmbed, useToolHandoff } from "@/lib/embed";
import { on } from "@/lib/events";
import { revealLabel } from "@/lib/platform";
import { useSettings } from "@/state/settings";
import type { TextSeed } from "@/state/ui";
import type { ToolViewProps } from "@/tools";
import { DepsGate, setRequiresOverride, useDepsGate } from "../_kit";
import { ChatSettingsDrawer } from "./ChatSettingsDrawer";
import { Composer } from "./Composer";
import { ContextCard, withContext } from "./ContextCard";
import { ConversationList, type ConversationListProps } from "./ConversationList";
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

/** The conversation list inside its click-in (embedded chat): choosing one closes the drawer. */
function CompactList(p: ConversationListProps) {
  const { close } = useClickIn();
  return <ConversationList {...p} onSelect={(id) => { p.onSelect(id); close(); }} onNew={() => { p.onNew(); close(); }} />;
}

export default function ChatView({ moduleId }: ToolViewProps) {
  const embedded = useEmbed() !== null;
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
  const [status, setStatus] = useState<ChatStatus>(EMPTY_STATUS);
  /** Text a tool handed over: sent with the first message as context. */
  const [seed, setSeed] = useState<TextSeed | null>(null);

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
    setSeed(null);
    try {
      const view = await ChatService.Conversation(id);
      setActive(view.conversation);
      await thread.load(id);
    } catch (e) {
      fail(e);
    }
  };

  const newChat = () => {
    setSeed(null);
    setActiveId(null);
    setActive(null);
    thread.clear();
  };

  // A tool handed over text (OCR, transcript, clipboard): a fresh conversation about it.
  useToolHandoff(moduleId, (h) => {
    if (!h.text) return;
    setActiveId(null);
    setActive(null);
    thread.clear();
    setSeed(h.text);
  });

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

  const send = async (text: string): Promise<boolean> => {
    // The first message carries the handed-over text as context ahead of the question.
    const withText = seed && messages.length === 0 ? withContext(seed, text) : text;
    const ok = await run((id) => ChatService.Send(id, withText), { userText: text });
    return ok;
  };
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

  const savePrompt = async (text: string): Promise<boolean> => {
    if (!active) {
      setDraftPrompt(text);
      return true;
    }
    try {
      setActive(await ChatService.UpdateConversation(active.id, { title: null, model: null, systemPrompt: text }));
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
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
      toast({
        title: "Chat exported",
        description: path,
        tone: "success",
        action: { label: revealLabel, onClick: () => void LibraryService.RevealPath(path).catch(fail) },
      });
    } catch (e) {
      fail(e);
    }
  };

  const modelOptions: SelectOption<string>[] = installed.map((m) => ({
    value: m.id,
    label: m.ollama ? `${m.label} (via Ollama)` : m.label,
  }));
  if (modelId && !installed.some((m) => m.id === modelId)) modelOptions.unshift({ value: modelId, label: modelId });

  const listProps: ConversationListProps = {
    items: convs,
    activeId,
    search,
    onSearch: setSearch,
    onSelect: (id) => void select(id),
    onNew: newChat,
    newDisabled: noModel,
    onRename: (id, t) => void rename(id, t),
    onDelete: (id) => void remove(id),
    onExport: (id) => void exportChat(id),
    hasMore: nextCursor !== "",
    onMore: () => void loadList(search, nextCursor),
  };
  const prompts = seed && messages.length === 0 ? (seed.prompts ?? []) : [];

  return (
    <ClickInHost>
    <div className={embedded ? styles.rootCompact : styles.root}>
      {embedded ? (
        <div className={styles.compactBar}>
          <ClickIn icon="message-square" title="Conversations" summary={active?.title || "New chat"} tip="Switch to an earlier conversation or start a new one" width={300}>
            <CompactList {...listProps} />
          </ClickIn>
        </div>
      ) : (
        <ConversationList {...listProps} />
      )}
      <section className={styles.main} aria-label="Chat">
        {!noModel && (
          <ToolHeader className={styles.headerBar} aria-label="Chat">
            <ChatSettingsDrawer
              modelId={modelId}
              modelOptions={modelOptions}
              temperature={defaults.temperature}
              prompt={active ? active.systemPrompt : draftPrompt}
              defaultPrompt={defaults.systemPrompt}
              onModel={(v) => void changeModel(v)}
              onSavePrompt={savePrompt}
            />
          </ToolHeader>
        )}
        <div className={styles.gate}>
          <DepsGate moduleId={moduleId} />
        </div>
        {status.state === ChatServerState.ChatError && (
          <Banner tone="danger" title="The chat engine had a problem">
            {status.error}
          </Banner>
        )}
        {status.notice && <Banner tone="info">{status.notice}</Banner>}

        {seed && <ContextCard seed={seed} onRemove={messages.length === 0 ? () => setSeed(null) : undefined} />}
        {noModel && modelsLoaded ? (
          <div className={styles.empty}>
            <div className={styles.emptyHead}>
              <h2 className={styles.emptyTitle}>Download a model to start chatting</h2>
              <p className={styles.emptyBody}>Models run on this computer. Nothing you write leaves it.</p>
            </div>
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

        {thread.trimmed && <p className={styles.trimmed} data-tip="The model can only read so much; the oldest messages were skipped when answering">Older messages were left out to fit the context</p>}
        {prompts.length > 0 && (
          <div className={styles.chips} role="group" aria-label="Suggested prompts">
            {prompts.map((q) => (
              <Button key={q} size="sm" variant="secondary" disabled={blocked || loading} data-tip={`Ask: ${q}`} onClick={() => void send(q)}>
                {q}
              </Button>
            ))}
          </div>
        )}
        <Composer
          loading={loading}
          blocked={blocked}
          blockedReason={blockedReason}
          generating={generating}
          busy={status.busy}
          onSend={send}
          onStop={stop}
        />
      </section>
    </div>
    </ClickInHost>
  );
}
