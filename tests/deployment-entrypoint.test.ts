import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireWriter, validateDeployment } from "../apps/server/src/deployment.ts";

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
        CIVIC_SPARK_MAINTENANCE: "off",
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

it("keeps an existing mounted tree in explicit backup maintenance without app/database startup", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-maintenance-"));
  try {
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "sentinel"), "existing data");
    const entrypoint = join(root, "entrypoint.sh");
    // Rebase only the fixed data-root literal for this host-only shell contract test.
    writeFileSync(
      entrypoint,
      readFileSync("deploy/fly/entrypoint.sh", "utf8").replaceAll("/data/civic-spark", data),
    );
    const log = join(root, "calls");
    for (const command of ["install", "setpriv", "mountpoint"])
      writeFileSync(
        join(root, command),
        '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CIVIC_SPARK_TEST_LOG"\n',
        { mode: 0o755 },
      );
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CIVIC_SPARK_DATA_DIR: data,
      CIVIC_SPARK_MAINTENANCE: "backup",
      CIVIC_SPARK_TEST_LOG: log,
    };
    // A restart in the same configured mode stays in maintenance; no automatic fallback.
    for (let i = 0; i < 2; i++) {
      const result = spawnSync("sh", [entrypoint], { env, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("application writer is not started");
    }
    const commands = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.slice(root.length + 1));
    expect(commands).toEqual([
      "mountpoint -q /data",
      "setpriv --reuid=node --regid=node --init-groups /usr/bin/sleep infinity",
      "mountpoint -q /data",
      "setpriv --reuid=node --regid=node --init-groups /usr/bin/sleep infinity",
    ]);
    expect(readdirSync(data)).toEqual(["sentinel"]);
    expect(readFileSync(join(data, "sentinel"), "utf8")).toBe("existing data");
    rmSync(data, { recursive: true });
    expect(spawnSync("sh", [entrypoint], { env, encoding: "utf8" }).status).toBe(1);
    expect(existsSync(data)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["bakcup", ""])(
  "rejects invalid maintenance mode %j before mount or application startup",
  (mode) => {
    const result = spawnSync("sh", ["deploy/fly/entrypoint.sh"], {
      env: {
        ...process.env,
        CIVIC_SPARK_DATA_DIR: "/data/civic-spark",
        CIVIC_SPARK_MAINTENANCE: mode,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid CIVIC_SPARK_MAINTENANCE mode");
    expect(result.stdout).toBe("");
  },
);

it("also fences direct application startup in backup mode without blocking the operator writer lock", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-maintenance-direct-"));
  try {
    expect(() =>
      validateDeployment(root, "http://127.0.0.1:4310", "email", {
        CIVIC_SPARK_MAINTENANCE: "backup",
      }),
    ).toThrow("maintenance");
    expect(() =>
      validateDeployment(root, "http://127.0.0.1:4310", "email", { CIVIC_SPARK_MAINTENANCE: "" }),
    ).toThrow("maintenance");
    expect(() =>
      validateDeployment(root, "http://127.0.0.1:4310", "email", {
        CIVIC_SPARK_MAINTENANCE: "off",
      }),
    ).not.toThrow();
    const release = acquireWriter(root);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
