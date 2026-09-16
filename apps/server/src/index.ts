import { existsSync } from "node:fs";
import { createApp } from "./app.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const { app } = await createApp();
await app.listen({ port: Number(process.env.CIVIC_SPARK_PORT ?? 4311), host: "127.0.0.1" });
console.log(
  `Civic Spark ${process.env.CIVIC_SPARK_AUTH_MODE === "prototype" ? "local prototype" : "authenticated"} API: http://127.0.0.1:${process.env.CIVIC_SPARK_PORT ?? 4311}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
