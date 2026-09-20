import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentHandle } from "../agents.ts";
import type { TerminalBackend, TerminalHandle } from "../terminal.ts";
import type { RelayPool } from "./pool.ts";

/**
 * Agent sessions whose runner process lives in a relay worker. The main
 * process keeps the browser sockets, authorization checks and fan-out; the
 * worker keeps the child, replay bookkeeping and delta batching. `busy`
 * mirrors the worker's state and is set optimistically when a prompt leaves,
 * so a second prompt is refused before the worker has confirmed the first.
 */
export function relayAgentBackend(pool: RelayPool): AgentBackend {
  return {
    start(id, sprite, events) {
      const worker = pool.for(id);
      const session = randomUUID();
      const replays = new Map<number, (frames: string[]) => void>();
      let clients = 0;
      let busy = false;
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        worker.unregister(session);
        replays.clear();
        events.ended();
      };
      worker.register(session, {
        message(message) {
          switch (message.type) {
            case "agent.frames":
              for (const frame of message.frames) events.frame(frame);
              return;
            case "agent.replay": {
              const deliver = replays.get(message.client);
              replays.delete(message.client);
              deliver?.(message.frames);
              return;
            }
            case "agent.activity":
              return events.activity();
            case "agent.busy":
              busy = message.busy;
              return;
            case "agent.ended":
              return finish();
          }
        },
        lost: finish,
      });
      worker.send({ type: "agent.start", session, workspaceId: id, sprite });
      const handle: AgentHandle = {
        get busy() {
          return busy;
        },
        replay(deliver) {
          if (ended) return;
          const client = clients++;
          replays.set(client, deliver);
          worker.send({ type: "agent.attach", session, client });
        },
        send(message) {
          const prompt = message.type === "prompt";
          if (prompt) busy = true;
          worker.send({ type: "agent.input", session, line: JSON.stringify(message), prompt });
        },
        stop: () => worker.send({ type: "agent.stop", session }),
        kill: () => worker.send({ type: "agent.kill", session }),
      };
      return handle;
    },
  };
}

/** Terminal sessions whose PTY lives in a relay worker; history replay arrives asynchronously. */
export function relayTerminalBackend(pool: RelayPool): TerminalBackend {
  return {
    start(id, sprite, events) {
      const worker = pool.for(id);
      const session = randomUUID();
      const histories = new Map<number, (history: string) => void>();
      let clients = 0;
      let ended = false;
      const finish = (startFailed: boolean) => {
        if (ended) return;
        ended = true;
        worker.unregister(session);
        histories.clear();
        events.ended(startFailed);
      };
      worker.register(session, {
        message(message) {
          switch (message.type) {
            case "terminal.output":
              return events.output(message.frame);
            case "terminal.history": {
              const deliver = histories.get(message.client);
              histories.delete(message.client);
              deliver?.(message.data);
              return;
            }
            case "terminal.ended":
              return finish(message.startFailed);
          }
        },
        lost: () => finish(false),
      });
      worker.send({ type: "terminal.start", session, workspaceId: id, sprite });
      const handle: TerminalHandle = {
        attach(deliver) {
          if (ended) return;
          const client = clients++;
          histories.set(client, deliver);
          worker.send({ type: "terminal.attach", session, client });
        },
        detach: () => worker.send({ type: "terminal.detach", session }),
        write: (data) => worker.send({ type: "terminal.input", session, data }),
        resize: (cols, rows) => worker.send({ type: "terminal.resize", session, cols, rows }),
        kill: () => worker.send({ type: "terminal.kill", session }),
      };
      return handle;
    },
  };
}
