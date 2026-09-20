import * as pty from "node-pty";
import { count } from "../../../../packages/diagnostics/src/index.ts";

export type TerminalRunnerEvents = {
  /** One coalesced `{"type":"output"}` frame for fan-out to attached clients. */
  output(frame: string): void;
  /** The PTY process exited; called once. */
  ended(): void;
};
const historyLimit = 200000;
const outputCoalesceMs = 16;

/**
 * Owns one terminal PTY (`sprite exec --tty … tmux new-session -A`): spawning,
 * the bounded history ring with terminal queries removed, and per-tick output
 * coalescing. Attached-client counting decides whether live output is buffered
 * at all; fan-out, leases and the zero-client detach timer stay with the caller.
 */
export class TerminalRunner {
  private readonly process: pty.IPty;
  private chunks: string[] = [];
  private bytes = 0;
  private pendingOutput = "";
  private flushTimer: NodeJS.Timeout | undefined;
  clients = 0;
  constructor(
    sprite: string,
    private events: TerminalRunnerEvents,
  ) {
    const org = process.env.CIVIC_SPARK_SPRITE_ORG;
    const args = [
      ...(org ? ["-o", org] : []),
      "-s",
      sprite,
      "exec",
      "--no-port-forward",
      "--tty",
      "--",
      "bash",
      "-lc",
      "export PATH=/home/sprite/.civic-spark-agent/bin:/home/sprite/.civic-spark-agent/node_modules/.bin:$PATH; cd /home/sprite/project && printf 'Civic Spark terminal connected\\r\\n' && exec tmux new-session -A -s civic-spark-workspace \\; set-option -g status off",
    ];
    // Only this fixed Sprite CLI is launched on the host. User input goes to the remote PTY.
    this.process = pty.spawn("sprite", args, {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    const flush = () => {
      this.flushTimer = undefined;
      const data = this.pendingOutput;
      this.pendingOutput = "";
      if (!data) return;
      this.events.output(JSON.stringify({ type: "output", data }));
    };
    this.process.onData((data) => {
      count("terminalChunks");
      count("terminalBytes", data.length);
      // Output is not use: tmux status refreshes and TUIs emit forever, which
      // would block idle release and keep the Sprite in billed running state.
      // History is a bounded ring of chunks with terminal queries removed so a
      // replay never triggers responses; live frames are coalesced per tick.
      const cleaned = data
        .replaceAll("\x1b[6n", "")
        .replaceAll("\x1b]11;?\x1b\\", "")
        .replaceAll("\x1b]11;?\x07", "");
      this.chunks.push(cleaned);
      this.bytes += cleaned.length;
      while (this.bytes > historyLimit && this.chunks.length > 1) {
        const first = this.chunks.shift() ?? "";
        this.bytes -= first.length;
      }
      if (!this.clients) return;
      this.pendingOutput += data;
      if (!this.flushTimer) this.flushTimer = setTimeout(flush, outputCoalesceMs);
    });
    this.process.onExit(() => {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.events.ended();
    });
  }
  history() {
    return this.chunks.join("");
  }
  write(data: string) {
    this.process.write(data);
  }
  resize(cols: number, rows: number) {
    this.process.resize(cols, rows);
  }
  kill() {
    this.process.kill();
  }
}
