import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "../tests/auth-fixture.ts";

const requestedSprite = process.argv[process.argv.indexOf("--sprite") + 1];
if (!requestedSprite?.startsWith("civic-spark-smoke-"))
  throw new Error("Pass --sprite with an existing dedicated civic-spark-smoke- Sprite");
const sprite: string = requestedSprite;
const testModel = process.argv.includes("--model");
let modelKey = "";
if (testModel) {
  console.log("OpenRouter test key (stdin only):");
  const lines = createInterface({ input: process.stdin });
  modelKey = await new Promise<string>((resolve) => lines.once("line", resolve));
  lines.close();
}
const root = mkdtempSync(join(tmpdir(), "civic-spark-workspace-live-"));
const origin = "http://127.0.0.1:4310";
const { app, service, authentication } = await createApp(root, false, origin, undefined, "email");
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const identity = await testIdentity(authentication, "Live workspace tester");
assert(identity.actor);
const created = service.createEvent(identity.actor, {
  name: "Isolated live check",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Test",
  capacity: 2,
  budget: 0,
  templateId: "blank",
});
assert(created.ok);
service.transition(identity.actor, created.value.id, "registration");
const team = service.createTeam(identity.actor, {
  eventId: created.value.id,
  name: "Probe",
  projectId: "data-starter",
});
assert(team.ok);
const id = team.value.workspace.id;
service.setSprite(id, sprite, "ready", null);
const sockets: WebSocket[] = [];
const client = new SpriteClient();
const agentFilename = `civic-spark-agent-probe-${Date.now()}.svg`;
const filename = `civic-spark-live-check-${Date.now()}.txt`;
let revision: string | null = null;
const credentialBackup = `/home/sprite/.civic-spark-agent/smoke-backup-${randomUUID()}`;
let credentialsBackedUp = false;
async function preserveCredentials(restore: boolean) {
  const result = await client.exec(sprite, [
    "python3",
    "-c",
    `
import os, shutil, json, sys
from pathlib import Path
root=Path(sys.argv[1]); home=Path('/home/sprite')
files=['.local/share/opencode/auth.json','.config/opencode/opencode.json','.claude/settings.json']
if sys.argv[2]=='backup':
    root.mkdir(mode=0o700)
    for index,name in enumerate(files):
        source=home/name
        if source.exists(): shutil.copy2(source,root/str(index))
else:
    for index,name in enumerate(files):
        target=home/name; saved=root/str(index)
        if saved.exists():
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(saved,target)
        elif target.exists(): target.unlink()
    shutil.rmtree(root)
`,
    credentialBackup,
    restore ? "restore" : "backup",
  ]);
  assert(
    result.ok,
    restore ? "Could not restore test credentials" : "Could not preserve test credentials",
  );
}
async function connect(path: string) {
  const socket = new WebSocket(`${address.replace("http", "ws")}/api/workspaces/${id}/${path}`, {
    headers: { origin, cookie: identity.cookie },
  });
  sockets.push(socket);
  const received: {
    type: string;
    id?: string;
    text?: string;
    data?: string;
    details?: string;
    cost?: number;
    runtimeReady?: boolean;
    working?: boolean;
    configuredProviders?: string[];
  }[] = [];
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString());
    received.push(event);
    // Emulate the terminal capability responses that xterm.js normally sends.
    if (path === "terminal" && event.data?.includes("\x1b[6n"))
      socket.send(JSON.stringify({ type: "input", data: "\x1b[1;1R" }));
    if (path === "terminal" && event.data?.includes("\x1b]11;?"))
      socket.send(JSON.stringify({ type: "input", data: "\x1b]11;rgb:1717/2525/1f1f\x1b\\" }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, received };
}
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + (testModel ? 180000 : 45000);
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  const file = await client.mutateBlob(sprite, {
    path: filename,
    revision: null,
    data: Buffer.from("A temporary sync probe\n").toString("base64"),
  });
  assert(file.ok);
  revision = file.value.revision;
  const manifest = await client.manifest(sprite);
  assert(manifest.ok);
  assert.equal(manifest.value.files[filename]?.revision, revision);
  const changes = await client.changes(sprite);
  assert(changes.ok);
  assert(changes.value.files.some((f) => f.path === filename && f.status === "added"));
  const conflict = await client.mutateBlob(sprite, { path: filename, revision: "stale", data: "" });
  assert(!conflict.ok);
  const prepared = await app.inject({
    method: "POST",
    url: `/api/workspaces/${id}/agent/prepare`,
    headers: { host: "127.0.0.1:4310", origin, cookie: identity.cookie },
  });
  assert.equal(prepared.statusCode, 200);
  if (testModel) {
    await preserveCredentials(false);
    credentialsBackedUp = true;
  }
  const agent = await connect("agent");
  await until(
    () => agent.received.some((e) => e.type === "state" && e.runtimeReady),
    "agent runner ready",
  );
  if (testModel) {
    agent.received.length = 0;
    agent.socket.send(JSON.stringify({ type: "configure", provider: "opencode", key: modelKey }));
    modelKey = "";
    await until(
      () => agent.received.some((e) => e.type === "configured" || e.type === "error"),
      "model configured",
    );
    assert(
      !agent.received.some((e) => e.type === "error"),
      agent.received.find((e) => e.type === "error")?.text,
    );
    console.log("GLM key and runtime verified");
    agent.socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "error") console.log(event.text);
      if (event.cost !== undefined) console.log(`GLM reported turn cost: $${event.cost}`);
    });
    agent.socket.send(
      JSON.stringify({
        type: "prompt",
        provider: "opencode",
        text: `Use the file editing tool to create ${agentFilename}, a tiny standalone SVG bar chart of values 3, 7, 5. Do not run shell commands or modify other files. Reply briefly when done.`,
      }),
    );
    await until(() => agent.received.some((e) => e.type === "done"), "GLM response");
    assert(
      !agent.received.some((e) => e.type === "error"),
      agent.received.find((e) => e.type === "error")?.text,
    );
    const chart = await client.readBlob(sprite, agentFilename);
    assert(chart.ok, "GLM should create the requested chart");
    assert(Buffer.from(chart.value.data, "base64").toString().includes("<svg"));
    assert(
      !agent.received.some((e) => e.type === "approval"),
      "Coding tools must bypass permission prompts",
    );
    console.log("Live GLM response and SVG file edit passed with bypass permissions");
  }
  agent.socket.close();
  const reconnect = await connect("agent");
  await until(
    () => reconnect.received.some((e) => e.type === "state" && e.runtimeReady),
    "agent reconnect",
  );
  const terminal = await connect("terminal");
  await until(
    () => terminal.received.some((e) => e.data?.includes("Civic Spark terminal connected")),
    "terminal output",
  );
  await until(
    () => /project[^\r\n]*[$#]/.test(terminal.received.map((e) => e.data ?? "").join("")),
    "interactive shell prompt after tmux attachment",
  );
  terminal.socket.send(
    JSON.stringify({
      type: "input",
      data: "CIVIC_SPARK_PROBE=keep; printf 'CIVIC_%s\\n' 'SPARK_TERMINAL_READY'\r",
    }),
  );
  await until(
    () => terminal.received.some((e) => e.data?.includes("CIVIC_SPARK_TERMINAL_READY")),
    "remote shell command",
  );
  terminal.socket.close();
  const attached = await connect("terminal");
  attached.socket.send(JSON.stringify({ type: "resize", cols: 121, rows: 35 }));
  attached.socket.send(
    JSON.stringify({ type: "input", data: "printf 'PERSIST_%s\\n' \"$CIVIC_SPARK_PROBE\"\r" }),
  );
  await until(
    () =>
      attached.received
        .map((e) => e.data ?? "")
        .join("")
        .includes("PERSIST_keep"),
    "persistent terminal shell",
  );
  console.log(
    `PASS: real Sprite manifest/CAS/diff, agent runner startup and reconnect, interactive terminal command and reconnect. ${testModel ? "Live GLM turn verified." : "Zero model calls."}`,
  );
} finally {
  if (testModel) {
    const chart = await client.readBlob(sprite, agentFilename);
    if (chart.ok)
      await client.mutateBlob(sprite, {
        path: agentFilename,
        revision: chart.value.revision,
        data: null,
      });
  }
  for (const socket of sockets) socket.close();
  if (revision) await client.mutateBlob(sprite, { path: filename, revision, data: null });
  await client.exec(sprite, ["tmux", "kill-session", "-t", "civic-spark-workspace"]);
  await app.close();
  if (credentialsBackedUp) await preserveCredentials(true);
  rmSync(root, { recursive: true, force: true });
}
