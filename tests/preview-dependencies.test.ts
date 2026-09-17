import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const source = readFileSync(new URL("../packages/sprites/src/preview.py", import.meta.url), "utf8");
async function fixture(real = false, timeout = 300, viteVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-preview-deps-"));
  const project = join(root, "project"),
    runtime = join(root, "runtime"),
    bin = join(root, "bin");
  for (const path of [project, runtime, bin]) mkdirSync(path);
  const port = await new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") throw Error();
      server.close(() => resolve(a.port));
    });
  });
  const script = source
    .replace("INSTALL_TIMEOUT = 300", `INSTALL_TIMEOUT = ${timeout}`)
    .replace(
      "ROOT = pathlib.Path('/home/sprite/.civic-spark-agent')",
      `ROOT = pathlib.Path(${JSON.stringify(runtime)})`,
    )
    .replace(
      "PROJECT = pathlib.Path('/home/sprite/project')",
      `PROJECT = pathlib.Path(${JSON.stringify(project)})`,
    );
  // Simulates the documented in-Sprite service contract; the app itself is real.
  const provider = `#!/usr/bin/env python3
import os, sys, signal, subprocess, pathlib, json
root = pathlib.Path(${JSON.stringify(root)})
definition = root/'service.json'
pidfile = root/'server.pid'
args = sys.argv[1:]
assert args.pop(0) == 'services'
with (root/'service-calls').open('a') as log: log.write(json.dumps(args)+'\\n')
if (root/'service-error').exists(): sys.exit(1)
def stop():
    if pidfile.exists():
        try: os.killpg(int(pidfile.read_text()), signal.SIGKILL)
        except ProcessLookupError: pass
        pidfile.unlink()
if args[0] == 'list':
    value = json.loads(definition.read_text()) if definition.exists() else None
    if value: value['state'] = {'status': 'running' if pidfile.exists() else ('failed' if (root/'stop-failed').exists() else 'stopped')}
    print(json.dumps([value] if value else []))
elif args[0] == 'stop': stop()
elif args[0] in ['create', 'start']:
    assert args[1] == 'civic-spark-web-preview'
    if args[0] == 'create':
        assert args[args.index('--cmd')+1] == '/bin/sh'
        assert '--http-port' in args
        stop()
        value = {'name': args[1], 'cmd': '/bin/sh', 'args': [args[args.index('--args')+1]], 'http_port': int(args[args.index('--http-port')+1])}
        definition.write_text(json.dumps(value))
        if (root/'create-stopped').exists(): sys.exit(0)
    value = json.loads(definition.read_text())
    p = subprocess.Popen([value['cmd'], *value['args']], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pidfile.write_text(str(p.pid))
else: raise Exception('Unexpected service operation')
`;
  writeFileSync(join(bin, "sprite-env"), provider);
  chmodSync(join(bin, "sprite-env"), 0o755);
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "tmux"), 0o755);
  if (!real) {
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env python3
import sys, pathlib, json, time, os
root = pathlib.Path(${JSON.stringify(root)})
p = pathlib.Path.cwd()
args = sys.argv[1:]
if args[0] == '--version': print('11.0.0'); sys.exit(0)
if args[0] == 'ls': sys.exit(0 if (p/'node_modules/installed').exists() else 1)
if args[0] in ['ci', 'install']:
    with (root/'calls').open('a') as f: f.write(json.dumps(args)+'\\n')
    assert not any(k in os.environ for k in ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'SPRITE_TOKEN'])
    if (root/'slow').exists(): time.sleep(3)
    if (root/'fail').exists(): print('SECRET registry failure'); sys.exit(1)
    (p/'node_modules').mkdir(exist_ok=True)
    (p/'node_modules/installed').write_text('yes')
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
  }
  const defaults = {
    port,
    command: real
      ? ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"]
      : ["python3", "-m", "http.server", `${port}`, "--bind", "127.0.0.1"],
  };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ANTHROPIC_API_KEY: "do-not-inherit",
    OPENROUTER_API_KEY: "do-not-inherit",
    SPRITE_TOKEN: "do-not-inherit",
  };
  let interrupt: (() => void) | undefined;
  const run = async (operation: string, previewHost: string | null = "fixture-org.sprites.app") => {
    const p = spawn("python3", ["-c", script], { env, stdio: ["pipe", "pipe", "pipe"] });
    if (operation === "start")
      interrupt = () => {
        p.kill("SIGTERM");
      };
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (data) => {
      stdout += data;
    });
    p.stderr.on("data", (data) => {
      stderr += data;
    });
    p.stdin.end(
      JSON.stringify({ operation, defaults, ...(previewHost === null ? {} : { previewHost }) }),
    );
    await new Promise<void>((done, reject) => {
      p.on("error", reject);
      p.on("close", () => done());
    });
    expect(stderr).toBe("");
    return JSON.parse(stdout);
  };
  const calls = () =>
    existsSync(join(root, "calls"))
      ? readFileSync(join(root, "calls"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  const write = (file: string, data: unknown) =>
    writeFileSync(join(project, file), typeof data === "string" ? data : JSON.stringify(data));
  write("package.json", {
    private: true,
    scripts: {
      dev: "vite",
      ...(real
        ? {
            postinstall:
              "node -e \"require('fs').writeFileSync('source-overwrite.txt', 'changed')\"",
          }
        : {}),
    },
    ...(real
      ? {
          devDependencies: {
            vite:
              viteVersion ??
              JSON.parse(readFileSync(resolve("node_modules/vite/package.json"), "utf8")).version,
          },
        }
      : {}),
  });
  if (!real) write("package-lock.json", { lockfileVersion: 3 });
  cleanups.push(async () => {
    await run("stop");
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    runtime,
    run,
    calls,
    write,
    defaults,
    env,
    interrupt: () => interrupt?.(),
  };
}

it("fresh checkout installs once, preserves files/config, detects changed manifests/lock and missing modules", async () => {
  const f = await fixture();
  const original = readFileSync(join(f.project, "package.json"));
  f.write("draft.txt", "Unshared work");
  expect((await f.run("status")).value.ready).toBe(false);
  expect(existsSync(join(f.runtime, "environment.json"))).toBe(false);
  expect((await f.run("start")).value).toMatchObject({ ready: true, phase: "ready" });
  expect(readFileSync(join(f.runtime, "preview-service.sh"), "utf8")).toContain(
    "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=fixture-org.sprites.app",
  );
  expect(f.calls()).toHaveLength(1);
  expect(f.calls()[0]?.[0]).toBe("ci");
  expect(readFileSync(join(f.project, "package.json"))).toEqual(original);
  expect(readFileSync(join(f.project, "draft.txt"), "utf8")).toBe("Unshared work");
  await f.run("restart");
  expect(f.calls()).toHaveLength(1);
  f.write("package-lock.json", { lockfileVersion: 3, changed: true });
  await f.run("restart");
  expect(f.calls()).toHaveLength(2);
  f.write("package.json", { private: true, description: "Team update" });
  await f.run("restart");
  expect(f.calls()).toHaveLength(3);
  rmSync(join(f.project, "node_modules"), { recursive: true });
  await f.run("restart");
  expect(f.calls()).toHaveLength(4);
  await f.run("stop");
  const custom = { ...f.defaults, command: [...f.defaults.command, "--directory", f.project] };
  writeFileSync(join(f.runtime, "environment.json"), JSON.stringify(custom));
  expect((await f.run("start")).value.command).toEqual(custom.command);
}, 30000);

it("no lock uses no-save/no-lockfile install; explicit managers and workspaces fail without install", async () => {
  const f = await fixture();
  rmSync(join(f.project, "package-lock.json"));
  expect((await f.run("start")).value.ready).toBe(true);
  expect(f.calls()[0]).toEqual(
    expect.arrayContaining(["install", "--no-save", "--package-lock=false", "--ignore-scripts"]),
  );
  expect(existsSync(join(f.project, "package-lock.json"))).toBe(false);
  await f.run("stop");
  for (const manifest of [
    { packageManager: "pnpm@10.0.0" },
    { workspaces: ["packages/*"] },
    { packageManager: "npm@0.0.1" },
  ]) {
    f.write("package.json", manifest);
    expect((await f.run("start")).ok).toBe(false);
  }
  expect(f.calls()).toHaveLength(1);
});

it("concurrent launches share preparation; Stop cancels installation and retry repairs it without leaking secrets", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "slow"), "yes");
  const pending = f.run("start");
  await expect.poll(() => f.calls().length, { timeout: 5000 }).toBe(1);
  expect((await f.run("status")).value.phase).toBe("installing");
  expect((await f.run("start")).value.phase).toBe("installing");
  expect((await f.run("stop")).value).toMatchObject({ ready: false, running: false });
  expect((await pending).ok).toBe(false);
  expect(existsSync(join(f.runtime, "project-installed.json"))).toBe(false);
  rmSync(join(f.root, "slow"));
  writeFileSync(join(f.root, "fail"), "yes");
  expect((await f.run("start")).error).toContain("installation failed");
  expect((await f.run("logs")).value.logs).not.toContain("SECRET");
  expect((await f.run("status")).value).toMatchObject({ phase: "error", ready: false });
  rmSync(join(f.root, "fail"));
  expect((await f.run("start")).value.ready).toBe(true);
  expect(f.calls()).toHaveLength(3);
}, 15000);

