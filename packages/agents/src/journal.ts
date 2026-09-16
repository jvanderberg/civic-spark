import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { historyByteLimit, redactAgentEvent, retainEvent } from "./history.ts";
import type { AgentEvent } from "./protocol.ts";

// Only sanitized output events enter this journal. Never store input/configure payloads.
export class AgentJournal {
  readonly events: AgentEvent[] = [];
  interrupted = false;
  failed = false;
  private working = false;
  private timer?: ReturnType<typeof setTimeout>;
  private path: string;
  private secrets: (string | undefined)[];
  constructor(path: string, secrets: (string | undefined)[] = []) {
    this.path = path;
    this.secrets = secrets;
    try {
      if (!existsSync(path) || statSync(path).size > historyByteLimit + 10000) return;
      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        version?: number;
        working?: boolean;
        events?: AgentEvent[];
      };
      if (stored.version !== 1 || !Array.isArray(stored.events)) return;
      for (const event of stored.events)
        if (typeof event?.id === "string" && typeof event.text === "string")
          retainEvent(this.events, redactAgentEvent(event, this.secrets));
      this.interrupted = stored.working === true;
    } catch {
      // A damaged journal must not erase provider-native context or prevent reconnect.
    }
  }
  record(event: AgentEvent) {
    retainEvent(this.events, redactAgentEvent(event, this.secrets));
    if (event.type === "status" && event.text === "Working") this.working = true;
    if (event.type === "done") this.working = false;
    if (
      ["user", "done", "error"].includes(event.type) ||
      (event.type === "status" && event.text === "Working")
    )
      this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 200);
      this.timer.unref();
    }
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, working: this.working, events: this.events }),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      this.failed = false;
    } catch {
      this.failed = true;
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the original write failure. */
      }
    }
  }
}
