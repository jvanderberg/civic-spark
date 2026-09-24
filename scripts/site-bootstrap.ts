import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  deploy,
  emailSecrets,
  provision,
  type Runner,
  receiptPathFor,
  runFly,
  type Setup,
  SetupError,
  sendTestEmail,
  setupSchema,
  stageSecrets,
  verifySpriteToken,
} from "./fly-setup.ts";

// One command sets up or updates a site. Answers and secrets are kept outside the
// repository in a private per-site directory, so a rerun only asks for what is missing
// and never replaces the auth secret, which would sign everyone out.
export type BootstrapIO = {
  ask: (question: string, fallback?: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
  log: (message: string) => void;
  run?: Runner;
  request?: typeof fetch;
  createSender?: Parameters<typeof sendTestEmail>[3];
  sleep?: (ms: number) => Promise<void>;
};
const secretsSchema = z.record(z.string(), z.string());
const progressSchema = z.object({ testEmail: z.string().optional() }).passthrough();
const slug = /^[a-z0-9][a-z0-9-]{0,61}$/;
// Observed on the first live installation; the health check corrects it if Fly differs.
const initialProxyCidrs = ["172.16.10.2/32"];

export const defaultStateRoot = () =>
  process.env.CIVIC_SPARK_STATE_DIR ?? join(homedir(), ".local/state/civic-spark/sites");

function writePrivate(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

async function askUntil(
  io: BootstrapIO,
  question: string,
  valid: (value: string) => string | null,
  fallback?: string,
) {
  for (;;) {
    const answer = (await io.ask(question, fallback)).trim() || fallback || "";
    const problem = valid(answer);
    if (!problem) return answer;
    io.log(problem);
  }
}

export async function bootstrap(stateRoot: string, siteName: string | undefined, io: BootstrapIO) {
  const run = io.run ?? runFly;
  const request = io.request ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  let operator: string;
  try {
    operator = z
      .object({ email: z.email() })
      .parse(JSON.parse(run(["auth", "whoami", "--json"]))).email;
  } catch (error) {
    if (error instanceof SetupError && error.message.includes("0.4.104")) throw error;
    throw new SetupError("Log in to Fly first with `fly auth login`, then run this again.");
  }
  io.log(`Fly account: ${operator}`);

  const app =
    siteName ??
    (await askUntil(io, "Site name (the address becomes https://<name>.fly.dev)", (value) =>
      slug.test(value) ? null : "Use lowercase letters, digits and hyphens.",
    ));
  if (!slug.test(app)) throw new SetupError("Use lowercase letters, digits and hyphens.");
  const directory = join(stateRoot, app);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const setupPath = join(directory, "setup.json");
  const secretsPath = join(directory, "secrets.json");
  const progressPath = join(directory, "bootstrap.json");
  const receiptPath = receiptPathFor(setupPath, app);

  const secrets = existsSync(secretsPath) ? secretsSchema.parse(readJson(secretsPath)) : {};
  let input: Setup;
  if (existsSync(setupPath)) {
    input = setupSchema.parse(readJson(setupPath));
    io.log(`Using saved settings in ${setupPath}`);
  } else {
    const orgs = Object.keys(
      z.record(z.string(), z.string()).parse(JSON.parse(run(["orgs", "list", "--json"]))),
    );
    const org =
      orgs.length === 1 && orgs[0]
        ? orgs[0]
        : await askUntil(
            io,
            `Fly organization (${orgs.join(", ")})`,
            (value) => (orgs.includes(value) ? null : `Choose one of: ${orgs.join(", ")}`),
            orgs.includes("personal") ? "personal" : orgs[0],
          );
    const region = await askUntil(
      io,
      "Fly region",
      (value) => (/^[a-z]{3}$/.test(value) ? null : "Use a three-letter Fly region such as ord."),
      "ord",
    );
    const authMode = await askUntil(
      io,
      "Sign-in mode: email (everyone gets a code) or demo (participants just type an email)",
      (value) => (["email", "demo"].includes(value) ? null : "Answer email or demo."),
      "email",
    );
    const owners = (
      await askUntil(
        io,
        "Owner emails, comma-separated (they create events and always sign in with a code)",
        (value) =>
          value
            .split(",")
            .map((owner) => owner.trim())
            .every((owner) => z.email().safeParse(owner).success)
            ? null
            : "Enter one or more email addresses.",
        operator,
      )
    )
      .split(",")
      .map((owner) => owner.trim().toLowerCase());
    const sender = (
      await askUntil(
        io,
        "Gmail address that sends sign-in codes",
        (value) => (z.email().safeParse(value).success ? null : "Enter an email address."),
        secrets.SMTP_USER,
      )
    ).toLowerCase();
    secrets.SMTP_USER = sender;
    if (!secrets.SPRITE_TOKEN) secrets.SPRITE_TOKEN = await askSpriteToken(io);
    input = setupSchema.parse({
      app,
      org,
      region,
      origin: `https://${app}.fly.dev`,
      spriteOrg: secrets.SPRITE_TOKEN.split("/")[0],
      authMode,
      owners,
      emailProvider: "gmail",
      emailFrom: `Civic Spark <${sender}>`,
      proxyCidrs: initialProxyCidrs,
      volumeGb: 10,
      volumeAutoExtend: { enabled: true, thresholdPercent: 80, incrementGb: 5, ceilingGb: 50 },
      managementCpuKind: "performance",
      managementCpus: 1,
      managementMemoryMb: 4096,
      maxProvisioning: 5,
    });
  }
  if (!secrets.SPRITE_TOKEN) secrets.SPRITE_TOKEN = await askSpriteToken(io, input.spriteOrg);
  if (!secrets.SMTP_USER)
    secrets.SMTP_USER = /<([^<>]+)>/.exec(input.emailFrom ?? "")?.[1] ?? input.emailFrom ?? "";
  for (;;) {
    if (!secrets.SMTP_PASSWORD)
      secrets.SMTP_PASSWORD = await io.askSecret(
        `Gmail app password for ${secrets.SMTP_USER} (16 letters, from myaccount.google.com/apppasswords)`,
      );
    try {
      Object.assign(secrets, emailSecrets(input, secrets));
      break;
    } catch (error) {
      if (!(error instanceof SetupError) || !error.message.includes("app password")) throw error;
      io.log(error.message);
      delete secrets.SMTP_PASSWORD;
    }
  }
  // Generated once; replacing it would end every signed-in session.
  secrets.BETTER_AUTH_SECRET ??= randomBytes(48).toString("base64url");
  writePrivate(setupPath, input);
  writePrivate(secretsPath, secrets);

  io.log(
    [
      "",
      `Site:     ${input.origin}`,
      `Fly:      app ${input.app} in ${input.org}, region ${input.region}`,
      `Sign-in:  ${input.authMode === "demo" ? "demo (participants type an email)" : "email code"}; owners ${input.owners.join(", ")}`,
      `Email:    ${input.emailFrom}`,
      `Sprites:  organization ${input.spriteOrg}`,
      `Saved in: ${directory}`,
      "",
    ].join("\n"),
  );
  if (!(await io.confirm("Create or update this site on Fly now?"))) {
    io.log("Nothing changed on Fly. Run this again to continue.");
    return { input, directory, deployed: false };
  }

  io.log("Checking the Sprite token…");
  await verifySpriteToken(secrets.SPRITE_TOKEN, input.spriteOrg, request);
  const progress = existsSync(progressPath) ? progressSchema.parse(readJson(progressPath)) : {};
  const emailCheck = `${input.emailFrom} -> ${input.owners[0]}`;
  if (progress.testEmail !== emailCheck) {
    const recipient = input.owners[0] ?? operator;
    io.log(`Sending a test email to ${recipient}…`);
    await sendTestEmail(input, secrets, recipient, io.createSender);
    if (!(await io.confirm(`Did the test email reach ${recipient}'s inbox, not spam?`)))
      throw new SetupError(
        "Sign-in codes would not arrive reliably. Check the Gmail address and app password, then run this again.",
      );
    writePrivate(progressPath, { ...progress, testEmail: emailCheck });
  }

  io.log("Creating the app and its storage if needed…");
  try {
    provision(input, receiptPath, run);
  } catch (error) {
    if (
      !existsSync(receiptPath) &&
      error instanceof SetupError &&
      /apps create/.test(error.message)
    )
      throw new SetupError(
        `Fly would not create "${input.app}". The name may be taken; run again with another name.`,
      );
    throw error;
  }
  stageSecrets(input, receiptPath, secrets, run);
  for (let attempt = 0; ; attempt++) {
    io.log("Deploying (this takes a few minutes)…");
    deploy(input, receiptPath, run);
    const health = await waitForHealth(input.origin, request, sleep);
    if (health.proxyTrusted !== false) break;
    // Fly's proxy reached the app from an unexpected address; trust exactly that one.
    if (attempt > 0 || !health.proxyPeer)
      throw new SetupError("The app cannot identify visitors' addresses behind Fly's proxy.");
    io.log(`Trusting Fly's proxy at ${health.proxyPeer} and redeploying…`);
    input = setupSchema.parse({ ...input, proxyCidrs: [`${health.proxyPeer}/32`] });
    writePrivate(setupPath, input);
  }
  io.log(
    `\nReady: ${input.origin}\nSign in as ${input.owners[0]} with the emailed code, then create your event.`,
  );
  return { input, directory, deployed: true };
}

async function askSpriteToken(io: BootstrapIO, org?: string) {
  for (;;) {
    const token = (
      await io.askSecret("Sprite token (create one in the Sprites dashboard for your organization)")
    ).trim();
    const tokenOrg = token.split("/")[0] ?? "";
    if (token.split("/").length >= 4 && slug.test(tokenOrg) && (!org || org === tokenOrg))
      return token;
    io.log(
      org
        ? `That is not a token for the Sprite organization ${org}.`
        : "That does not look like a Sprite token (organization/id/token-id/value).",
    );
  }
}

const healthSchema = z.object({
  ok: z.literal(true),
  proxyTrusted: z.boolean().optional(),
  proxyPeer: z.string().optional(),
});
async function waitForHealth(
  origin: string,
  request: typeof fetch,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < 36; attempt++) {
    try {
      const response = await request(`${origin}/api/health`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return healthSchema.parse(await response.json());
    } catch {
      // Starting up or DNS not yet propagated; retry.
    }
    await sleep(5000);
  }
  throw new SetupError(`${origin} did not become healthy. Check \`fly logs -a <app>\`.`);
}

function terminalIO(): BootstrapIO {
  const ask = async (question: string, fallback?: string) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await prompt.question(`${question}${fallback ? ` [${fallback}]` : ""}: `);
    } finally {
      prompt.close();
    }
  };
  return {
    ask,
    async confirm(question) {
      return /^y(es)?$/i.test((await ask(`${question} (y/N)`)).trim());
    },
    askSecret(question) {
      const { stdin, stdout } = process;
      if (!stdin.isTTY) throw new SetupError("Run this in an interactive terminal.");
      stdout.write(`${question}: `);
      return new Promise((done, fail) => {
        let value = "";
        const finish = () => {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
        };
        const onData = (chunk: Buffer) => {
          for (const character of chunk.toString("utf8")) {
            if (character === "\r" || character === "\n") {
              finish();
              return done(value);
            }
            if (character === "\u0003") {
              finish();
              return fail(new SetupError("Cancelled."));
            }
            if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
            else if (character >= " ") value += character;
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
      });
    },
    log: (message) => console.log(message),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const site = process.argv[2];
  bootstrap(defaultStateRoot(), site, terminalIO()).catch((error: unknown) => {
    console.error(
      error instanceof SetupError
        ? error.message
        : error instanceof z.ZodError
          ? `Invalid saved settings: ${error.issues.map((issue) => issue.message).join("; ")}`
          : "Setup failed. Provider diagnostics and secret values were suppressed.",
    );
    process.exitCode = 1;
  });
}
