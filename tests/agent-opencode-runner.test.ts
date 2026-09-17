import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { saveCredential } from "../packages/agents/src/credentials.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";

// Actual runner, pinned SDK HTTP/SSE, journal and Tasks hold. Only the native
// runtime is a loopback double; no inference or participant project executes.
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cs-open-wire-"));
  const runtime = join(home, ".civic-spark-agent");
  mkdirSync(runtime);
  mkdirSync(join(home, "project"));
  saveCredential(home, "opencode", "fixture-key");
  const sessionID = "retained-session";
  writeFileSync(join(runtime, "sessions.json"), JSON.stringify({ opencode: sessionID }));
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const records: { info: Record<string, unknown>; parts: unknown[] }[] = [];
  const streams = new Set<ServerResponse>();
  let busy = false;
  let deletes = 0;
  let puts = 0;
  let messagesFail = false;
  let statusFail = false;
  let prompt: (response: ServerResponse, body: Record<string, unknown>) => void = (res) =>
    res.writeHead(204).end();
  let abort: (response: ServerResponse) => void = (res) => {
    busy = false;
    res.end("true");
  };
  let readMessages: ((response: ServerResponse) => void) | undefined;
  let readStatus: ((response: ServerResponse) => void) | undefined;
  const tasks = createServer((req, res) => {
    req.resume();
    if (req.method === "PUT") puts++;
    if (req.method === "DELETE") deletes++;
    res.writeHead(204).end();
  });
  const socketPath = join(home, "tasks.sock");
  await new Promise<void>((done) => tasks.listen(socketPath, done));
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const parsed = body ? JSON.parse(body) : {};
    requests.push({ path, body: parsed });
    expect(req.headers.authorization).toMatch(/^Basic /);
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (path.endsWith("/prompt_async")) return prompt(res, parsed);
    if (path.endsWith("/abort")) return abort(res);
    if (path === "/session/status") {
      if (readStatus) return readStatus(res);
      return res
        .writeHead(statusFail ? 503 : 200)
        .end(
          JSON.stringify(
            statusFail ? { error: "unavailable" } : busy ? { [sessionID]: { type: "busy" } } : {},
          ),
        );
    }
    if (path.endsWith("/message") && readMessages) return readMessages(res);
    if (path.endsWith("/message"))
      return res
        .writeHead(messagesFail ? 503 : 200)
        .end(JSON.stringify(messagesFail ? { error: "unavailable" } : records));
    if (path === "/provider")
      return res.end(
        JSON.stringify({
          all: [
            {
              id: "openrouter",
              models: { "z-ai/glm-5.3-flash": { capabilities: { input: { image: true } } } },
            },
          ],
        }),
      );
    res.end("true");
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const mocks = join(home, "mock.mjs");
  writeFileSync(
    mocks,
    `
    export {createOpencodeClient} from ${JSON.stringify(pathToFileURL(resolve("packages/agents/runtime/node_modules/@opencode-ai/sdk/dist/v2/index.js")).href)};
    export async function createOpencodeServer() { return { url: "http://127.0.0.1:${address.port}", close() {} }; }
    export async function verifyProviderKey() { return {}; }
    export async function* query() { throw new Error("Unexpected Claude call"); }
    export async function getSessionMessages() { return []; }
  `,
  );
  writeFileSync(
    join(runtime, "context.ts"),
    "export const workspaceContext = () => 'retained project guidance';\n",
  );
  writeFileSync(
    join(runtime, "activity.ts"),
    readFileSync(resolve("packages/agents/src/activity.ts"), "utf8").replace(
      '"/.sprite/api.sock"',
      JSON.stringify(socketPath),
    ),
  );
  const entry = join(runtime, "runner.ts");
  writeFileSync(
    entry,
    readFileSync(resolve("packages/agents/src/runner.ts"), "utf8")
      .replaceAll("/home/sprite", home)
      .replaceAll('"@anthropic-ai/claude-agent-sdk"', JSON.stringify(pathToFileURL(mocks).href))
      .replaceAll('"@opencode-ai/sdk/v2"', JSON.stringify(pathToFileURL(mocks).href))
      .replaceAll('"./provider.ts"', JSON.stringify(pathToFileURL(mocks).href))
      .replace(
        /"\.\/(credentials|journal|protocol|multimodal|opencode-turn)\.ts"/g,
        (_, name: string) =>
          JSON.stringify(pathToFileURL(resolve(`packages/agents/src/${name}.ts`)).href),
      ),
  );
  let child = spawn(process.execPath, ["--experimental-strip-types", entry], { stdio: "pipe" });
  const events: AgentEvent[] = [];
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  let reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => events.push(JSON.parse(line)));
  const stopChild = async () => {
    child.kill();
    await new Promise<void>((done) => child.once("close", () => done()));
    reader.close();
  };
  const wait = (predicate: () => boolean, timeout = 8000) =>
    vi.waitFor(() => expect(predicate(), diagnostics).toBe(true), { timeout, interval: 20 });
  const send = (body: object) => child.stdin.write(`${JSON.stringify(body)}\n`);
  await wait(() => events.some((event) => event.type === "ready"));
  const user = (id: string) => {
    records.push({ info: { id, sessionID, role: "user" }, parts: [] });
    busy = true;
  };
  const assistant = (parentID: string, finish = "stop", error?: unknown) =>
    records.push({
      info: {
        id: `assistant-${records.length}`,
        sessionID,
        parentID:
          parentID === "11111111-1111-4111-8111-111111111111"
            ? requests.findLast((request) => request.path.endsWith("prompt_async"))?.body.messageID
            : parentID,
        role: "assistant",
        finish,
        time: { completed: Date.now() },
        ...(error ? { error } : {}),
      },
      parts: [],
    });
  return {
    events,
    requests,
    records,
    streams,
    send,
    wait,
    user,
    assistant,
    sessionID,
    get deletes() {
      return deletes;
    },
    get puts() {
      return puts;
    },
    set busy(value: boolean) {
      busy = value;
    },
    set prompt(value: typeof prompt) {
      prompt = value;
    },
    set abort(value: typeof abort) {
      abort = value;
    },
    set readMessages(value: typeof readMessages) {
      readMessages = value;
    },
    set readStatus(value: typeof readStatus) {
      readStatus = value;
    },
    set messagesFail(value: boolean) {
      messagesFail = value;
    },
    set statusFail(value: boolean) {
      statusFail = value;
    },
    begin(id = "11111111-1111-4111-8111-111111111111", extra = {}) {
      send({ type: "prompt", provider: "opencode", text: "Continue", id, ...extra });
    },
    emit(type: string, properties: object) {
      for (const stream of streams)
        stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
    },
    async killRuntime() {
      api.closeAllConnections();
      await new Promise<void>((done) => api.close(() => done()));
    },
    async restart() {
      await stopChild();
      events.length = 0;
      child = spawn(process.execPath, ["--experimental-strip-types", entry], { stdio: "pipe" });
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk.toString();
      });
      reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => events.push(JSON.parse(line)));
      await wait(() => events.some((event) => event.type === "ready"));
    },
    async close() {
      await stopChild();
      api.closeAllConnections();
      await new Promise<void>((done) => api.close(() => done()));
      await new Promise<void>((done) => tasks.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

it.each(["stalled", "EOF", "lost ACK"])(
  "reconciles %s without resubmission, retaining session/model/context and Tasks hold",
  async (mode) => {
    const f = await fixture();
    try {
      f.prompt = (res, body) => {
        f.user(String(body.messageID));
        if (mode === "lost ACK") res.destroy();
        else res.writeHead(204).end();
      };
      f.begin();
      await f.wait(() => f.records.length === 1);
      if (mode === "EOF") for (const stream of f.streams) stream.end();
      f.assistant("old-request");
      f.assistant("11111111-1111-4111-8111-111111111111", "tool-calls");
      // Even an idle read cannot make an intermediate tool step terminal.
      f.busy = false;
      await new Promise((done) => setTimeout(done, 1300));
      expect(f.deletes).toBe(0);
      expect(f.events.some((event) => event.type === "done")).toBe(false);
      f.assistant("11111111-1111-4111-8111-111111111111");
      await f.wait(() => f.events.some((event) => event.type === "done"));
      expect(f.events.find((event) => event.type === "done")?.outcome).toBe("success");
      expect(f.deletes).toBe(1);
      expect(f.requests.filter((r) => r.path.endsWith("prompt_async"))).toEqual([
        {
          path: "/session/retained-session/prompt_async",
          body: expect.objectContaining({
            messageID: expect.stringMatching(/^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/),
            system: "retained project guidance",
            model: { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
          }),
        },
      ]);
      expect(f.events.filter((event) => event.type === "error")).toEqual([]);
    } finally {
      await f.close();
    }
  },
  12000,
);

it("Stop waits for delayed POST acceptance and post-acceptance abort/idle before releasing Tasks", async () => {
  const f = await fixture();
  let accept: (() => void) | undefined;
  let aborted: ServerResponse | undefined;
  try {
    f.prompt = (res, body) => {
      accept = () => {
        f.user(String(body.messageID));
        res.writeHead(204).end();
      };
    };
    f.abort = (res) => {
      aborted = res;
    };
    f.begin();
    await f.wait(() => Boolean(accept));
    f.send({ type: "stop" });
    await new Promise((done) => setTimeout(done, 3500));
    expect(f.deletes).toBe(0);
    expect(f.events.some((event) => event.type === "done")).toBe(false);
    accept?.();
    await f.wait(() => Boolean(aborted));
    expect(f.deletes).toBe(0);
    f.busy = false;
    aborted?.end("true");
    await f.wait(() => f.deletes === 1 && f.events.some((event) => event.type === "done"));
    expect(f.events.find((event) => event.type === "done")?.outcome).toBe("stopped");
    expect(f.requests.filter((r) => r.path.endsWith("prompt_async"))).toHaveLength(1);
  } finally {
    aborted?.end("true");
    await f.close();
  }
}, 14000);

it("a rejected POST still requires successful messages and status reads", async () => {
  const f = await fixture();
  try {
    f.prompt = (res) => res.writeHead(400).end(JSON.stringify({ name: "BadRequestError" }));
    f.messagesFail = true;
    f.begin();
    await new Promise((done) => setTimeout(done, 1400));
    expect(f.deletes).toBe(0);
    f.messagesFail = false;
    f.statusFail = true;
    await new Promise((done) => setTimeout(done, 1400));
    expect(f.deletes).toBe(0);
    f.statusFail = false;
    await f.wait(() => f.events.some((event) => event.type === "done"));
    expect(f.events.find((event) => event.type === "done")?.outcome).toBe("failed");
    expect(f.events.find((event) => event.type === "error")?.text).toContain(
      "local OpenCode runtime",
    );
  } finally {
    await f.close();
  }
}, 12000);

it("a delayed stale idle response cannot finish an intermediate tool assistant", async () => {
  const f = await fixture();
  let pending: ServerResponse | undefined;
  try {
    f.prompt = (res, body) => {
      f.user(String(body.messageID));
      res.writeHead(204).end();
    };
    f.readStatus = (res) => {
      pending = res;
    };
    f.begin();
    await f.wait(() => Boolean(pending));
    f.assistant("11111111-1111-4111-8111-111111111111", "tool-calls");
    f.emit("message.updated", { info: f.records.at(-1)?.info });
    pending?.end("{}");
    f.readStatus = undefined;
    await new Promise((done) => setTimeout(done, 1400));
    expect(f.deletes).toBe(0);
    f.assistant("11111111-1111-4111-8111-111111111111");
    f.busy = false;
    await f.wait(() => f.deletes === 1 && f.events.some((event) => event.type === "done"));
  } finally {
    pending?.end("{}");
    await f.close();
  }
}, 12000);

it("reports correlated provider errors only after native idle", async () => {
  const f = await fixture();
  try {
    f.prompt = (res, body) => {
      f.user(String(body.messageID));
      res.writeHead(204).end();
    };
    f.begin();
    await f.wait(() => f.records.length === 1);
    f.assistant("11111111-1111-4111-8111-111111111111", "stop", {
      name: "APIError",
      data: { statusCode: 401, message: "denied" },
    });
    await new Promise((done) => setTimeout(done, 1400));
    expect(f.deletes).toBe(0);
    f.busy = false;
    await f.wait(() => f.deletes === 1 && f.events.some((event) => event.type === "done"));
    expect(f.events.find((event) => event.type === "done")?.outcome).toBe("failed");
    expect(f.events.find((event) => event.type === "error")?.credentialFailure).toBe(true);
  } finally {
    await f.close();
  }
}, 12000);

it("ends a definitely dead loopback runtime without hanging or retrying inference", async () => {
  const f = await fixture();
  try {
    f.prompt = (res, body) => {
      f.user(String(body.messageID));
      res.writeHead(204).end();
    };
    f.begin();
    await f.wait(() => f.records.length === 1);
    await f.killRuntime();
    await f.wait(() => f.deletes === 1 && f.events.some((event) => event.type === "done"));
    expect(f.events.find((event) => event.type === "done")?.outcome).toBe("failed");
    expect(f.events.find((event) => event.type === "error")?.text).toContain(
      "local OpenCode runtime",
    );
    expect(f.events.find((event) => event.type === "error")?.credentialFailure).toBe(false);
  } finally {
    await f.close();
  }
}, 12000);

it("Stop after ACK timeout retains the hold until late acceptance is aborted", async () => {
  const f = await fixture();
  let accept: (() => void) | undefined;
  try {
    f.prompt = (_res, body) => {
      accept = () => f.user(String(body.messageID));
    };
    f.begin();
    await f.wait(() => Boolean(accept));
    f.send({ type: "stop" });
    await f.wait(
      () => f.events.some((event) => event.text.includes("checking the current turn")),
      12000,
    );
    expect(f.deletes).toBe(0);
    expect(f.requests.filter((request) => request.path.endsWith("prompt_async"))).toHaveLength(1);
    accept?.();
    await f.wait(() => f.deletes === 1 && f.events.some((event) => event.type === "done"));
    expect(f.events.find((event) => event.type === "done")?.outcome).toBe("stopped");
  } finally {
    await f.close();
  }
}, 18000);

it("a stalled control response times out without releasing a potentially active turn", async () => {
  const f = await fixture();
  let pending: ServerResponse | undefined;
  try {
    f.prompt = (res, body) => {
      f.user(String(body.messageID));
      res.writeHead(204).end();
    };
    f.readStatus = (res) => {
      pending = res;
    };
    f.begin();
    await f.wait(() => Boolean(pending));
    await new Promise((done) => setTimeout(done, 5300));
    expect(f.deletes).toBe(0);
    f.readStatus = undefined;
    f.assistant("11111111-1111-4111-8111-111111111111");
    f.busy = false;
    await f.wait(() => f.deletes === 1 && f.events.some((event) => event.type === "done"));
    expect(f.events.find((event) => event.type === "done")?.outcome).toBe("success");
  } finally {
    pending?.end("{}");
    await f.close();
  }
}, 14000);

it("retains images, question replies, bypass permissions and the next explicit turn in the same session", async () => {
  const f = await fixture();
  const requestID = "11111111-1111-4111-8111-111111111111";
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  try {
    f.prompt = (res, body) => {
      f.user(String(body.messageID));
      res.writeHead(204).end();
    };
    f.begin(requestID, {
      images: [{ id: requestID, name: "fixture.png", mime: "image/png", data: png }],
    });
    await f.wait(() => f.records.length === 1 && f.streams.size > 0);
    const submitted = f.requests.find((request) => request.path.endsWith("prompt_async"));
    expect(submitted?.body.parts).toContainEqual({
      type: "file",
      mime: "image/png",
      filename: "fixture.png",
      url: `data:image/png;base64,${png}`,
    });
    f.emit("permission.asked", { id: "permission-one", sessionID: f.sessionID });
    f.emit("question.asked", {
      id: "question-one",
      sessionID: f.sessionID,
      questions: [{ question: "Choose a color", header: "Color", options: [{ label: "Blue" }] }],
    });
    await f.wait(() => f.events.some((event) => event.type === "approval"));
    expect(f.deletes).toBe(0);
    f.send({ type: "approval", id: "question-one", allow: true, answer: "Blue" });
    await f.wait(() => f.requests.some((request) => request.path.includes("question-one/reply")));
    expect(
      f.requests.find((request) => request.path.includes("permission-one/reply"))?.body,
    ).toEqual({ reply: "once" });
    expect(f.requests.find((request) => request.path.includes("question-one/reply"))?.body).toEqual(
      { answers: [["Blue"]] },
    );
    f.assistant(requestID);
    f.busy = false;
    await f.wait(() => f.events.some((event) => event.type === "done"));
    f.begin("22222222-2222-4222-8222-222222222222");
    await f.wait(
      () => f.requests.filter((request) => request.path.endsWith("prompt_async")).length === 2,
    );
    const nativeID = String(
      f.requests.findLast((request) => request.path.endsWith("prompt_async"))?.body.messageID,
    );
    f.assistant(nativeID);
    f.busy = false;
    await f.wait(() => f.events.filter((event) => event.type === "done").length === 2);
    expect(f.requests.some((request) => request.path === "/session")).toBe(false);
    expect(f.deletes).toBe(2);
    expect(f.events.filter((event) => event.type === "error")).toEqual([]);
  } finally {
    await f.close();
  }
}, 12000);

it.each(["zero SSE", "streamed prefix"])(
  "recovers durable text after %s exactly once before Done and on actual runner restart",
  async (mode) => {
    const f = await fixture();
    const answer = "A complete answer recovered from the native runtime.";
    const partID = "answer-part";
    const prefix = "A complete ";
    try {
      f.prompt = (res, body) => {
        f.user(String(body.messageID));
        res.writeHead(204).end();
      };
      f.begin();
      await f.wait(() => f.records.length === 1 && f.streams.size > 0);
      const nativeID = String(f.records[0]?.info.id);
      if (mode === "streamed prefix") {
        f.emit("message.part.delta", {
          sessionID: f.sessionID,
          messageID: "assistant-2",
          partID,
          field: "text",
          delta: prefix,
        });
        await f.wait(() => f.events.some((event) => event.type === "text"));
      }
      // These valid but unrelated parts must never be added to the current answer.
      f.assistant("earlier-user");
      f.records[1]?.parts.push({
        type: "text",
        id: "old-part",
        sessionID: f.sessionID,
        messageID: "assistant-1",
        text: "Old answer",
      });
      f.assistant(nativeID);
      f.records[2]?.parts.push({
        type: "text",
        id: partID,
        sessionID: f.sessionID,
        messageID: "assistant-2",
        text: answer,
      });
      // Recover during busy, then deliver the queued SSE suffix: never duplicate it.
      await f.wait(
        () =>
          f.events
            .filter((event) => event.type === "text")
            .map((event) => event.text)
            .join("") === answer,
      );
      expect(f.deletes).toBe(0);
      f.emit("message.part.delta", {
        sessionID: f.sessionID,
        messageID: "assistant-2",
        partID,
        field: "text",
        delta: answer.slice(mode === "streamed prefix" ? prefix.length : 0),
      });
      await new Promise((done) => setTimeout(done, 1200));
      f.busy = false;
      await f.wait(() => f.events.some((event) => event.type === "done"));
      const texts = f.events.filter((event) => event.type === "text");
      expect(texts.map((event) => event.text).join("")).toBe(answer);
      expect(texts.every((event) => event.id === partID)).toBe(true);
      expect(f.events.findLastIndex((event) => event.type === "text")).toBeLessThan(
        f.events.findIndex((event) => event.type === "done"),
      );
      expect(f.events.find((event) => event.type === "done")?.outcome).toBe("success");
      expect(f.deletes).toBe(1);
      await f.restart();
      expect(f.events.filter((event) => event.type === "text")).toEqual([
        expect.objectContaining({ id: partID, text: answer, replayed: true }),
      ]);
      expect(f.requests.filter((request) => request.path.endsWith("prompt_async"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  14000,
);

it.each([
  { name: "error object", status: { error: "malformed status map" } },
  { name: "null session entry", status: { "retained-session": null } },
  { name: "invalid session type", status: { "retained-session": { type: "complete" } } },
  { name: "malformed unrelated entry", status: { other: null } },
])(
  "retains Tasks on HTTP200 status $name until valid busy then idle",
  async ({ status }) => {
    const f = await fixture();
    try {
      f.prompt = (res, body) => {
        f.user(String(body.messageID));
        res.writeHead(204).end();
      };
      f.readStatus = (res) => res.end(JSON.stringify(status));
      f.begin();
      await f.wait(() => f.records.length === 1);
      f.assistant("11111111-1111-4111-8111-111111111111");
      await new Promise((done) => setTimeout(done, 1500));
      expect(f.deletes).toBe(0);
      expect(f.events.some((event) => event.type === "done" || event.type === "error")).toBe(false);
      f.readStatus = undefined;
      await new Promise((done) => setTimeout(done, 1200));
      expect(f.deletes).toBe(0);
      f.busy = false;
      await f.wait(() => f.events.some((event) => event.type === "done"));
      expect(f.deletes).toBe(1);
      expect(f.events.find((event) => event.type === "done")?.outcome).toBe("success");
      expect(f.requests.filter((request) => request.path.endsWith("prompt_async"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  12000,
);

it.each([
  null,
  {},
  { info: null },
  {
    info: { id: "x", role: "assistant", sessionID: "retained-session", parentID: "x" },
    parts: [null],
  },
])(
  "retains Tasks on malformed HTTP200 message record %j even with SSE completion and idle",
  async (malformed) => {
    const f = await fixture();
    try {
      f.prompt = (res, body) => {
        f.user(String(body.messageID));
        res.writeHead(204).end();
      };
      f.readMessages = (res) => res.end(JSON.stringify([malformed]));
      f.begin();
      await f.wait(() => f.records.length === 1 && f.streams.size > 0);
      f.assistant("11111111-1111-4111-8111-111111111111");
      f.emit("message.updated", { info: f.records[0]?.info });
      f.emit("message.updated", { info: f.records[1]?.info });
      f.busy = false;
      await new Promise((done) => setTimeout(done, 1500));
      expect(f.deletes).toBe(0);
      expect(f.events.some((event) => event.type === "done" || event.type === "error")).toBe(false);
      f.busy = true;
      f.readMessages = undefined;
      await new Promise((done) => setTimeout(done, 1200));
      expect(f.deletes).toBe(0);
      f.busy = false;
      await f.wait(() => f.events.some((event) => event.type === "done"));
      expect(f.deletes).toBe(1);
      expect(f.events.find((event) => event.type === "done")?.outcome).toBe("success");
      expect(f.requests.filter((request) => request.path.endsWith("prompt_async"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  12000,
);
