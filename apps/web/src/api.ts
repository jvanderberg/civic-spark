// HTTP status lets callers retry transient busy/upstream responses automatically.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const apiStatus = (error: unknown) => (error instanceof ApiError ? error.status : undefined);
// Conditional GETs: unchanged polls return 304 and reuse the cached body, so
// the server sends no payload and the client parses nothing.
const cached = new Map<string, { etag: string; text: string }>();
const cacheLimit = 64;
export async function api<T>(path: string, method = "GET", body?: object): Promise<T> {
  const previous = method === "GET" ? cached.get(path) : undefined;
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(previous ? { "If-None-Match": previous.etag } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 304 && previous) return JSON.parse(previous.text) as T;
  if (response.status === 204 || response.status === 205) return undefined as T;
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(
      "The connection was interrupted while receiving the response. Check the workspace status before retrying.",
    );
  }
  const unavailable = `The Civic Spark server returned ${response.ok ? "an incomplete response" : `HTTP ${response.status}`}. Check the workspace status before retrying.`;
  if (!text.trim()) throw new Error(unavailable);
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    // A restarting development server or proxy can return empty/plain-text/HTML
    // errors. Never expose its raw body or turn it into a misleading JSON error.
    throw new Error(unavailable);
  }
  const etag = response.headers.get("etag");
  if (method === "GET" && response.ok && etag) {
    if (cached.size >= cacheLimit) cached.delete(cached.keys().next().value as string);
    cached.set(path, { etag, text });
  }
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result ? result.error : undefined;
    throw new ApiError(
      typeof error === "string" && error.trim() ? error : unavailable,
      response.status,
    );
  }
  return result as T;
}
