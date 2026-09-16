import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("initializes private app-owned Sprite state before dropping privileges, without recursive ownership changes", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-entrypoint-"));
  try {
    const log = join(root, "calls");
    for (const command of ["install", "setpriv", "mountpoint"])
      writeFileSync(
        join(root, command),
        '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CIVIC_SPARK_TEST_LOG"\n',
        { mode: 0o755 },
      );
    const result = spawnSync("sh", ["deploy/fly/entrypoint.sh"], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        CIVIC_SPARK_DATA_DIR: "/data/civic-spark",
        CIVIC_SPARK_TEST_LOG: log,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const commands = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.slice(root.length + 1));
    expect(commands).toEqual([
      "mountpoint -q /data",
      "install -d -m 0700 -o node -g node /data/civic-spark",
      "install -d -m 0700 -o node -g node /home/node/.sprites",
      "setpriv --reuid=node --regid=node --init-groups node --import tsx apps/server/src/index.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
