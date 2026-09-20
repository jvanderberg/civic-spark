import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { acquireWriter, validateDeployment } from "../apps/server/src/deployment.ts";

it("initializes private app-owned Sprite state before dropping privileges, without recursive ownership changes", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-entrypoint-"));
  try {
    const log = join(root, "calls");
    for (const command of ["install", "setpriv", "mountpoint", "chown"])
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
      "chown node:node /data",
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

it("direct server entry refuses maintenance before decoding a malformed secret envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-maintenance-envelope-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), resolve("apps/server/src/index.ts")],
      {
        cwd: root,
        env: {
          ...process.env,
          CIVIC_SPARK_MAINTENANCE: "backup",
          CIVIC_SPARK_DATA_DIR: join(root, "data"),
          CIVIC_SPARK_SECRETS_B64: "invalid-test-envelope-never-decode",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Application startup is blocked by maintenance mode");
    expect(result.stderr).not.toContain("Invalid deployment secret envelope");
    expect(result.stderr).not.toContain("invalid-test-envelope-never-decode");
    expect(result.stdout).toBe("");
    expect(existsSync(join(root, "data"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("staging rejects disk filesystems, missing findmnt, links and wrong mode before accepting secret inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-staging-"));
  try {
    const shm = join(root, "shm");
    mkdirSync(shm);
    const input = join(shm, "civic-spark-backup-input");
    const script = join(root, "prepare.sh");
    writeFileSync(
      script,
      readFileSync("deploy/fly/prepare-backup-input.sh", "utf8")
        .replaceAll("/dev/shm", shm)
        .replaceAll("/data/civic-spark-backups", join(root, "output")),
    );
    writeFileSync(
      join(root, "readlink"),
      '#!/bin/sh\nprintf "%s\\n" "$CIVIC_SPARK_TEST_CANONICAL"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, "findmnt"),
      '#!/bin/sh\nprintf "%s\\n" "$CIVIC_SPARK_TEST_FSTYPE"\nexit "$CIVIC_SPARK_TEST_FINDMNT_EXIT"\n',
      { mode: 0o755 },
    );
    for (const command of ["chown", "install"])
      writeFileSync(
        join(root, command),
        '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CIVIC_SPARK_TEST_LOG"\n',
        { mode: 0o755 },
      );
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CIVIC_SPARK_MAINTENANCE: "backup",
      CIVIC_SPARK_TEST_CANONICAL: shm,
      CIVIC_SPARK_TEST_FSTYPE: "tmpfs",
      CIVIC_SPARK_TEST_FINDMNT_EXIT: "0",
      CIVIC_SPARK_TEST_LOG: join(root, "calls"),
    };
    for (const extra of [
      { CIVIC_SPARK_TEST_FSTYPE: "ext4" },
      { CIVIC_SPARK_TEST_FINDMNT_EXIT: "127" },
      { CIVIC_SPARK_TEST_CANONICAL: join(root, "different-mount") },
      { CIVIC_SPARK_MAINTENANCE: "off" },
    ]) {
      const result = spawnSync("sh", [script], { env: { ...env, ...extra }, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(existsSync(input)).toBe(false);
      expect(existsSync(env.CIVIC_SPARK_TEST_LOG)).toBe(false);
    }
    const actual = join(root, "real-shm");
    renameSync(shm, actual);
    symlinkSync(actual, shm);
    expect(spawnSync("sh", [script], { env, encoding: "utf8" }).status).toBe(1);
    expect(existsSync(join(actual, "civic-spark-backup-input"))).toBe(false);
    rmSync(shm);
    renameSync(actual, shm);
    const success = spawnSync("sh", [script], { env, encoding: "utf8" });
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("ready on tmpfs");
    expect(statSync(input).mode & 0o777).toBe(0o700);
    expect(spawnSync("sh", [script], { env, encoding: "utf8" }).status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