it("trusted fresh shared Vite clone becomes Ready with real npm ci, unchanged tracked files and no key/model/harness", async () => {
  const f = await fixture(true);
  f.write("index.html", "<!doctype html><h1>Shared Vite demo</h1>");
  f.write(".gitignore", "node_modules/\n");
  await execute(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: f.project },
  );
  await execute("git", ["init", "--initial-branch=main"], { cwd: f.project });
  await execute("git", ["add", "."], { cwd: f.project });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Shared demo",
    ],
    { cwd: f.project },
  );
  const shared = join(f.root, "shared");
  await execute("git", ["clone", f.project, shared]);
  rmSync(f.project, { recursive: true });
  await execute("git", ["clone", shared, f.project]);
  expect(existsSync(join(f.project, "node_modules"))).toBe(false);
  const result = await f.run("start");
  expect(result, JSON.stringify({ result, logs: await f.run("logs") })).toMatchObject({
    ok: true,
    value: { ready: true, phase: "ready" },
  });
  expect(await (await fetch(`http://127.0.0.1:${f.defaults.port}`)).text()).toContain(
    "Shared Vite demo",
  );
  const hostStatus = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${f.defaults.port}`,
        { headers: { host } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
  expect(await hostStatus("fixture-org.sprites.app")).toBe(200);
  expect(await hostStatus("unrelated.example.test")).toBe(403);
  const marker = readFileSync(join(f.runtime, "project-installed.json"), "utf8");
  expect((await f.run("restart")).value.ready).toBe(true);
  expect(readFileSync(join(f.runtime, "project-installed.json"), "utf8")).toBe(marker);
  expect((await execute("git", ["status", "--porcelain"], { cwd: f.project })).stdout).toBe("");
  expect(existsSync(join(f.runtime, "node_modules"))).toBe(false);
  rmSync(join(f.project, "node_modules/.bin/vite"));
  expect((await f.run("restart")).value.ready).toBe(true);
  expect(existsSync(join(f.project, "node_modules/.bin/vite"))).toBe(true);
  const lock = readFileSync(join(f.project, "package-lock.json"));
  rmSync(join(f.project, "package-lock.json"));
  expect((await f.run("restart")).value.ready).toBe(true);
  expect(existsSync(join(f.project, "package-lock.json"))).toBe(false);
  expect(existsSync(join(f.project, "source-overwrite.txt"))).toBe(false);
  writeFileSync(join(f.project, "package-lock.json"), lock);
  f.write("package.json", {
    private: true,
    scripts: { dev: "vite" },
    dependencies: { missing: "999.0.0" },
  });
  expect((await f.run("restart")).ok).toBe(false);
  expect(readFileSync(join(f.project, "package-lock.json"))).toEqual(lock);
  expect((await f.run("status")).value.ready).toBe(false);
}, 60000);

it("timeout and transport interruption leave no ready marker or late server; retry succeeds", async () => {
  for (const timedOut of [true, false]) {
    const f = await fixture(false, timedOut ? 0.8 : 300);
    writeFileSync(join(f.root, "slow"), "yes");
    const pending = f.run("start");
    await expect.poll(() => f.calls().length, { timeout: 5000 }).toBe(1);
    if (!timedOut) f.interrupt();
    expect((await pending).error).toContain(timedOut ? "timed out" : "interrupted");
    expect(existsSync(join(f.runtime, "project-installed.json"))).toBe(false);
    expect((await f.run("status")).value).toMatchObject({
      running: false,
      ready: false,
      phase: "error",
    });
    rmSync(join(f.root, "slow"));
    expect((await f.run("start")).value.ready).toBe(true);
  }
}, 15000);

it("Launch repairs a cached Vite install missing its transitive bundler, then reuses the repaired tree", async () => {
  const f = await fixture(true);
  f.write("index.html", "<!doctype html><h1>Cached shared demo</h1>");
  await execute(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: f.project },
  );
  const manifest = readFileSync(join(f.project, "package.json"));
  const lock = readFileSync(join(f.project, "package-lock.json"));
  const source = readFileSync(join(f.project, "index.html"));
  expect((await f.run("start")).value.ready).toBe(true);
  await f.run("stop");
  const marker = readFileSync(join(f.runtime, "project-installed.json"));
  const inode = statSync(join(f.project, "node_modules")).ino;
  // Vite 8 uses Rolldown; earlier Vite releases use Rollup. Neither is direct in this fixture.
  const vite = JSON.parse(readFileSync(join(f.project, "node_modules/vite/package.json"), "utf8"));
  const bundler = vite.dependencies.rolldown ? "rolldown" : "rollup";
  const missing = join(f.project, "node_modules", bundler);
  expect(existsSync(missing)).toBe(true);
  rmSync(missing, { recursive: true });
  expect(statSync(join(f.project, "node_modules")).ino).toBe(inode);
  expect(readFileSync(join(f.runtime, "project-installed.json"))).toEqual(marker);
  expect(existsSync(join(f.project, "node_modules/.bin/vite"))).toBe(true);
  // Establish the old false-positive cache check with real npm, not a transport mock.
  await execute("npm", ["ls", "--depth=0", "--include=dev", "--include=optional"], {
    cwd: f.project,
  });
  await expect(
    execute("npm", ["ls", "--all", "--include=dev", "--include=optional"], { cwd: f.project }),
  ).rejects.toMatchObject({ code: 1 });
  const repaired = await f.run("start");
  expect(repaired, JSON.stringify(repaired)).toMatchObject({ ok: true, value: { ready: true } });
  expect(existsSync(missing)).toBe(true);
  expect(await (await fetch(`http://127.0.0.1:${f.defaults.port}`)).text()).toContain(
    "Cached shared demo",
  );
  const repairedMarkerTime = statSync(join(f.runtime, "project-installed.json")).mtimeMs;
  await f.run("stop");
  expect((await f.run("start")).value.ready).toBe(true);
  expect(statSync(join(f.runtime, "project-installed.json")).mtimeMs).toBe(repairedMarkerTime);
  expect(readFileSync(join(f.project, "package.json"))).toEqual(manifest);
  expect(readFileSync(join(f.project, "package-lock.json"))).toEqual(lock);
  expect(readFileSync(join(f.project, "index.html"))).toEqual(source);
  expect(existsSync(join(f.project, "source-overwrite.txt"))).toBe(false);
  expect(existsSync(join(f.runtime, "node_modules"))).toBe(false);
}, 60000);

