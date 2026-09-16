// This entrypoint is uploaded to and executed ONLY inside a participant Sprite.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { getSessionMessages, type Query, query } from "@anthropic-ai/claude-agent-sdk";
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import { holdActiveTurn } from "./activity.ts";
import {
  claudeEnvironment,
  claudeWorkspaceId,
  loadCredentials,
  saveCredential,
} from "./credentials.ts";
import { AgentJournal } from "./journal.ts";
import {
  type AgentEvent,
  type AgentInput,
  agentFailure,
  agentInputSchema,
  agentModels,
  credentialFailure,
} from "./protocol.ts";
import { verifyProviderKey } from "./provider.ts";

const root = "/home/sprite/.civic-spark-agent";
async function contextModule() {
  // Reproducible setup may refresh guidance while a conversation stays attached.
  // Load the changed module on the next turn without losing provider context.
  const version = statSync(`${root}/context.ts`).mtimeMs;
  return import(`./context.ts?version=${version}`) as Promise<typeof import("./context.ts")>;
}
process.chdir("/home/sprite/project");
process.env.PATH = `${root}/node_modules/.bin:${process.env.PATH}`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const statePath = `${root}/sessions.json`;
const state: { claude?: string; opencode?: string } = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
const savedKeys = loadCredentials("/home/sprite");
const journal = new AgentJournal(`${root}/conversation.json`, Object.values(savedKeys));
let journalFailureReported = false;
const emit = (type: AgentEvent["type"], text: string, extra: Partial<AgentEvent> = {}) => {
  let serialized = JSON.stringify({ type, id: randomUUID(), text, ...extra });
  for (const key of [
    ...Object.values(keys),
    ...Object.values(savedKeys),
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENROUTER_API_KEY,
  ]) {
    if (key) serialized = serialized.replaceAll(JSON.stringify(key).slice(1, -1), "[redacted]");
  }
  journal.record(JSON.parse(serialized) as AgentEvent);
  process.stdout.write(`${serialized}\n`);
  if (journal.failed && !journalFailureReported) {
    journalFailureReported = true;
    process.stdout.write(
      `${JSON.stringify({ type: "error", id: "journal-failure", text: "Chat history could not be saved in this Sprite. The current session is still available; check home-directory disk space and permissions." })}\n`,
    );
  }
};
const approvals = new Map<string, (allow: boolean, answer?: string) => void>();
let active = false;
let turn: AbortController | undefined;
let runtimeReady = false;
let working = false;
let workingStartedAt: string | undefined;
let claude: Query | undefined;
let claudeAbort: AbortController | undefined;
let open: ReturnType<typeof createOpencodeClient> | undefined;
let closeOpen: (() => void) | undefined;
const keys: Partial<Record<"claude" | "opencode", string>> = {};
const failedProviders = new Set<"claude" | "opencode">();
const emitState = () =>
  emit("state", working ? "Working" : runtimeReady ? "Ready" : "Connecting", {
    id: "runtime-state",
    runtimeReady,
    working,
    workingStartedAt,
    configuredProviders: Object.keys(keys) as ("claude" | "opencode")[],
    savedProviders: Object.keys(savedKeys) as ("claude" | "opencode")[],
    failedProviders: [...failedProviders],
  });
