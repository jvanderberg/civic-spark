import { existsSync } from "node:fs";
import { request } from "node:http";

// Official Tasks API, https://docs.sprites.dev/keeping-sprites-running/.
// This hold exists only during a browser model turn, never while an idle runner
// waits for input. Five-minute expiry with one-minute renewal is the documented
// default, so a crashed runner cannot keep compute alive indefinitely.
export async function holdActiveTurn(onFailure: () => void, socketPath = "/.sprite/api.sock") {
  if (!existsSync(socketPath)) return async () => {}; // Local deterministic runner fixtures.
  const task = (method: "PUT" | "DELETE") =>
    new Promise<void>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: "/v1/tasks/civic-spark-agent",
          method,
          headers: { Host: "sprite", "Content-Type": "application/json" },
          timeout: 5000,
        },
        (response) => {
          response.resume();
          response.on("end", () => {
            if (
              (response.statusCode ?? 500) < 300 ||
              (method === "DELETE" && response.statusCode === 404)
            )
              resolve();
            else reject(new Error("Could not protect this turn from Sprite idle sleep."));
          });
        },
      );
      req.on("error", () =>
        reject(new Error("Could not protect this turn from Sprite idle sleep.")),
      );
      req.on("timeout", () => req.destroy());
      req.end(method === "PUT" ? JSON.stringify({ expire: "5m" }) : undefined);
    });
  await task("PUT");
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    pending = task("PUT").catch(onFailure);
  }, 60000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
    await task("DELETE").catch(() => undefined);
  };
}
