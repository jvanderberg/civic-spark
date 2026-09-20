import { z } from "zod";
import type { SpriteTransport } from "../../../../packages/sprites/src/transport.ts";
import type { AgentBackend } from "../agents.ts";
import type { IntegrationBackend } from "../integrations.ts";
import type { TerminalBackend } from "../terminal.ts";
import { RelayPool, type RelayPoolOptions } from "./pool.ts";
import { relayAgentBackend, relayIntegrationBackend, relayTerminalBackend } from "./sessions.ts";
import { relaySpriteTransport } from "./transport.ts";

export type Relay = {
  pool: RelayPool;
  agents: AgentBackend;
  terminals: TerminalBackend;
  integrations: IntegrationBackend;
  transport: SpriteTransport;
  close(): Promise<void>;
};

/** `CIVIC_SPARK_RELAY_WORKERS`: relay worker processes; 0 keeps every Sprite child in-process. */
export function relayWorkerCount() {
  return z.coerce
    .number()
    .int()
    .min(0)
    .max(16)
    .parse(process.env.CIVIC_SPARK_RELAY_WORKERS ?? "2");
}

/**
 * Starts the relay worker pool when enabled. Workers own the `sprite` CLI
 * children (agent runners, terminal PTYs, agent integration relays, helper
 * sessions, one-shot commands); the main process keeps HTTP, WebSocket
 * clients, authorization, leases and idle release. Returns undefined when the
 * flag is 0 so callers fall back to the in-process backends unchanged.
 */
export function createRelay(options: RelayPoolOptions = {}): Relay | undefined {
  const size = relayWorkerCount();
  if (!size) return undefined;
  const pool = new RelayPool(size, options);
  return {
    pool,
    agents: relayAgentBackend(pool),
    terminals: relayTerminalBackend(pool),
    integrations: relayIntegrationBackend(pool),
    transport: relaySpriteTransport(pool),
    close: () => pool.close(),
  };
}
