export async function api<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204 || response.status === 205) return undefined as T;
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(
      "The connection was interrupted while receiving the response. Check the workspace status before retrying.",
    );
  }
  const unavailable = `The VibeHack server returned ${response.ok ? "an incomplete response" : `HTTP ${response.status}`}. Check the workspace status before retrying.`;
  if (!text.trim()) throw new Error(unavailable);
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    // A restarting development server or proxy can return empty/plain-text/HTML
    // errors. Never expose its raw body or turn it into a misleading JSON error.
    throw new Error(unavailable);
  }
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result ? result.error : undefined;
    throw new Error(typeof error === "string" && error.trim() ? error : unavailable);
  }
  return result as T;
}
