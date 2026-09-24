import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Runner } from "../scripts/fly-setup.ts";
import { type BootstrapIO, bootstrap } from "../scripts/site-bootstrap.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const spriteToken = "sprite-org/org-id/token-id/token-value";

// A fake Fly account holding at most one app with one volume and one Machine.
function fakeFly() {
  const calls: string[][] = [];
  const staged: string[] = [];
  let app = false;
  let volume = false;
  let machine = false;
  const run: Runner = (args, input) => {
    calls.push(args);
    const op = args.slice(0, 2).join(" ");
    if (op === "auth whoami") return JSON.stringify({ email: "operator@example.test" });
    if (op === "orgs list") return JSON.stringify({ personal: "Operator" });
    if (op === "apps list")
      return JSON.stringify(
        app ? [{ Name: "harbor-day", Organization: { Slug: "personal" } }] : [],
      );
    if (op === "apps create") {
      app = true;
      return "{}";
    }
    if (op === "volumes list")
      return JSON.stringify(
        volume ? [{ id: "vol_1", name: "civic_spark_data", region: "ord", size_gb: 10 }] : [],
      );
    if (op === "volumes create") {
      volume = true;
      return "{}";
    }
    if (op === "machine list")
      return JSON.stringify(
        machine
          ? [
              {
                id: "m1",
                config: {
                  env: { CIVIC_SPARK_DEPLOYMENT: "hosted" },
                  mounts: [{ volume: "vol_1" }],
                },
              },
            ]
          : [],
      );
    if (op === "secrets import") {
      staged.push(input ?? "");
      return "";
    }
    if (args[0] === "deploy") {
      machine = true;
      return "";
    }
    throw new Error(`Unexpected fly ${args.join(" ")}`);
  };
  return { run, calls, staged };
}
function scripted(answers: Record<string, string>, secrets: string[], confirms: boolean[]) {
  const asked: string[] = [];
  const sent: { email: string; subject: string }[] = [];
  const health: object[] = [];
  const io: BootstrapIO = {
    async ask(question, fallback) {
      asked.push(question);
      const key = Object.keys(answers).find((prefix) => question.startsWith(prefix));
      return key ? (answers[key] ?? "") : (fallback ?? "");
    },
    async askSecret(question) {
      asked.push(question);
      const value = secrets.shift();
      if (value === undefined) throw new Error(`Unexpected secret prompt: ${question}`);
      return value;
    },
    async confirm(question) {
      asked.push(question);
      const value = confirms.shift();
      if (value === undefined) throw new Error(`Unexpected confirmation: ${question}`);
      return value;
    },
    log() {},
    request: (async (url: string) =>
      String(url).endsWith("/api/health")
        ? Response.json(health.shift() ?? { ok: true, proxyTrusted: true })
        : new Response("{}")) as typeof fetch,
    createSender: () => ({
      async send(message) {
        sent.push(message);
      },
    }),
    sleep: async () => {},
  };
  return { io, asked, sent, health };
}

it("asks for every answer and secret once, keeps them private and deploys", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-bootstrap-"));
  roots.push(root);
  const fly = fakeFly();
  const first = scripted(
    { "Site name": "harbor-day", "Gmail address": "Harbor.Signin@gmail.com" },
    [spriteToken, "not-an-app-password", "abcd efgh ijkl mnop"],
    [true, true],
  );
  // Fly's proxy turns out to use another address; setup trusts exactly that one.
  first.health.push({ ok: true, proxyTrusted: false, proxyPeer: "172.16.4.9" });
  const result = await bootstrap(root, undefined, { ...first.io, run: fly.run });
  expect(result.deployed).toBe(true);
  const directory = join(root, "harbor-day");
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  for (const file of ["setup.json", "secrets.json", "receipt.json"])
    expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8"));
  expect(setup).toMatchObject({
    app: "harbor-day",
    org: "personal",
    origin: "https://harbor-day.fly.dev",
    spriteOrg: "sprite-org",
    authMode: "email",
    owners: ["operator@example.test"],
    emailProvider: "gmail",
    emailFrom: "Civic Spark <harbor.signin@gmail.com>",
    proxyCidrs: ["172.16.4.9/32"],
  });
  const secrets = JSON.parse(readFileSync(join(directory, "secrets.json"), "utf8"));
  expect(secrets).toMatchObject({
    SPRITE_TOKEN: spriteToken,
    SMTP_USER: "harbor.signin@gmail.com",
    SMTP_PASSWORD: "abcdefghijklmnop",
  });
  expect(secrets.BETTER_AUTH_SECRET).toHaveLength(64);
  expect(first.sent).toEqual([
    expect.objectContaining({ email: "operator@example.test", subject: "Civic Spark email test" }),
  ]);
  expect(fly.calls.filter((call) => call[0] === "deploy")).toHaveLength(2);
  expect(fly.staged).toHaveLength(1);
  // Secrets reach Fly only through stdin, never as command arguments.
  expect(fly.calls.flat().join(" ")).not.toContain("abcdefghijklmnop");
  expect(fly.calls.flat().join(" ")).not.toContain(secrets.BETTER_AUTH_SECRET);

  // A rerun asks nothing but the go-ahead, keeps the auth secret and skips the email test.
  const again = scripted({}, [], [true]);
  await bootstrap(root, "harbor-day", { ...again.io, run: fly.run });
  expect(again.asked).toEqual(["Create or update this site on Fly now?"]);
  expect(again.sent).toEqual([]);
  expect(JSON.parse(readFileSync(join(directory, "secrets.json"), "utf8"))).toEqual(secrets);
  expect(fly.calls.filter((call) => call[1] === "create")).toHaveLength(2);
});

it("stops before touching Fly when declined or when the test email does not arrive", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-bootstrap-stop-"));
  roots.push(root);
  const fly = fakeFly();
  const declined = scripted(
    { "Site name": "harbor-day", "Sign-in mode": "demo", "Gmail address": "demo@gmail.com" },
    [spriteToken, "abcdefghijklmnop"],
    [false],
  );
  expect((await bootstrap(root, undefined, { ...declined.io, run: fly.run })).deployed).toBe(false);
  const lost = scripted({}, [], [true, false]);
  await expect(bootstrap(root, "harbor-day", { ...lost.io, run: fly.run })).rejects.toThrow(
    "would not arrive",
  );
  expect(
    fly.calls.filter(
      (call) => ["create", "import"].includes(call[1] ?? "") || call[0] === "deploy",
    ),
  ).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, "harbor-day/setup.json"), "utf8")).authMode).toBe(
    "demo",
  );
});

it("requires a Fly login first", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-bootstrap-login-"));
  roots.push(root);
  const { io } = scripted({}, [], []);
  await expect(
    bootstrap(root, "harbor-day", {
      ...io,
      run: () => {
        throw new Error("not logged in");
      },
    }),
  ).rejects.toThrow("fly auth login");
});
