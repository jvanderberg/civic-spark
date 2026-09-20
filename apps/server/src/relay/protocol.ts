import type {
  HelperReply,
  HelperSessionEnd,
  HelperSessionOptions,
  HelperSessionOutcome,
} from "../../../../packages/sprites/src/helper-session.ts";
import type { IntegrationRequest, IntegrationResponse } from "./integration-runner.ts";

/**
 * Messages between the main server process and a relay worker over the fork
 * IPC channel (advanced serialization, ordered per worker). Agent and terminal
 * frames are already-serialized browser payloads; the worker batches agent
 * frames per session per tick, and terminal output arrives one coalesced frame
 * per 16 ms tick. Integration relay traffic is request/response: the worker
 * forwards each validated relay.py request and writes back the main process's
 * answer. Session, client and command ids are chosen by the main process so a
 * restarted worker never confuses old and new sessions.
 */
export type ToWorker =
  | { type: "agent.start"; session: string; workspaceId: string; sprite: string }
  | { type: "agent.attach"; session: string; client: number }
  | { type: "agent.input"; session: string; line: string; prompt: boolean }
  | { type: "agent.stop"; session: string }
  | { type: "agent.kill"; session: string }
  | { type: "terminal.start"; session: string; workspaceId: string; sprite: string }
  | { type: "terminal.attach"; session: string; client: number }
  | { type: "terminal.detach"; session: string }
  | { type: "terminal.input"; session: string; data: string }
  | { type: "terminal.resize"; session: string; cols: number; rows: number }
  | { type: "terminal.kill"; session: string }
  | { type: "integration.start"; session: string; workspaceId: string; sprite: string }
  | { type: "integration.reply"; session: string; id: string; response: IntegrationResponse }
  | { type: "integration.stop"; session: string }
  | {
      type: "command.run";
      id: string;
      args: string[];
      timeout: number;
      maxBuffer: number;
      input?: string;
    }
  | { type: "command.abort"; id: string }
  | { type: "session.start"; session: string; args: string[]; options: HelperSessionOptions }
  | {
      type: "session.request";
      session: string;
      id: string;
      script: string;
      payload: unknown;
      timeoutMs: number;
      limit: number;
    }
  | { type: "session.ping"; session: string; id: string; timeoutMs: number }
  | { type: "session.end"; session: string; outcome: HelperSessionOutcome }
  | { type: "shutdown" };

/** execFile failure fields `commandFailure` classifies; never the command line or stdout. */
export type CommandError = {
  code?: string | number;
  killed?: boolean;
  signal?: string;
  stderr: string;
};
export type FromWorker =
  | { type: "ready" }
  | { type: "agent.frames"; session: string; frames: string[] }
  | { type: "agent.replay"; session: string; client: number; frames: string[] }
  | { type: "agent.activity"; session: string }
  | { type: "agent.changed"; session: string; scope: "files" | "team"; coalesceMs?: number }
  | { type: "agent.busy"; session: string; busy: boolean }
  | { type: "agent.ended"; session: string }
  | { type: "terminal.output"; session: string; frame: string }
  | { type: "terminal.history"; session: string; client: number; data: string }
  | { type: "terminal.ended"; session: string; startFailed: boolean }
  | { type: "integration.request"; session: string; request: IntegrationRequest }
  | { type: "integration.ended"; session: string }
  | { type: "command.done"; id: string; stdout: Buffer }
  | { type: "command.failed"; id: string; error: CommandError }
  | { type: "session.ready"; session: string }
  | { type: "session.reply"; session: string; id: string; reply: HelperReply }
  | {
      type: "session.rejected";
      session: string;
      id: string;
      reason: "lost" | "busy" | "failed";
      message: string;
    }
  | { type: "session.closed"; session: string; end: HelperSessionEnd };

/** The routing key of a worker message: its session id or command id. */
export function routingKey(message: FromWorker): string | undefined {
  if ("session" in message) return message.session;
  if ("id" in message) return message.id;
  return undefined;
}
