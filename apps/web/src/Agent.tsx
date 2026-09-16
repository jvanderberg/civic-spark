import { ArrowDown, GitCompareArrows, LoaderCircle, Paperclip, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { retainEvent } from "../../../packages/agents/src/history.ts";
import {
  type AgentImage,
  agentImagesSchema,
  imageCountLimit,
} from "../../../packages/agents/src/images.ts";
import {
  type AgentEvent,
  type AgentInput,
  agentModels,
} from "../../../packages/agents/src/protocol.ts";
import { AgentImages, readAgentImage } from "./AgentImages.tsx";
import { AgentTimeline } from "./AgentTimeline.tsx";
import { api } from "./api.ts";
import { Button } from "./vendor/t3code/Button.tsx";
import { ComposerBanner } from "./vendor/t3code/ComposerBanner.tsx";
import { ComposerPrimaryActions } from "./vendor/t3code/ComposerPrimaryActions.tsx";
import { ComposerSurface } from "./vendor/t3code/ComposerSurface.tsx";
import { type QuestionOption, QuestionOptions } from "./vendor/t3code/QuestionOptions.tsx";

function singleChoiceQuestion(
  event: AgentEvent | undefined,
): { question: string; options: QuestionOption[] } | null {
  if (!event) return null;
  try {
    const value = JSON.parse(event.details ?? "null");
    const questions = Array.isArray(value) ? value : value?.questions;
    const question = questions?.length === 1 ? questions[0] : null;
    return question &&
      !question.multiSelect &&
      typeof question.question === "string" &&
      Array.isArray(question.options) &&
      question.options.every((option: QuestionOption) => typeof option.label === "string")
      ? question
      : null;
  } catch {
    return null;
  }
}

function questionText(event: AgentEvent) {
  try {
    const value = JSON.parse(event.details ?? "null");
    const questions = Array.isArray(value) ? value : value?.questions;
    if (Array.isArray(questions))
      return questions
        .map(
          (question: { question?: string; options?: { label: string; description?: string }[] }) =>
            [
              question.question,
              question.options
                ?.map(
                  (option) =>
                    `${option.label}${option.description ? ` — ${option.description}` : ""}`,
                )
                .join("\n"),
            ]
              .filter(Boolean)
              .join("\n\n"),
        )
        .join("\n\n");
  } catch {
    // Older runners may send a plain-text question.
  }
  return event.details || event.text;
}

export function Agent({
  workspace,
  available,
  visible,
  dirty,
  onUpdated,
  onOpenFile,
  onReview,
  request,
  onRequestSent,
  onRequestFinished,
  onRequestCancelled,
  onWorkingChange,
}: {
  workspace: string;
  available: boolean;
  visible: boolean;
  dirty: boolean;
  onUpdated: () => void;
  onOpenFile: (path: string) => void;
  onReview: () => void;
  request?: { id: string; prompt: string };
  onRequestSent?: (id: string) => void;
  onRequestFinished?: (id: string) => void;
  onRequestCancelled?: (id: string) => void;
  onWorkingChange?: (working: boolean) => void;
}) {
  const socket = useRef<WebSocket | null>(null);
  const [settings, setSettings] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const stickToBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerBottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bottom = composerBottom.current;
    if (!bottom) return;
    const resize = new ResizeObserver(() => {
      bottom.parentElement?.style.setProperty(
        "--chat-bottom-height",
        `${bottom.getBoundingClientRect().height}px`,
      );
    });
    resize.observe(bottom);
    return () => resize.disconnect();
  }, []);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [provider, setProvider] = useState<"claude" | "opencode">(() => {
    try {
      return localStorage.getItem(`civic-spark:workspace:${workspace}:agent`) === "claude"
        ? "claude"
        : "opencode";
    } catch {
      return "opencode";
    }
  });
  const [configured, setConfigured] = useState<string[]>([]);
  // Saved credentials are independent of the socket and runtime readiness.
  // Unknown during startup must never masquerade as a missing key.
  const [savedProviders, setSavedProviders] = useState<string[]>([]);
  const [credentialsKnown, setCredentialsKnown] = useState(false);
  const savedReconnectSupported = useRef(false);
  const [failedProviders, setFailedProviders] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const log = useRef<HTMLDivElement | null>(null);
  const pendingKey = useRef<{
    provider: "claude" | "opencode";
    key: string;
    workspaceId?: string;
  } | null>(null);
  const [key, setKey] = useState("");
  const configuringProvider = useRef<"claude" | "opencode" | null>(null);
  const [claudeWorkspaceId, setClaudeWorkspaceId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AgentImage[]>([]);
  const imagesRef = useRef<AgentImage[]>([]);
  imagesRef.current = images;
  const fileInput = useRef<HTMLInputElement>(null);
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const submittedImages = useRef<{
    id: string;
    text: string;
    images: AgentImage[];
    failed: boolean;
    acknowledged: boolean;
  } | null>(null);
  const [imageSending, setImageSending] = useState(false);
  async function addImages(files: File[]) {
    if (readingImagesRef.current || imageSending) return;
    if (imagesRef.current.length + files.length > imageCountLimit) {
      setError("Attach up to 4 images per message.");
      return;
    }
    readingImagesRef.current = true;
    setReadingImages(true);
    try {
      const additions: AgentImage[] = [];
      for (const file of files) additions.push(await readAgentImage(file));
      const parsed = agentImagesSchema.safeParse([...imagesRef.current, ...additions]);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid images.");
      if (mounted.current) {
        setImages(parsed.data);
        setError("");
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "Could not attach images.");
    } finally {
      readingImagesRef.current = false;
      if (mounted.current) setReadingImages(false);
    }
  }
  function finishImages(success: boolean) {
    const sent = submittedImages.current;
    if (!sent) return;
    if (success && !sent.failed) {
      setPrompt((draft) => (draft === sent.text ? "" : draft));
      setImages((draft) =>
        draft.filter((image) => !sent.images.some((old) => old.id === image.id)),
      );
    }
    submittedImages.current = null;
    setImageSending(false);
  }
  const [pendingRequest, setPendingRequest] = useState<{
    id: string;
    prompt: string;
    staged: boolean;
    previousDraft: string;
  } | null>(null);
  const seenRequests = useRef(new Set<string>());
  const activeRequest = useRef<{ id: string; prompt: string; started: boolean } | null>(null);
  const requestCallbacks = useRef({
    onRequestSent,
    onRequestFinished,
    onRequestCancelled,
    onWorkingChange,
  });
  requestCallbacks.current = {
    onRequestSent,
    onRequestFinished,
    onRequestCancelled,
    onWorkingChange,
  };
  const [connected, setConnected] = useState(false);
  const [working, setWorking] = useState(false);
  const [workingStartedAt, setWorkingStartedAt] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const [reconnecting, setReconnecting] = useState(0);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [resolved, setResolved] = useState<string[]>([]);
  const mounted = useRef(false);
  const connectionAttempt = useRef(0);
  const starting = useRef(false);
  const autoAttempted = useRef(false);
  const readyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const readySince = useRef(0);
  const activity = useRef({ available, visible });
  activity.current = { available, visible };
  const connectLatest = useRef<(retry?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    try {
      localStorage.setItem(`civic-spark:workspace:${workspace}:agent`, provider);
    } catch {
      // Only a nonsecret model preference is stored in the browser.
    }
  }, [provider, workspace]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingKey.current = null;
      configuringProvider.current = null;
      connectionAttempt.current += 1;
      starting.current = false;
      autoAttempted.current = false;
      if (readyTimeout.current) clearTimeout(readyTimeout.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (socket.current) {
        socket.current.onclose = null;
        socket.current.close();
      }
    };
  }, []);
  useEffect(() => {
    if (!available) {
      connectionAttempt.current += 1;
      starting.current = false;
      autoAttempted.current = false;
      if (readyTimeout.current) clearTimeout(readyTimeout.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (socket.current) {
        socket.current.onclose = null;
        socket.current.close();
        socket.current = null;
      }
      setPreparing(false);
      setConnected(false);
      setWorking(false);
      return;
    }
    if (!visible) {
      autoAttempted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setReconnecting(0);
    }
    if (visible && !autoAttempted.current) {
      autoAttempted.current = true;
      if (!starting.current && (!socket.current || socket.current.readyState > WebSocket.OPEN))
        queueMicrotask(() => {
          if (mounted.current) void connectLatest.current();
        });
    }
  }, [available, visible]);
  useEffect(() => {
    function online() {
      if (
        activity.current.available &&
        activity.current.visible &&
        (!socket.current || socket.current.readyState > WebSocket.OPEN)
      )
        void connectLatest.current();
    }
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  useEffect(() => {
    if (visible && events.length && stickToBottom.current)
      log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [events, visible]);
  function finishRequest() {
    const active = activeRequest.current;
    if (!active?.started) return;
    activeRequest.current = null;
    requestCallbacks.current.onRequestFinished?.(active.id);
  }
  function send(input: AgentInput) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(input));
  }
  function validateWorkspaceId() {
    const id = claudeWorkspaceId.trim();
    if (provider === "claude" && id && (!/^wrkspc_[A-Za-z0-9]+$/.test(id) || id.length > 128)) {
      setError("Enter a valid Anthropic workspace ID (it starts with wrkspc_). ");
      return false;
    }
    return true;
  }
  async function connect(retry = false) {
    if (starting.current || !available || !validateWorkspaceId()) return;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (!retry) {
      retryCount.current = 0;
      setReconnecting(0);
    }
    starting.current = true;
    const attempt = ++connectionAttempt.current;
    if (readyTimeout.current) clearTimeout(readyTimeout.current);
    setPreparing(true);
    pendingKey.current = key.trim()
      ? {
          provider,
          key: key.trim(),
          ...(provider === "claude" && claudeWorkspaceId.trim()
            ? { workspaceId: claudeWorkspaceId.trim() }
            : {}),
        }
      : null;
    if (socket.current) {
      socket.current.onclose = null;
      socket.current.close();
    }
    setConnected(false);
    setError("");
    try {
      await api(`/workspaces/${workspace}/agent/prepare`, "POST");
      if (!mounted.current || attempt !== connectionAttempt.current) return;
      const url = new URL(`/api/workspaces/${workspace}/agent`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const connection = new WebSocket(url);
      socket.current = connection;
      setEvents([]);
      setResolved([]);
      setWorking(false);
      readyTimeout.current = setTimeout(() => {
        if (socket.current !== connection || !mounted.current) return;
        connection.onclose = null;
        connection.close();
        setPreparing(false);
        setConnected(false);
        setError("The agent did not finish reconnecting. Retry to resume your saved session.");
      }, 45000);

      let replaying = true;
      connection.onmessage = (message) => {
        if (socket.current !== connection || !mounted.current) return;
        const event = JSON.parse(message.data) as AgentEvent;
        if (event.type === "user" && event.id === submittedImages.current?.id)
          submittedImages.current.acknowledged = true;
        if (
          event.type === "error" &&
          submittedImages.current &&
          ((!replaying && !event.replayed) || event.requestId === submittedImages.current.id)
        ) {
          submittedImages.current.failed = true;
          finishImages(false);
        }
        if (event.type === "done" && submittedImages.current?.acknowledged)
          finishImages(event.outcome === undefined || event.outcome === "success");
        if (event.type === "state") {
          if (event.runtimeReady && !event.working && submittedImages.current) finishImages(false);
          replaying = false;
          if (event.currentError !== undefined) setError(event.currentError ?? "");
          if (event.runtimeReady && event.working === false) finishRequest();
          setConnected(event.runtimeReady ?? false);
          setPreparing(!event.runtimeReady);
          setWorking(event.working ?? false);
          setWorkingStartedAt(event.working ? event.workingStartedAt : undefined);
          setConfigured(event.configuredProviders ?? []);
          if (event.savedProviders !== undefined) {
            savedReconnectSupported.current = true;
            setSavedProviders(event.savedProviders);
            setCredentialsKnown(true);
          } else if (event.runtimeReady) {
            // Older runners report verified credentials only. Preserve known
            // saved keys through temporary runtime failures.
            setSavedProviders((previous) => [
              ...new Set([...previous, ...(event.configuredProviders ?? [])]),
            ]);
            setCredentialsKnown(true);
          }
          if (event.failedProviders !== undefined) setFailedProviders(event.failedProviders);
          if (event.runtimeReady && readyTimeout.current) clearTimeout(readyTimeout.current);
          if (event.runtimeReady) {
            readySince.current = Date.now();
            setReconnecting(0);
          }
          if (event.runtimeReady && pendingKey.current) {
            configuringProvider.current = pendingKey.current.provider;
            send({ type: "configure", ...pendingKey.current });
            pendingKey.current = null;
            setChecking(true);
          }
          return;
        }
        if (event.type === "ready") {
          replaying = false;
          if (readyTimeout.current) clearTimeout(readyTimeout.current);
          setConnected(true);
          setPreparing(false);
          readySince.current = Date.now();
          setReconnecting(0);
          if (pendingKey.current) {
            configuringProvider.current = pendingKey.current.provider;
            send({ type: "configure", ...pendingKey.current });
            pendingKey.current = null;
            setChecking(true);
          }
        }
        if (event.type === "configured") {
          if (configuringProvider.current === event.id) {
            setKey("");
            configuringProvider.current = null;
          }
          setConfigured((previous) => [...new Set([...previous, event.id])]);
          setSavedProviders((previous) => [...new Set([...previous, event.id])]);
          setFailedProviders((previous) => previous.filter((item) => item !== event.id));
          setChecking(false);
          setSettings(false);
          setError("");
        }
        const live = !replaying && !event.replayed;
        if (live && event.type === "user" && activeRequest.current?.prompt === event.text) {
          activeRequest.current.started = true;
        }
        if (live && event.type === "error") {
          finishRequest();
          setError(event.text);
          const failed = event.provider ?? configuringProvider.current;
          if (failed && (event.credentialFailure || configuringProvider.current))
            setFailedProviders((previous) => [...new Set([...previous, failed])]);
          configuringProvider.current = null;
          setChecking(false);
          setWorking(false);
          setWorkingStartedAt(undefined);
        }
        if (live && event.type === "status" && event.text === "Working") {
          setWorking(true);
          setWorkingStartedAt((previous) => event.workingStartedAt ?? previous);
        }
        if (live && event.type === "done") {
          finishRequest();
          setWorking(false);
          onUpdated();
        }
        if (event.type === "resolved") setResolved((ids) => [...ids, event.id]);
        setEvents((previous) => {
          const next = [...previous];
          retainEvent(next, event);
          return next;
        });
      };
      connection.onclose = (closed) => {
        if (socket.current !== connection) return;
        if (readyTimeout.current) clearTimeout(readyTimeout.current);
        pendingKey.current = null;
        setChecking(false);
        setConnected(false);
        setPreparing(false);
        setWorking(false);
        setImageSending(false);
        if (readySince.current && Date.now() - readySince.current > 30000) retryCount.current = 0;
        readySince.current = 0;
        const canRetry =
          activity.current.available &&
          activity.current.visible &&
          ![1008, 4001, 4003, 4401, 4403].includes(closed.code) &&
          retryCount.current < 3;
        if (canRetry) {
          const next = ++retryCount.current;
          setReconnecting(next);
          setError("");
          retryTimer.current = setTimeout(
            () => {
              if (mounted.current && activity.current.available && activity.current.visible)
                void connectLatest.current(true);
            },
            1000 * 2 ** (next - 1),
          );
        } else {
          setReconnecting(0);
          setError(
            [1008, 4001, 4003, 4401, 4403].includes(closed.code)
              ? "This session no longer has workspace access. Sign in again to continue."
              : "Could not reconnect to the agent. Retry to resume your saved conversation and session.",
          );
        }
      };
      connection.onerror = () => {
        // The close event schedules bounded retry or reports a final error.
      };
    } catch (e) {
      if (!mounted.current || attempt !== connectionAttempt.current) return;
      setError(e instanceof Error ? e.message : "Could not prepare agent");
      setPreparing(false);
      setReconnecting(0);
    } finally {
      if (attempt === connectionAttempt.current) starting.current = false;
    }
  }
  connectLatest.current = connect;
  const hasSavedKey = savedProviders.includes(provider);
  const credentialFailed = failedProviders.includes(provider);
  const showKeyInput = credentialFailed || (credentialsKnown && !hasSavedKey);
  const ready = connected && configured.includes(provider) && !credentialFailed;
  const pending = events.filter(
    (event) => event.type === "approval" && !resolved.includes(event.id),
  );
  const approval = pending[0];
  const choiceQuestion = singleChoiceQuestion(approval);
  const hasConversation = events.some((event) => ["user", "text", "tool"].includes(event.type));
  const stateLabel = !available
    ? "Sprite required"
    : reconnecting
      ? `Reconnecting (${reconnecting}/3)`
      : preparing
        ? "Starting runtime"
        : checking
          ? "Checking connection"
          : approval
            ? "Waiting for your answer"
            : working
              ? "Working"
              : ready
                ? "Ready"
                : connected
                  ? hasSavedKey
                    ? "Saved key needs connection"
                    : "Add API key"
                  : "Not connected";
  const submitLatest = useRef<
    (text: string, requestId?: string, previousDraft?: string) => boolean
  >(() => false);
  function submitText(text: string, requestId?: string, previousDraft = "") {
    const attached = requestId ? [] : imagesRef.current;
    if (
      (!text.trim() && !attached.length) ||
      readingImagesRef.current ||
      !ready ||
      working ||
      checking ||
      preparing ||
      dirty ||
      !visible ||
      socket.current?.readyState !== WebSocket.OPEN
    )
      return false;
    stickToBottom.current = true;
    setAtBottom(true);
    setWorking(true);
    setWorkingStartedAt(new Date().toISOString());
    setError("");
    if (requestId) activeRequest.current = { id: requestId, prompt: text, started: false };
    const id = crypto.randomUUID();
    try {
      socket.current.send(
        JSON.stringify({
          type: "prompt",
          provider,
          text,
          ...(attached.length ? { id } : {}),
          ...(attached.length ? { images: attached } : {}),
        }),
      );
    } catch {
      setWorking(false);
      setError("The message was not sent. Reconnect and try again.");
      return false;
    }
    if (attached.length) {
      submittedImages.current = { id, text, images: attached, failed: false, acknowledged: false };
      setImageSending(true);
    } else setPrompt(previousDraft);
    if (requestId) {
      setPendingRequest(null);
      requestCallbacks.current.onRequestSent?.(requestId);
    }
    if (composer.current) composer.current.style.height = "auto";
    return true;
  }
  submitLatest.current = submitText;
  useEffect(() => {
    requestCallbacks.current.onWorkingChange?.(working);
  }, [working]);
  useEffect(() => {
    if (!request || seenRequests.current.has(request.id)) return;
    seenRequests.current.add(request.id);
    // Only the explicit new request gets one immediate send attempt. If gated,
    // connection or navigation changes never turn it into a delayed paid request.
    if (!prompt.trim() && !images.length && submitLatest.current(request.prompt, request.id))
      return;
    const staged = !prompt.trim() && !images.length;
    setPendingRequest({ ...request, staged, previousDraft: prompt });
    if (staged) setPrompt(request.prompt);
  }, [request, prompt, images.length]);
  function cancelRequest() {
    if (!pendingRequest) return;
    if (pendingRequest.staged) setPrompt(pendingRequest.previousDraft);
    setPendingRequest(null);
    requestCallbacks.current.onRequestCancelled?.(pendingRequest.id);
  }
  function submit() {
    const external = pendingRequest?.staged ? pendingRequest : null;
    submitText(prompt, external?.id, external?.previousDraft);
  }
  return (
    <section className="workspace-panel agent-panel" hidden={!visible}>
      <header className="chat-header">
        <span>Agent</span>
        <div>
          <button type="button" onClick={onReview}>
            <GitCompareArrows size={14} /> Review changes
          </button>
          <button
            type="button"
            aria-label="Agent connection settings"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={15} /> Connection
          </button>
        </div>
      </header>
      <div
        ref={log}
        className="agent-conversation"
        role="log"
        aria-label="Agent conversation"
        aria-live="polite"
        onScroll={() => {
          const el = log.current;
          if (!el) return;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stickToBottom.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <div className="chat-thread">
          {!hasConversation && (
            <div className="chat-empty flex h-full items-center justify-center">
              <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
            </div>
          )}
          <AgentTimeline
            events={events}
            onOpenFile={onOpenFile}
            working={working}
            workingStartedAt={workingStartedAt}
            awaitingInput={Boolean(approval)}
          />
        </div>
      </div>
      {!atBottom && hasConversation && (
        <button
          type="button"
          className="chat-jump"
          onClick={() => {
            stickToBottom.current = true;
            log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown size={14} /> Latest
        </button>
      )}
      <div className="chat-bottom" ref={composerBottom}>
        <ComposerSurface.Shell className="chat-composer-wrap">
          <ComposerSurface.Host>
            {(error ||
              dirty ||
              !available ||
              settings ||
              (!ready && available) ||
              approval ||
              pendingRequest) && (
              <ComposerBanner.Attachment>
                <ComposerBanner.Root variant={error ? "error" : "default"}>
                  {pendingRequest && (
                    <section
                      className="chat-feedback flex-wrap items-center gap-2"
                      aria-label="Pending team resolution request"
                    >
                      <span>
                        {pendingRequest.staged
                          ? "Team conflict resolution is in the composer. Review it, then send when ready."
                          : "A team conflict-resolution request is pending. Your draft is preserved."}
                      </span>
                      {!pendingRequest.staged && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => {
                            setPendingRequest({
                              ...pendingRequest,
                              staged: true,
                              previousDraft: prompt,
                            });
                            setPrompt(pendingRequest.prompt);
                            composer.current?.focus();
                          }}
                        >
                          Use resolution prompt
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" onClick={cancelRequest}>
                        Cancel request
                      </Button>
                    </section>
                  )}
                  {error && (
                    <div className="chat-feedback error" role="alert">
                      <span>{error}</span>
                      <button
                        type="button"
                        aria-label="Dismiss agent error"
                        onClick={() => setError("")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {dirty && (
                    <div className="chat-feedback">
                      Save your file edits before sending a request.
                    </div>
                  )}
                  {!available && (
                    <div className="chat-feedback">
                      Agent execution needs a running Sprite and an open event.
                    </div>
                  )}
                  {(settings || (!ready && available)) && (
                    <div className="chat-connection">
                      <div>
                        <strong>Connect {agentModels[provider].label}</strong>
                        <span>
                          {provider === "opencode"
                            ? "OpenCode · GLM 5.3 Flash"
                            : "Claude Code · Opus 5"}
                        </span>
                      </div>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!validateWorkspaceId()) return;
                          if (connected && key.trim()) {
                            setChecking(true);
                            setError("");
                            setConfigured((previous) => previous.filter((p) => p !== provider));
                            configuringProvider.current = provider;
                            send({
                              type: "configure",
                              provider,
                              key: key.trim(),
                              ...(provider === "claude" && claudeWorkspaceId.trim()
                                ? { workspaceId: claudeWorkspaceId.trim() }
                                : {}),
                            });
                          } else if (connected && savedReconnectSupported.current) {
                            setChecking(true);
                            setError("");
                            configuringProvider.current = provider;
                            send({ type: "reconnect", provider });
                          } else void connect();
                        }}
                      >
                        {showKeyInput ? (
                          <input
                            type="password"
                            aria-label="Agent API key"
                            autoComplete="off"
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            placeholder={agentModels[provider].credential}
                          />
                        ) : (
                          <span className="chat-saved-key">
                            {hasSavedKey ? "API key saved" : "Checking saved connection…"}
                          </span>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          type="submit"
                          disabled={!available || preparing || checking || working}
                        >
                          {preparing || checking ? (
                            <LoaderCircle size={14} className="chat-spin" />
                          ) : null}
                          {preparing
                            ? "Starting…"
                            : checking
                              ? "Checking…"
                              : ready
                                ? "Reconnect"
                                : "Connect"}
                        </Button>
                      </form>
                      {provider === "claude" && showKeyInput && (
                        <label className="chat-workspace-id">
                          Anthropic workspace ID (if required by your key)
                          <input
                            aria-label="Anthropic workspace ID"
                            autoComplete="off"
                            value={claudeWorkspaceId}
                            onChange={(event) => setClaudeWorkspaceId(event.target.value)}
                            placeholder="wrkspc_…"
                          />
                        </label>
                      )}
                      <small>Saved privately in your Sprite. Also used by the terminal.</small>
                    </div>
                  )}
                  {approval && (
                    <section className="chat-approval" aria-label="Agent question">
                      <div className="chat-approval-heading">
                        <strong>The agent has a question</strong>
                        {pending.length > 1 && <span>1 of {pending.length}</span>}
                      </div>
                      <p className="chat-question-text">
                        {choiceQuestion?.question ?? questionText(approval)}
                      </p>
                      {choiceQuestion && (
                        <QuestionOptions
                          key={approval.id}
                          options={choiceQuestion.options}
                          disabled={!connected}
                          onChoose={(answer) =>
                            send({ type: "approval", id: approval.id, allow: true, answer })
                          }
                        />
                      )}
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (answers[approval.id]?.trim())
                            send({
                              type: "approval",
                              id: approval.id,
                              allow: true,
                              answer: answers[approval.id],
                            });
                        }}
                      >
                        <input
                          aria-label="Your answer to the agent"
                          placeholder="Your answer"
                          value={answers[approval.id] ?? ""}
                          onChange={(event) =>
                            setAnswers({ ...answers, [approval.id]: event.target.value })
                          }
                        />
                        <div className="chat-approval-actions">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={!connected}
                            onClick={() =>
                              send({ type: "approval", id: approval.id, allow: false })
                            }
                          >
                            Skip question
                          </Button>
                          <Button
                            type="submit"
                            size="xs"
                            disabled={!connected || !answers[approval.id]?.trim()}
                          >
                            Send answer
                          </Button>
                        </div>
                      </form>
                    </section>
                  )}
                </ComposerBanner.Root>
              </ComposerBanner.Attachment>
            )}
            <ComposerSurface.Main>
              <form
                className="agent-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <div
                  data-chat-composer-body="true"
                  className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4"
                >
                  {images.length > 0 && (
                    <AgentImages
                      images={images}
                      disabled={imageSending || readingImages}
                      onRemove={(id) =>
                        setImages((previous) => previous.filter((image) => image.id !== id))
                      }
                    />
                  )}
                  <textarea
                    disabled={imageSending}
                    onPaste={(event) => {
                      const files = [...event.clipboardData.items]
                        .filter((item) => item.kind === "file")
                        .map((item) => item.getAsFile())
                        .filter((file): file is File => file !== null);
                      if (!files.length) return;
                      // Leave native text insertion/selection intact for mixed clipboards.
                      if (!event.clipboardData.getData("text/plain")) event.preventDefault();
                      void addImages(files);
                    }}
                    ref={composer}
                    aria-label="Message to agent"
                    rows={3}
                    placeholder="Ask anything"
                    value={prompt}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      event.target.style.height = "auto";
                      event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                  />
                </div>
                <div
                  data-chat-composer-footer="true"
                  className="chat-composer-toolbar flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
                >
                  <div className="chat-model">
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      hidden
                      aria-label="Choose images"
                      onChange={(event) => {
                        const files = [...(event.target.files ?? [])];
                        event.target.value = "";
                        void addImages(files);
                      }}
                    />
                    <button
                      className="chat-attach"
                      type="button"
                      aria-label="Attach images"
                      title="Attach images"
                      disabled={imageSending || readingImages}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={18} />
                    </button>
                    <select
                      aria-label="Agent model"
                      value={provider}
                      disabled={working || checking || preparing}
                      onChange={(event) => {
                        setProvider(event.target.value as "claude" | "opencode");
                        setKey("");
                        configuringProvider.current = null;
                        setError("");
                      }}
                    >
                      <option value="opencode">GLM</option>
                      <option value="claude">Opus 5</option>
                    </select>
                  </div>
                  <span className={ready || working ? "sr-only" : "chat-readiness"} role="status">
                    {stateLabel}
                  </span>
                  <ComposerPrimaryActions
                    isRunning={working}
                    hasSendableContent={!!prompt.trim() || images.length > 0}
                    isConnecting={preparing || checking}
                    isSendBusy={readingImages}
                    isEnvironmentUnavailable={!ready}
                    sendDisabledReason={dirty ? "Save file edits first" : null}
                    onInterrupt={() => send({ type: "stop" })}
                  />
                </div>
              </form>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </section>
  );
}