async function ask(
  id: string,
  text: string,
  details: unknown,
): Promise<{ allow: boolean; answer?: string }> {
  emit("approval", text, { id, details: JSON.stringify(details, null, 2).slice(0, 20000) });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      emit("resolved", "Request timed out", { id });
      resolve({ allow: false });
    }, 5 * 60000);
    approvals.set(id, (allow, answer) => {
      clearTimeout(timer);
      approvals.delete(id);
      emit("resolved", allow ? "Approved" : "Denied", { id });
      resolve({ allow, answer });
    });
  });
}
async function claudeTurn(
  input: Extract<AgentInput, { type: "prompt" }>,
  cancellation: AbortController,
) {
  if (!keys.claude && !process.env.ANTHROPIC_API_KEY)
    throw new Error("Add an Anthropic API key in agent settings first");
  const context = await contextModule();
  cancellation.signal.throwIfAborted();
  claudeAbort = cancellation;
  claude = query({
    prompt: input.text,
    options: {
      cwd: "/home/sprite/project",
      resume: state.claude,
      model: agentModels.claude.model,
      systemPrompt: context.claudeSystemPrompt(),
      env: claudeEnvironment("/home/sprite", process.env, keys.claude),
      abortController: claudeAbort,
      settingSources: [],
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: async (name, toolInput, options) => {
        if (name !== "AskUserQuestion") return { behavior: "allow", updatedInput: toolInput };
        const result = await ask(options.toolUseID, name, toolInput);
        const updatedInput = { ...toolInput };
        if (name === "AskUserQuestion" && result.answer && Array.isArray(toolInput.questions)) {
          updatedInput.answers = Object.fromEntries(
            toolInput.questions.map((q: { question: string }) => [q.question, result.answer]),
          );
        }
        return result.allow
          ? { behavior: "allow", updatedInput }
          : { behavior: "deny", message: "Participant declined this action" };
      },
    },
  });
  const textID = randomUUID();
  for await (const event of claude) {
    if ("session_id" in event) {
      state.claude = event.session_id;
      save();
    }
    if (
      event.type === "stream_event" &&
      event.event.type === "content_block_delta" &&
      event.event.delta.type === "text_delta"
    )
      emit("text", event.event.delta.text, { id: textID });
    if (event.type === "assistant")
      for (const part of event.message.content)
        if (part.type === "tool_use")
          emit("tool", part.name, { details: JSON.stringify(part.input).slice(0, 20000) });
    if (event.type === "result") {
      if (event.is_error) {
        const error = {
          message: event.subtype === "success" ? event.result : event.errors.join("\n"),
        };
        if (credentialFailure(error)) failedProviders.add("claude");
        emit("error", agentFailure(error), {
          provider: "claude",
          credentialFailure: credentialFailure(error),
        });
      }
      emit("status", "Claude turn finished", { cost: event.total_cost_usd });
    }
  }
}
async function startOpen() {
  if (open) return open;
  if (keys.opencode) process.env.OPENROUTER_API_KEY = keys.opencode;
  const password = randomBytes(24).toString("base64url");
  process.env.OPENCODE_SERVER_PASSWORD = password;
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30000,
    config: { permission: "allow" },
  });
  closeOpen = server.close;
  const client = createOpencodeClient({
    baseUrl: server.url,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    throwOnError: true,
  });
  const events = await client.event.subscribe();
  void (async () => {
    for await (const event of events.stream) {
      const props = event.properties;
      if ("sessionID" in props && props.sessionID !== state.opencode) continue;
      if (event.type === "message.part.delta" && event.properties.field === "text")
        emit("text", event.properties.delta, { id: event.properties.partID });
      if (event.type === "message.part.updated" && event.properties.part.type === "tool")
        emit("tool", event.properties.part.tool, {
          id: event.properties.part.id,
          details: JSON.stringify(event.properties.part.state).slice(0, 20000),
        });
      if (event.type === "permission.asked") {
        void client.permission
          .reply({ requestID: event.properties.id, reply: "once" })
          .catch(() => emit("error", "Could not apply bypass permissions"));
      }
      if (event.type === "question.asked") {
        const request = event.properties;
        void ask(request.id, "Agent question", request.questions)
          .then((result) =>
            result.allow
              ? client.question.reply({
                  requestID: request.id,
                  answers: request.questions.map(() => [result.answer ?? ""]),
                })
              : client.question.reject({ requestID: request.id }),
          )
          .catch(() => emit("error", "Could not reply to agent question"));
      }
    }
  })().catch(() => {
    if (open === client) emit("error", "OpenCode event stream disconnected. Reconnect the agent.");
  });
  open = client;
  return client;
}
async function openTurn(
  input: Extract<AgentInput, { type: "prompt" }>,
  cancellation: AbortController,
) {
  if (!keys.opencode) throw new Error("API key missing");
  const client = await startOpen();
  cancellation.signal.throwIfAborted();
  if (!state.opencode) {
    const created = await client.session.create({ title: "Civic Spark workspace" });
    state.opencode = created.data?.id;
    save();
    cancellation.signal.throwIfAborted();
  }
  if (!state.opencode) throw new Error("Could not create session");
  const model = agentModels.opencode.model;
  const separator = model.indexOf("/");
  const context = await contextModule();
  cancellation.signal.throwIfAborted();
  const result = await client.session.prompt({
    sessionID: state.opencode,
    system: context.workspaceContext(),
    model: {
      providerID: model.slice(0, separator),
      modelID: model.slice(separator + 1),
    },
    parts: [{ type: "text", text: input.text }],
  });
  if (result.data?.info.error) throw result.data.info.error;
  if (result.data?.info.cost !== undefined)
    emit("status", "Turn complete", { cost: result.data.info.cost });
}
async function input(message: AgentInput) {
  if (message.type === "reconnect") {
    const key = loadCredentials("/home/sprite")[message.provider];
    if (!key) {
      delete savedKeys[message.provider];
      delete keys[message.provider];
      emit("error", "Add an API key for the selected model.", {
        provider: message.provider,
        credentialFailure: true,
      });
      emitState();
      return;
    }
    savedKeys[message.provider] = key;
    await input({ type: "configure", provider: message.provider, key });
    return;
  }
  if (message.type === "configure") {
    if (active) {
      emit("error", "Stop the current turn before changing credentials");
      return;
    }
    active = true;
    const previousKey = keys[message.provider];
    let saved = false;
    emit("status", "Checking API key and runtime…");
    try {
      const workspaceId =
        message.provider === "claude"
          ? (message.workspaceId ??
            (message.key === savedKeys.claude ? claudeWorkspaceId("/home/sprite") : undefined))
          : undefined;
      const verified = await verifyProviderKey(message.provider, message.key, workspaceId);
      saveCredential("/home/sprite", message.provider, message.key, verified.workspaceId ?? null);
      saved = true;
      savedKeys[message.provider] = message.key;
      keys[message.provider] = message.key;
      if (message.provider === "opencode") {
        closeOpen?.();
        open = undefined;
        await startOpen();
      }
      failedProviders.delete(message.provider);
      emit("configured", `${agentModels[message.provider].label} ready`, { id: message.provider });
    } catch (error) {
      if (!saved && previousKey) keys[message.provider] = previousKey;
      else delete keys[message.provider];
      if (saved && message.provider === "opencode") {
        open = undefined;
        closeOpen?.();
        closeOpen = undefined;
        delete process.env.OPENROUTER_API_KEY;
      }
      failedProviders.add(message.provider);
      emit("error", agentFailure(error), { provider: message.provider, credentialFailure: true });
    } finally {
      active = false;
      emitState();
    }
    return;
  }
  if (message.type === "approval") {
    approvals.get(message.id)?.(message.allow, message.answer);
    return;
  }
  if (message.type === "stop") {
    turn?.abort();
    for (const resolve of approvals.values()) resolve(false);
    claudeAbort?.abort();
    if (open && state.opencode) await open.session.abort({ sessionID: state.opencode });
    return;
  }
  if (active) {
    emit("error", "A turn is already running. Stop it before sending another message.");
    return;
  }
  active = true;
  const cancellation = new AbortController();
  turn = cancellation;
  emit("user", message.text);
  working = true;
  workingStartedAt = new Date().toISOString();
  emit("status", "Working", { workingStartedAt });
  emitState();
  let releaseHold: (() => Promise<void>) | undefined;
  try {
    releaseHold = await holdActiveTurn(() => {
      if (turn !== cancellation) return;
      cancellation.abort();
      claudeAbort?.abort();
      if (open && state.opencode) void open.session.abort({ sessionID: state.opencode });
      emit(
        "error",
        "Sprite activity protection was interrupted. The turn was stopped; reconnect to retry.",
      );
    });
    cancellation.signal.throwIfAborted();
    if (message.provider === "claude") await claudeTurn(message, cancellation);
    else await openTurn(message, cancellation);
  } catch (error) {
    if (cancellation.signal.aborted) return;
    if (credentialFailure(error)) failedProviders.add(message.provider);
    emit("error", agentFailure(error), {
      provider: message.provider,
      credentialFailure: credentialFailure(error),
    });
  } finally {
    await releaseHold?.();
    if (turn === cancellation) turn = undefined;
    active = false;
    claude = undefined;
    claudeAbort = undefined;
    for (const resolve of approvals.values()) resolve(false);
    working = false;
    workingStartedAt = undefined;
    emit("done", "Ready");
    emitState();
  }
}
async function recoverNativeHistory() {
  if (journal.events.some((event) => event.type === "user" || event.type === "text")) return;
  if (state.opencode) {
    try {
      const client = await startOpen();
      const messages = await client.session.messages({ sessionID: state.opencode, limit: 200 });
      for (const message of messages.data ?? []) {
        for (const part of message.parts) {
          if (part.type !== "text" || !part.text) continue;
          emit(message.info.role === "user" ? "user" : "text", part.text, {
            id: `native-open-${part.id}`,
          });
        }
      }
    } catch {
      emit(
        "status",
        "The saved OpenCode context is retained, but its earlier messages could not be loaded yet.",
      );
    }
  }
  if (state.claude) {
    try {
      const messages = await getSessionMessages(state.claude, { dir: "/home/sprite/project" });
      for (const message of messages.slice(-200)) {
        if (message.type === "system") continue;
        const content = (message.message as { content?: unknown })?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part) => part?.type === "text" && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n")
              : "";
        if (text)
          emit(message.type === "user" ? "user" : "text", text, {
            id: `native-claude-${message.uuid}`,
          });
      }
    } catch {
      emit(
        "status",
        "The saved Claude context is retained, but its earlier messages could not be loaded yet.",
      );
    }
  }
}
const initialized = (async () => {
  for (const event of journal.events)
    process.stdout.write(`${JSON.stringify({ ...event, replayed: true })}\n`);
  if (journal.interrupted) {
    for (const event of journal.events.filter((e) => e.type === "approval"))
      emit("resolved", "Question interrupted by runtime restart", { id: event.id });
    emit(
      "status",
      "The previous turn was interrupted when the runtime restarted. Your conversation and model context were retained; send a message to continue.",
    );
    emit("done", "Ready");
  }
  emitState();
  for (const [provider, key] of Object.entries(savedKeys)) {
    if (key) await input({ type: "configure", provider: provider as "claude" | "opencode", key });
  }
  await recoverNativeHistory();
  runtimeReady = true;
  emit("ready", "Agent runner ready");
  emitState();
})();
createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const message = agentInputSchema.parse(JSON.parse(line));
    void initialized
      .then(() => input(message))
      .catch((error) => emit("error", agentFailure(error)));
  } catch {
    emit("error", "Invalid agent request");
  }
});
const shutdown = () => {
  journal.flush();
  claudeAbort?.abort();
  closeOpen?.();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
