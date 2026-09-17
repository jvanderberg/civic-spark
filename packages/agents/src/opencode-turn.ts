import { randomBytes } from "node:crypto";

// Match the pinned runtime's ascending message ID format and sort order:
// https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/id/id.ts
export function openCodeMessageID() {
  const timestamp = BigInt.asUintN(48, BigInt(Date.now()) * 4096n)
    .toString(16)
    .padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const suffix = Array.from(randomBytes(14), (byte) => alphabet[byte % 62]).join("");
  return `msg_${timestamp}${suffix}`;
}

export type OpenCodeTurnMessage = {
  id: string;
  sessionID?: string;
  role: "user" | "assistant";
  parentID?: string;
  error?: unknown;
  time?: { created?: number; completed?: number };
  finish?: string;
  cost?: number;
};

export type OpenCodeTurnEvent = {
  type: string;
  properties?: {
    sessionID?: string;
    info?: OpenCodeTurnMessage;
    status?: { type: string };
    error?: unknown;
  };
};

export type OpenCodeTurnRecord = { info: OpenCodeTurnMessage };
export type OpenCodeTurnOutcome =
  | { outcome: "success"; cost?: number }
  | { outcome: "failed"; error: unknown }
  | { outcome: "stopped" };

export class OpenCodeTransportError extends Error {
  constructor() {
    super("The local OpenCode runtime transport did not confirm this turn.");
    this.name = "OpenCodeTransportError";
  }
}

// Connection refusal from both authenticated loopback control reads is distinct
// from timeouts: the server is no longer listening, rather than possibly busy.
export function isOpenCodeConnectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; cause?: unknown };
  return value.code === "ECONNREFUSED" || isOpenCodeConnectionRefused(value.cause);
}

function isFinished(message: OpenCodeTurnMessage) {
  return (
    Boolean(message.error) ||
    (Boolean(message.finish) && message.finish !== "tool-calls" && message.finish !== "unknown")
  );
}

/**
 * Correlates one async prompt with its native OpenCode messages and idle state.
 * An assistant message is only a completion candidate: tool-call steps can have
 * a finish value while the session remains busy. The idle transition is the
 * terminal boundary for the current user message.
 */
export class OpenCodeTurnTracker {
  eventRevision = 0;
  private accepted = false;
  private currentUser = false;
  private idle = false;
  private assistantComplete = false;
  private assistantID: string | undefined;
  private assistantCost: number | undefined;
  private providerError: unknown;
  private stopRequested = false;
  private stopConfirmed = false;
  private authoritativeIdle = false;
  private terminal: OpenCodeTurnOutcome | undefined;

  readonly sessionID: string;
  readonly userMessageID: string;

  constructor(sessionID: string, userMessageID: string) {
    this.sessionID = sessionID;
    this.userMessageID = userMessageID;
  }

  markAccepted() {
    this.accepted = true;
  }

  markSubmissionStarted() {
    this.idle = false;
    this.authoritativeIdle = false;
  }

  confirmStop() {
    this.stopConfirmed = true;
    this.idle = false;
    this.authoritativeIdle = false;
  }

  requestStop() {
    this.stopRequested = true;
  }

  fail(error: unknown): OpenCodeTurnOutcome {
    if (!this.terminal) {
      this.terminal = { outcome: "failed", error };
    }
    return this.terminal;
  }

  get hasAccepted() {
    return this.accepted;
  }

  get hasCurrentUser() {
    return this.currentUser;
  }

  get isStopRequested() {
    return this.stopRequested;
  }

  get isAuthoritativelyIdle() {
    return this.authoritativeIdle;
  }

  get result() {
    return this.terminal;
  }

  observe(event: OpenCodeTurnEvent) {
    this.eventRevision++;
    const properties = event.properties;
    if (properties?.sessionID && properties.sessionID !== this.sessionID) return;
    if (event.type === "message.updated" && properties?.info) {
      this.observeMessage(properties.info);
    } else if (event.type === "session.status") {
      this.observeStatus(properties?.status?.type);
    } else if (event.type === "session.idle") {
      this.observeStatus("idle");
    } else if (event.type === "session.error" && properties?.error) {
      // session.error has no message ID in this SDK. It is safe to use only
      // after this turn's user message has been observed.
      if (this.currentUser) this.providerError = properties.error;
    }
  }

  reconcile(
    status: { type?: string } | undefined,
    messages: OpenCodeTurnRecord[] | undefined,
    authoritativeStatus = false,
  ) {
    for (const message of messages ?? []) this.observeMessage(message.info);
    if (status) this.observeStatus(status.type, authoritativeStatus);
    else if (authoritativeStatus) this.observeStatus("idle", true);
    if (authoritativeStatus) this.trySettle();
  }

  private observeMessage(message: OpenCodeTurnMessage) {
    if (message.sessionID && message.sessionID !== this.sessionID) return;
    if (message.role === "user" && message.id === this.userMessageID) {
      if (!this.currentUser) {
        this.idle = false;
        this.authoritativeIdle = false;
      }
      this.currentUser = true;
      return;
    }
    if (message.role !== "assistant" || message.parentID !== this.userMessageID) return;
    if (!this.currentUser) {
      this.idle = false;
      this.authoritativeIdle = false;
    }
    this.currentUser = true;
    if (message.id !== this.assistantID) {
      this.assistantID = message.id;
      this.assistantComplete = false;
      this.idle = false;
      this.authoritativeIdle = false;
    }
    if (message.error) this.providerError = message.error;
    if (isFinished(message)) {
      this.assistantComplete = true;
      this.assistantCost = message.cost;
    }
  }

  private observeStatus(type: string | undefined, authoritative = false) {
    if (type === "idle") {
      this.authoritativeIdle = authoritative;
      if (this.currentUser) this.idle = true;
    } else if (type === "busy" || type === "retry") {
      this.idle = false;
      this.authoritativeIdle = false;
    }
  }

  private trySettle() {
    if (this.terminal) return;
    if (
      this.stopRequested &&
      this.stopConfirmed &&
      this.authoritativeIdle &&
      this.idle &&
      this.accepted
    ) {
      this.terminal = { outcome: "stopped" };
    } else if (
      !this.stopRequested &&
      this.accepted &&
      this.currentUser &&
      this.idle &&
      this.authoritativeIdle &&
      (this.assistantComplete || this.providerError)
    ) {
      this.terminal = this.providerError
        ? { outcome: "failed", error: this.providerError }
        : { outcome: "success", cost: this.assistantCost };
    }
  }
}
