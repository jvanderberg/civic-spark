// Test-only relay worker: echoes agent input as frames, exits on demand, and
// stops on shutdown. Used by the pool restart test; never loaded by the server.
process.on("message", (raw) => {
  const message = raw as { type: string; session?: string; line?: string };
  if (message.type === "shutdown") process.exit(0);
  if (message.type === "agent.kill") process.exit(3);
  if (message.type === "agent.input")
    process.send?.({ type: "agent.frames", session: message.session, frames: [message.line] });
});
process.send?.({ type: "ready" });
