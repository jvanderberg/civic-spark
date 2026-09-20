import type { FromWorker, ToWorker } from "./protocol.ts";
import { RelayWorkerHost } from "./worker-host.ts";

// Relay worker entry: forked by the main server with an IPC channel. It owns
// the Sprite CLI children for its share of workspaces and speaks the compact
// channel protocol back to the main process, which keeps HTTP, WebSocket
// clients, authorization and lifecycle decisions.
if (!process.send) {
  console.error("Civic Spark relay worker must be forked by the server process.");
  process.exit(2);
}
const index = Number.parseInt(process.argv[2] ?? "0", 10);
const host = new RelayWorkerHost(
  {
    send: (message: FromWorker, flushed) =>
      process.send?.(message, undefined, undefined, () => flushed()) ?? false,
    onMessage: (handler) => process.on("message", (message) => handler(message as ToWorker)),
    onDisconnect: (handler) => process.on("disconnect", handler),
    exit: (code) => process.exit(code),
  },
  Number.isFinite(index) ? index : 0,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => host.shutdown());