it.each(["stopped", "failed"])(
  "explicit Stop with provider state %s leaves no running process; polling does not restart and Launch reuses the HTTP definition",
  async (state) => {
    const f = await fixture();
    expect((await f.run("start")).value.ready).toBe(true);
    const definition = readFileSync(join(f.root, "service.json"));
    if (state === "failed") writeFileSync(join(f.root, "stop-failed"), "fixture provider state");
    expect((await f.run("stop")).value).toMatchObject({
      running: false,
      ready: false,
      phase: "stopped",
    });
    expect(existsSync(join(f.root, "server.pid"))).toBe(false);
    for (const action of ["status", "logs", "status"]) {
      expect((await f.run(action)).value).toMatchObject({ running: false, ready: false });
    }
    expect(readFileSync(join(f.root, "service.json"))).toEqual(definition);
    expect((await f.run("start")).value.ready).toBe(true);
    expect(readFileSync(join(f.root, "service.json"))).toEqual(definition);
    expect(f.calls()).toHaveLength(1);
  },
);

it("service inspection failure does not assume absence, replace configuration or publish a ready state", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "service-error"), "provider unavailable");
  expect((await f.run("start")).ok).toBe(false);
  expect(f.calls()).toHaveLength(0);
  expect(existsSync(join(f.root, "service.json"))).toBe(false);
  expect(existsSync(join(f.runtime, "environment.json"))).toBe(false);
  rmSync(join(f.root, "service-error"));
  expect((await f.run("start")).value.ready).toBe(true);
});

