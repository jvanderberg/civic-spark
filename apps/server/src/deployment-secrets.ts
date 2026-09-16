const allowed = new Set([
  "SPRITE_TOKEN",
  "CIVIC_SPARK_PREVIEW_RELAY_SECRET",
  "BETTER_AUTH_SECRET",
  "RESEND_API_KEY",
  "SMTP_USER",
  "SMTP_PASSWORD",
]);

// Fly's import parser is not JSON/dotenv escaping compatible. The deployment
// helper sends a base64 JSON envelope on stdin; no secret appears in argv.
export function loadDeploymentSecrets(env: NodeJS.ProcessEnv = process.env) {
  const envelope = env.CIVIC_SPARK_SECRETS_B64;
  if (!envelope) return;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope)) throw new Error();
    const values: unknown = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
    const entries = Object.entries(values);
    for (const [key, value] of entries) {
      if (!allowed.has(key) || typeof value !== "string" || !value || /[\r\n\0]/.test(value))
        throw new Error();
    }
    for (const [key, value] of entries) env[key] = value;
    delete env.CIVIC_SPARK_SECRETS_B64;
  } catch {
    throw new Error("Invalid deployment secret envelope; restage the required credentials");
  }
}
