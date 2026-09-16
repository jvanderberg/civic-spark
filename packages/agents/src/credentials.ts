// Native CLI configuration lives in the Sprite home, never in the project checkout.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { agentModels } from "./protocol.ts";

type Provider = keyof typeof agentModels;
export class CredentialConfigurationError extends Error {
  constructor() {
    super(
      "Could not save the agent settings in this Sprite. Check home-directory permissions and JSON configuration, then reconnect.",
    );
    this.name = "CredentialConfigurationError";
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CredentialConfigurationError();
  return value as Record<string, unknown>;
}
function read(path: string): Record<string, unknown> {
  return existsSync(path) ? object(JSON.parse(readFileSync(path, "utf8"))) : {};
}
function write(path: string, value: object) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function saveCredential(
  home: string,
  provider: Provider,
  key: string,
  workspaceId?: string | null,
) {
  try {
    if (!key.trim()) throw new CredentialConfigurationError();
    if (provider === "opencode") {
      const auth = join(home, ".local/share/opencode/auth.json");
      const config = join(home, ".config/opencode/opencode.json");
      // Read both first: malformed existing settings must never replace a working key.
      const oldAuth = read(auth);
      const oldConfig = read(config);
      write(config, { ...oldConfig, model: agentModels.opencode.model, permission: "allow" });
      write(auth, { ...oldAuth, openrouter: { type: "api", key } });
    } else {
      const path = join(home, ".claude/settings.json");
      const settings = read(path);
      const env = settings.env === undefined ? {} : object(settings.env);
      if (workspaceId !== undefined) {
        const previous =
          typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" ? env.ANTHROPIC_CUSTOM_HEADERS : "";
        const headers = previous
          .split("\n")
          .filter((line) => line.trim() && !/^anthropic-workspace-id\s*:/i.test(line));
        if (workspaceId) {
          if (!/^wrkspc_[A-Za-z0-9]+$/.test(workspaceId)) throw new CredentialConfigurationError();
          headers.push(`anthropic-workspace-id: ${workspaceId}`);
        }
        if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
        else delete env.ANTHROPIC_CUSTOM_HEADERS;
      }
      write(path, {
        ...settings,
        model: agentModels.claude.model,
        permissions: {
          ...(settings.permissions === undefined ? {} : object(settings.permissions)),
          defaultMode: "bypassPermissions",
        },
        env: {
          ...env,
          ANTHROPIC_API_KEY: key,
        },
      });
    }
  } catch {
    // JSON parser and filesystem errors can include private file contents or paths.
    throw new CredentialConfigurationError();
  }
}
export function loadCredentials(home: string): Partial<Record<Provider, string>> {
  const keys: Partial<Record<Provider, string>> = {};
  try {
    const auth = read(join(home, ".local/share/opencode/auth.json"));
    const router = auth.openrouter as { type?: string; key?: string } | undefined;
    if (router?.type === "api" && typeof router.key === "string" && router.key.trim())
      keys.opencode = router.key;
  } catch {
    /* One malformed provider file must not block the other provider. */
  }
  try {
    const settings = read(join(home, ".claude/settings.json"));
    const env = settings.env as { ANTHROPIC_API_KEY?: string } | undefined;
    if (typeof env?.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim())
      keys.claude = env.ANTHROPIC_API_KEY;
  } catch {
    /* Configure reports a sanitized settings error if a file cannot be updated. */
  }
  return keys;
}

export function claudeEnvironment(
  home: string,
  inherited: NodeJS.ProcessEnv,
  key?: string,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  try {
    const settings = read(join(home, ".claude/settings.json"));
    const saved = object(settings.env ?? {});
    if (typeof saved.ANTHROPIC_CUSTOM_HEADERS === "string")
      env.ANTHROPIC_CUSTOM_HEADERS = saved.ANTHROPIC_CUSTOM_HEADERS;
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
    if (typeof saved.ANTHROPIC_API_KEY === "string")
      env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
  } catch {
    /* A missing/malformed settings file is handled when the key is configured. */
  }
  if (key) env.ANTHROPIC_API_KEY = key;
  return env;
}
export function claudeWorkspaceId(home: string): string | undefined {
  const headers = claudeEnvironment(home, {}).ANTHROPIC_CUSTOM_HEADERS;
  return headers
    ?.split("\n")
    .map((line) => /^anthropic-workspace-id\s*:\s*(wrkspc_[A-Za-z0-9]+)\s*$/i.exec(line)?.[1])
    .find(Boolean);
}