it("Launch updates the existing stopped named service definition when its configured port changes", async () => {
  const f = await fixture();
  expect((await f.run("start")).value.ready).toBe(true);
  await f.run("stop");
  const nextPort = await new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw Error();
      server.close(() => resolve(address.port));
    });
  });
  const updated = {
    port: nextPort,
    command: ["python3", "-m", "http.server", `${nextPort}`, "--bind", "127.0.0.1"],
  };
  writeFileSync(join(f.runtime, "environment.json"), JSON.stringify(updated));
  expect((await f.run("start")).value).toMatchObject({ ready: true, port: nextPort });
  expect((await fetch(`http://127.0.0.1:${nextPort}`)).status).toBe(200);
  expect(JSON.parse(readFileSync(join(f.root, "service.json"), "utf8"))).toMatchObject({
    name: "civic-spark-web-preview",
    http_port: nextPort,
  });
  const calls = readFileSync(join(f.root, "service-calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "create");
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((args) => args[1])).size).toBe(1);
});

it("explicit Launch starts an existing failed service when updating its definition does not restart it", async () => {
  const f = await fixture();
  expect((await f.run("start")).value.ready).toBe(true);
  writeFileSync(join(f.root, "stop-failed"), "exit143");
  await f.run("stop");
  expect((await f.run("status")).value.running).toBe(false);
  writeFileSync(join(f.root, "create-stopped"), "preserve stopped state on update");
  expect((await f.run("start")).value.ready).toBe(true);
  expect((await fetch(`http://127.0.0.1:${f.defaults.port}`)).status).toBe(200);
  const calls = readFileSync(join(f.root, "service-calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.filter((args) => args[0] === "start")).toEqual([
    ["start", "civic-spark-web-preview", "--duration", "1s"],
  ]);
  expect(f.calls()).toHaveLength(1);
});

