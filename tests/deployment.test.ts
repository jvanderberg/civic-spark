import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import {
  acquireWriter,
  clientAddress,
  deploymentSettings,
  validateDeployment,
} from "../apps/server/src/deployment.ts";
import { loadDeploymentSecrets } from "../apps/server/src/deployment-secrets.ts";
import { WorkspaceIntegrations } from "../apps/server/src/integrations.ts";
import { TerminalSessions } from "../apps/server/src/terminal.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { validateSpriteToken } from "../packages/sprites/src/credentials.ts";
import {
  authorizeExisting,
  flyConfig,
  provision,
  type Runner,
  secretInput,
  setupSchema,
} from "../scripts/fly-setup.ts";
import { testIdentity } from "./auth-fixture.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const origin = "https://event.example.test";
const env = {
  CIVIC_SPARK_DEPLOYMENT: "hosted",
  BETTER_AUTH_SECRET: "test-only-".repeat(6),
  CIVIC_SPARK_EMAIL_PROVIDER: "resend",
};
const settings = setupSchema.parse({
  app: "civic-spark-test",
  org: "test-org",
  region: "ord",
  origin,
  spriteOrg: "test-sprites",
  emailProvider: "resend",
  emailFrom: "Test <signin@example.test>",
  proxyCidrs: ["172.19.0.0/16"],
});
it("rejects public prototype binding, insecure hosted settings and general Fly credentials", () => {
  expect(() => validateDeployment("/data", origin, "prototype", env)).toThrow("loopback");
  expect(() =>
    validateDeployment("/data", "http://localhost:4310", "prototype", {
      CIVIC_SPARK_HOST: "0.0.0.0",
    }),
  ).toThrow("loopback");
  expect(() => validateDeployment("/data", "http://event.example.test", "email", env)).toThrow(
    "HTTPS",
  );
  expect(() =>
    validateDeployment("/data", origin, "email", {
      ...env,
      CIVIC_SPARK_EMAIL_PROVIDER: "disabled",
    }),
  ).toThrow("SMTP or Resend");
  expect(() =>
    validateDeployment("/data", origin, "email", { ...env, FLY_API_TOKEN: "test-only" }),
  ).toThrow("administration");
  expect(() =>
    validateDeployment("/data", origin, "email", { ...env, BETTER_AUTH_SECRET: "short" }),
  ).toThrow("32");
  expect(() => deploymentSettings({ ...env, CIVIC_SPARK_PROXY: "fly" })).toThrow("CIDRs");
  expect(() => validateSpriteToken("wrong/id/token/secret", "selected")).toThrow("selected");
  expect(() => validateSpriteToken("selected/opaque", "selected")).toThrow("format");
  expect(validateSpriteToken("selected/id/token/secret", "selected")).toBe(
    "selected/id/token/secret",
  );
});
it("trusts only configured immediate proxy peers and ignores spoofed forwarding chains", () => {
  const config = deploymentSettings({
    CIVIC_SPARK_PROXY: "fly",
    CIVIC_SPARK_TRUSTED_PROXY_CIDRS: "172.19.0.0/16",
  });
  const headers = {
    "fly-client-ip": "203.0.113.9",
    "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    "x-civic-spark-client-ip": "8.8.8.8",
  };
  expect(clientAddress("198.51.100.1", headers, config)).toBe("198.51.100.1");
  expect(clientAddress("172.19.1.2", headers, config)).toBe("203.0.113.9");
  expect(clientAddress("::ffff:172.19.1.2", headers, config)).toBe("203.0.113.9");
  expect(clientAddress("172.19.1.2", { "fly-client-ip": "1.1.1.1, 2.2.2.2" }, config)).toBe(
    "172.19.1.2",
  );
});
it("allows one writer and releases the storage lock for restart", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-lock-"));
  try {
    const release = acquireWriter(root);
    expect(() => acquireWriter(root)).toThrow("active");
    release();
    acquireWriter(root)();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("enforces canonical production origin, verified sessions, secure cookies, health and websocket ownership", async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("CIVIC_SPARK_PROXY", "fly");
  vi.stubEnv("CIVIC_SPARK_TRUSTED_PROXY_CIDRS", "172.19.0.0/16");
  const root = mkdtempSync(join(tmpdir(), "civic-spark-hosted-"));
  const messages: string[] = [];
  const delivery = {
    configured: true,
    async send(input: { url: string }) {
      messages.push(input.url);
    },
  };
  const { app, authentication, service } = await createApp(root, true, origin, delivery, "email");
  try {
    const signed = await testIdentity(authentication, "Hosted Owner");
    const other = await testIdentity(authentication, "Hosted Other");
    const unverified = await testIdentity(authentication, "Unverified", false);
    const headers = { host: "event.example.test", origin, cookie: signed.cookie };
    expect(signed.browserCookie.name).toMatch(/^__Secure-/);
    expect(
      (await app.inject({ url: "/api/state", headers: { ...headers, cookie: unverified.cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...headers, origin: "http://event.example.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...headers, host: "evil.test", "x-forwarded-host": "event.example.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: {
            ...headers,
            "x-forwarded-host": "evil.test",
            "x-forwarded-proto": "http",
            "x-forwarded-for": "1.1.1.1",
            "fly-client-ip": "1.1.1.1",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/health", headers: { host: "event.example.test" } })).json(),
    ).toEqual({ ok: true });
    const health = vi.spyOn(service, "checkHealth").mockImplementation(() => {
      throw new Error("private storage diagnostic");
    });
    const failed = await app.inject({
      url: "/api/health",
      headers: { host: "event.example.test" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("private");
    health.mockRestore();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/prototype/sign-in",
          headers,
          payload: { email: "any@example.test" },
        })
      ).statusCode,
    ).toBe(404);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      headers: { host: "event.example.test", origin, "x-forwarded-proto": "http" },
      payload: { email: "real@example.test", callbackURL: "/" },
    });
    expect(login.statusCode).toBe(200);
    expect(messages).toHaveLength(1);
    const verify = await app.inject({
      url: new URL(messages[0] as string).pathname + new URL(messages[0] as string).search,
      headers: { host: "event.example.test" },
    });
    expect(String(verify.headers["set-cookie"])).toMatch(/; Secure/i);
    if (!signed.actor) throw new Error("Missing test actor");
    const event = service.createEvent(signed.actor, {
      name: "Hosted",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    });
    if (!event.ok) throw new Error(event.error);
    const team = service.createTeam(signed.actor, {
      eventId: event.value.id,
      name: "Private",
      projectId: "data-starter",
    });
    if (!team.ok) throw new Error(team.error);
    service.setSprite(team.value.workspace.id, "civic-spark-test", "ready", null, "ready");
    const agent = vi
      .spyOn(AgentSessions.prototype, "attach")
      .mockImplementation((_id, _sprite, socket) => socket.close(1000));
    const terminal = vi
      .spyOn(TerminalSessions.prototype, "attach")
      .mockImplementation((_id, _sprite, socket) => socket.close(1000));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const closeCode = (path: string, cookie: string, requestOrigin = origin) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          `${address.replace("http", "ws")}/api/workspaces/${team.value.workspace.id}/${path}`,
          { headers: { host: "event.example.test", origin: requestOrigin, cookie } },
        );
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
        socket.once("close", resolve);
        socket.once("error", reject);
      });
    for (const path of ["terminal", "agent"]) {
      expect(await closeCode(path, other.cookie)).toBe(1008);
      expect(await closeCode(path, signed.cookie, "http://event.example.test")).toBe(403);
      expect(await closeCode(path, signed.cookie)).toBe(1000);
    }
    expect(agent).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    const integrations = new WorkspaceIntegrations(service, root, new Set(), origin);
    const preview = vi.spyOn(SpriteClient.prototype, "preview");
    await expect(
      integrations.openPreview(team.value.workspace.id, signed.actor, async () => true),
    ).rejects.toThrow("Hosted preview");
    expect(preview).not.toHaveBeenCalled();
    integrations.close();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("plans a single-writer volume deployment and safely stages only allowed secrets", () => {
  const config = flyConfig(settings);
  expect(config).toContain('strategy = "immediate"');
  expect(config).toContain('destination = "/data"');
  expect(config).toContain('auto_stop_machines = "off"');
  expect(config).not.toContain("SPRITE_TOKEN");
  const secrets = {
    SPRITE_TOKEN: "test-sprites/org/id/test-only",
    BETTER_AUTH_SECRET: "a".repeat(32),
    RESEND_API_KEY: "test-only",
  };
  expect(secretInput(settings, secrets)).toMatch(/^CIVIC_SPARK_SECRETS_B64=[A-Za-z0-9+/=]+\n$/);
  expect(() => secretInput(settings, { ...secrets, FLY_API_TOKEN: "forbidden" })).toThrow(
    "Unsupported",
  );
  expect(() => secretInput(settings, { ...secrets, RESEND_API_KEY: "bad\nINJECT=1" })).toThrow(
    "multiline",
  );
});
it("provisions idempotently, validates ownership and refuses extra Machines or unexpected volumes", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-setup-"));
  const receipt = join(root, "receipt.json");
  const calls: string[][] = [];
  let app = false;
  let volume = false;
  let extra = false;
  const run: Runner = (args) => {
    calls.push(args);
    const op = args.slice(0, 2).join(" ");
    if (op === "apps list")
      return JSON.stringify(
        app ? [{ Name: settings.app, Organization: { Slug: settings.org } }] : [],
      );
    if (op === "apps create") {
      app = true;
      return "{}";
    }
    if (op === "volumes list")
      return JSON.stringify(
        volume ? [{ id: "vol_1", name: "civic_spark_data", region: "ord", size_gb: 10 }] : [],
      );
    if (op === "machine list") return JSON.stringify(extra ? [{ id: "unexpected" }] : []);
    if (op === "volumes create") {
      volume = true;
      return "{}";
    }
    throw new Error("Unexpected operation");
  };
  try {
    provision(settings, receipt, run);
    provision(settings, receipt, run);
    expect(calls.filter((x) => x[0] === "apps" && x[1] === "create")).toHaveLength(1);
    expect(calls.filter((x) => x[0] === "volumes" && x[1] === "create")).toHaveLength(1);
    expect(authorizeExisting(settings, receipt, run).volumes).toHaveLength(1);
    writeFileSync(receipt, JSON.stringify({ app: settings.app, org: settings.org, region: "iad" }));
    expect(() => authorizeExisting(settings, receipt, run)).toThrow("receipt");
    writeFileSync(receipt, JSON.stringify({ app: settings.app, org: settings.org, region: "ord" }));
    expect(() =>
      authorizeExisting(settings, receipt, () =>
        JSON.stringify([{ Name: settings.app, Organization: { Slug: "wrong" } }]),
      ),
    ).toThrow("organization");
    extra = true;
    expect(() => provision(settings, receipt, run)).toThrow("Machines");
    expect(() => provision({ ...settings, org: "another" }, receipt, run)).toThrow("organization");
    expect(() => provision(settings, join(root, "missing"), run)).toThrow("receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("build context defaults to deny and excludes nested secrets and local state", () => {
  const ignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  expect(ignore.split("\n").filter((x) => x && !x.startsWith("#"))[0]).toBe("**");
  for (const pattern of [
    "**/.env",
    "**/.env.*",
    "**/.data/**",
    "**/.git/**",
    "**/node_modules/**",
    "**/artifacts/**",
    "**/*.key",
    "**/*secrets*",
  ])
    expect(ignore).toContain(pattern);
  expect(ignore).not.toContain("!deploy/**");
  expect(ignore).not.toContain("!scripts/**");
});

it("round-trips secret punctuation and rejects malformed envelopes without partial mutation", () => {
  const secrets = {
    SPRITE_TOKEN: "test-sprites/org/id/test-only",
    BETTER_AUTH_SECRET: "a".repeat(32),
    RESEND_API_KEY: `  dollar$HOME back\\slash 'single' "double" #hash = equals \${ENV}	  `,
  };
  const encoded = secretInput(settings, secrets);
  // The pinned Fly parser leaves this safe, unquoted base64 alphabet unchanged.
  const target: NodeJS.ProcessEnv = {
    CIVIC_SPARK_SECRETS_B64: encoded.trim().slice(encoded.indexOf("=") + 1),
  };
  loadDeploymentSecrets(target);
  expect(target).toEqual(secrets);
  for (const value of [
    "not base64!",
    Buffer.from('{"BETTER_AUTH_SECRET":"sensitive').toString("base64"),
    Buffer.from(JSON.stringify({ ...secrets, FLY_API_TOKEN: "sensitive" })).toString("base64"),
    Buffer.from(JSON.stringify({ ...secrets, SMTP_PASSWORD: 42 })).toString("base64"),
  ]) {
    const env: NodeJS.ProcessEnv = {
      BETTER_AUTH_SECRET: "unchanged",
      CIVIC_SPARK_SECRETS_B64: value,
    };
    expect(() => loadDeploymentSecrets(env)).toThrow(
      /^Invalid deployment secret envelope; restage the required credentials$/,
    );
    expect(env.BETTER_AUTH_SECRET).toBe("unchanged");
    expect(env.SPRITE_TOKEN).toBeUndefined();
  }
});

it("recovers durable provisioning, sessions and Git after restart without automatic cloud work", async () => {
  vi.stubEnv("CIVIC_SPARK_MAX_SPRITES", "1");
  const root = mkdtempSync(join(tmpdir(), "civic-spark-restart-"));
  const create = vi.spyOn(SpriteClient.prototype, "create");
  const exec = vi.spyOn(SpriteClient.prototype, "exec");
  let current = await createApp(root, true, "http://127.0.0.1:4310", undefined, "email");
  try {
    const owner = await testIdentity(current.authentication, "Restart Owner");
    if (!owner.actor) throw new Error("Missing actor");
    const event = current.service.createEvent(owner.actor, {
      name: "Restart",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    });
    if (!event.ok) throw new Error(event.error);
    const team = current.service.createTeam(owner.actor, {
      eventId: event.value.id,
      name: "Retained",
      projectId: "data-starter",
    });
    if (!team.ok) throw new Error(team.error);
    const second = current.service.createTeam(owner.actor, {
      eventId: event.value.id,
      name: "Another",
      projectId: "data-starter",
    });
    if (!second.ok) throw new Error(second.error);
    const workspace = team.value.workspace;
    const sprite = `civic-spark-${workspace.id}`;
    current.service.setSprite(workspace.id, sprite, "provisioning", null, "checkout");
    writeFileSync(join(current.service.workspacePath(workspace.id), "draft.txt"), "Retained edit");
    await current.app.close();
    current = await createApp(root, true, "http://127.0.0.1:4310", undefined, "email");
    const headers = { cookie: owner.cookie, origin: "http://127.0.0.1:4310" };
    const status = await current.app.inject({
      url: `/api/workspaces/${workspace.id}/sprite`,
      headers,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      spriteName: sprite,
      spriteStatus: "error",
      spriteError: expect.stringContaining("restart"),
    });
    expect(
      readFileSync(join(current.service.workspacePath(workspace.id), "draft.txt"), "utf8"),
    ).toBe("Retained edit");
    const limit = await current.app.inject({
      method: "POST",
      url: `/api/workspaces/${second.value.workspace.id}/sprite`,
      headers,
    });
    expect(limit.statusCode).toBe(409);
    expect(limit.body).toContain("workspace limit");
    expect(create).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    await current.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
