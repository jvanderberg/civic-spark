import { expect, it, vi } from "vitest";
import { ok } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

it("separates Sprite CLI upload flags from remote command flags", async () => {
  const client = new SpriteClient("test-org");
  const command = vi.spyOn(client, "command").mockResolvedValue(ok(Buffer.from("")));
  await client.exec("civic-spark-test", ["bash", "-lc", "true"], ["local:/tmp/remote"]);
  expect(command.mock.calls[0]?.[0]).toEqual([
    "-s",
    "civic-spark-test",
    "exec",
    "--no-port-forward",
    "--file",
    "local:/tmp/remote",
    "--",
    "bash",
    "-lc",
    "true",
  ]);
  await client.uploadBundle("civic-spark-test", "/tmp/seed.bundle");
  expect(command.mock.calls[1]?.[0].slice(0, 9)).toEqual([
    "-s",
    "civic-spark-test",
    "exec",
    "--no-port-forward",
    "--file",
    "/tmp/seed.bundle:/tmp/civic-spark-seed.bundle",
    "--",
    "bash",
    "-lc",
  ]);
  await client.files("civic-spark-test");
  expect(command.mock.calls[2]?.[0].slice(0, 7)).toEqual([
    "-s",
    "civic-spark-test",
    "exec",
    "--no-port-forward",
    "--",
    "python3",
    "-c",
  ]);
});

it("uses the pinned noninteractive Sprite creation option", async () => {
  const client = new SpriteClient("test-org");
  const command = vi.spyOn(client, "command").mockResolvedValue(ok(Buffer.from("")));
  await client.create("civic-spark-test");
  expect(command).toHaveBeenCalledWith(["create", "--skip-console", "civic-spark-test"]);
});