it("Vite 5.4.21 recovers exact native-host access through managed Restart while preserving async project config", async () => {
  const f = await fixture(true, 300, "5.4.21");
  f.write(
    "index.html",
    '<!doctype html><h1>Vite 5 shared demo</h1><script type="module" src="/main.js"></script>',
  );
  f.write(
    "main.js",
    'console.log("managed fixture"); if (import.meta.hot) import.meta.hot.accept();',
  );
  const config = `import { defineConfig } from "vite";
export default defineConfig(async ({ command, mode }) => ({
  server: { allowedHosts: ["existing.example.test"] },
  plugins: [{ name: "original-config", configureServer(server) {
    server.middlewares.use("/original-config", (_req, res) => { res.end(command + ":" + mode); });
  } }],
}));
`;
  f.write("vite.config.ts", config);
  await execute(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: f.project },
  );
  await execute("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: f.project });
  const manifest = readFileSync(join(f.project, "package.json"));
  const lock = readFileSync(join(f.project, "package-lock.json"));
  const get = (host: string, path = "/") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${f.defaults.port}${path}`,
        { headers: { host } },
        (response) => {
          let body = "";
          response.on("data", (data) => {
            body += data;
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  // Real pre-fix behavior: the exact environment hook reaches Vite 5 but is ignored.
  const baseline = spawn("npm", f.defaults.command.slice(1), {
    cwd: f.project,
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "fixture-org.sprites.app",
    },
  });
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await get("localhost")).status;
          } catch {
            return 0;
          }
        },
        { timeout: 10000 },
      )
      .toBe(200);
    expect((await get("fixture-org.sprites.app")).status).toBe(403);
  } finally {
    if (baseline.pid) process.kill(-baseline.pid, "SIGKILL");
    await new Promise<void>((resolve) => baseline.once("close", () => resolve()));
  }
  const started = await f.run("restart");
  expect(started, JSON.stringify({ started, logs: await f.run("logs") })).toMatchObject({
    ok: true,
    value: { ready: true, phase: "ready", command: f.defaults.command },
  });
  expect((await get("fixture-org.sprites.app")).body).toContain("Vite 5 shared demo");
  expect((await get("fixture-org.sprites.app", "/main.js")).status).toBe(200);
  expect((await get("fixture-org.sprites.app", "/original-config")).body).toBe("serve:development");
  expect((await get("existing.example.test")).status).toBe(200);
  for (const host of [
    "unrelated.example.test",
    "other.sprites.app",
    "sub.fixture-org.sprites.app",
  ]) {
    expect((await get(host)).status).toBe(403);
  }
  const client = (await get("fixture-org.sprites.app", "/@vite/client")).body;
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  expect(token).toBeTruthy();
  const socket = new WebSocket(`ws://127.0.0.1:${f.defaults.port}/?token=${token}`, "vite-hmr", {
    headers: { host: "fixture-org.sprites.app", origin: "http://fixture-org.sprites.app" },
  });
  try {
    const connected = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    expect(JSON.parse(connected)).toEqual({ type: "connected" });
    const update = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );
    f.write(
      "main.js",
      'console.log("edited fixture"); if (import.meta.hot) import.meta.hot.accept();',
    );
    expect(JSON.parse(await update)).toMatchObject({ type: "update" });
  } finally {
    socket.terminate();
  }
  const installed = readFileSync(join(f.runtime, "project-installed.json"));
  expect((await f.run("status", null)).value).toMatchObject({ ready: true, phase: "ready" });
  expect((await f.run("restart")).value.ready).toBe(true);
  expect(readFileSync(join(f.runtime, "project-installed.json"))).toEqual(installed);
  expect(readFileSync(join(f.project, "package.json"))).toEqual(manifest);
  expect(readFileSync(join(f.project, "package-lock.json"))).toEqual(lock);
  expect(readFileSync(join(f.project, "vite.config.ts"), "utf8")).toBe(config);
  expect(JSON.parse(readFileSync(join(f.runtime, "environment.json"), "utf8"))).toEqual(f.defaults);
  expect(existsSync(join(f.project, "source-overwrite.txt"))).toBe(false);
  expect(statSync(join(f.runtime, "preview-vite.config.mjs")).mode & 0o777).toBe(0o600);
  // Explicit config still receives its mode and original plugins/settings.
  f.write("custom.config.ts", config);
  writeFileSync(
    join(f.runtime, "environment.json"),
    JSON.stringify({
      ...f.defaults,
      command: [...f.defaults.command, "--config", "custom.config.ts", "--mode", "alternate"],
    }),
  );
  expect((await f.run("restart")).value.ready).toBe(true);
  expect((await get("fixture-org.sprites.app", "/original-config")).body).toBe("serve:alternate");
  // Preserve Vite's automatic reload of the original config and its imports.
  f.write("config-message.ts", 'export const suffix = ":before";');
  const watched =
    'import { suffix } from "./config-message";\n' +
    config.replace('command + ":" + mode', 'command + ":" + mode + suffix');
  f.write("custom.config.ts", watched);
  await expect
    .poll(
      async () => {
        try {
          return (await get("fixture-org.sprites.app", "/original-config")).body;
        } catch {
          return "";
        }
      },
      { timeout: 10000 },
    )
    .toBe("serve:alternate:before");
  f.write("config-message.ts", 'export const suffix = ":after";');
  await expect
    .poll(
      async () => {
        try {
          return (await get("fixture-org.sprites.app", "/original-config")).body;
        } catch {
          return "";
        }
      },
      { timeout: 10000 },
    )
    .toBe("serve:alternate:after");

  // Do not change an existing project's deliberately disabled host check into an invalid array.
  f.write("custom.config.ts", config.replace('["existing.example.test"]', "true"));
  expect((await f.run("restart")).value.ready).toBe(true);
  expect((await get("unrelated.example.test")).status).toBe(200);
  f.write("custom.config.ts", config);
  // No project config is also valid, without creating one in the checkout.
  await f.run("stop");
  rmSync(join(f.project, "vite.config.ts"));
  rmSync(join(f.project, "custom.config.ts"));
  writeFileSync(join(f.runtime, "environment.json"), JSON.stringify(f.defaults));
  expect((await f.run("start")).value.ready).toBe(true);
  expect((await get("fixture-org.sprites.app")).status).toBe(200);
  expect((await get("unrelated.example.test")).status).toBe(403);
  expect(existsSync(join(f.project, "vite.config.ts"))).toBe(false);

  // Unsupported compound scripts retain their meaning and cannot falsely report Ready.
  const changed = JSON.parse(manifest.toString());
  changed.scripts.dev = "vite --clearScreen false";
  f.write("package.json", changed);
  const blocked = await f.run("restart");
  expect(blocked).toMatchObject({
    ok: false,
    error: expect.stringContaining("public preview hostname"),
  });
  expect((await f.run("status", null)).value).toMatchObject({
    ready: false,
    phase: "error",
    running: false,
  });
  // A legacy running service must also fail the public Host check on status-only reads.
  await execute("sprite-env", ["services", "start", "civic-spark-web-preview"], { env: f.env });
  await expect
    .poll(
      async () => {
        try {
          return (await get("localhost")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 10000 },
    )
    .toBe(200);
  expect((await f.run("status", null)).value).toMatchObject({
    ready: false,
    phase: "error",
    running: true,
  });
}, 60000);

it.each([
  ".sprites.app",
  ".fixture.sprites.app",
  "*.sprites.app",
  "fixture.sprites.app.evil.test",
  "fixture.sprites.app/path",
  "fixture.sprites.app:443",
])("rejects non-exact preview host %s without starting a service", async (host) => {
  const f = await fixture();
  expect(await f.run("start", host)).toMatchObject({
    ok: false,
    error: "Invalid preview hostname",
  });
  expect(existsSync(join(f.root, "service.json"))).toBe(false);
});
