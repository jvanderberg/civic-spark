import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AgentReplay, historyByteLimit } from "../packages/agents/src/history.ts";
import {
  agentImageSchema,
  agentWireByteLimit,
  imageByteLimit,
} from "../packages/agents/src/images.ts";
import { AgentJournal } from "../packages/agents/src/journal.ts";
import {
  claudePrompt,
  openCodeParts,
  requireImageCapability,
} from "../packages/agents/src/multimodal.ts";
import { agentFailure, agentInputSchema } from "../packages/agents/src/protocol.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const image = () => ({
  id: randomUUID(),
  name: "Screenshot.png",
  mime: "image/png" as const,
  data: png,
});
const prompt = (images = [image()], text = "") => ({
  type: "prompt" as const,
  provider: "claude" as const,
  text,
  images,
});

describe("private agent image boundary", () => {
  it("accepts image-only/mixed prompts and keeps old text input valid", async () => {
    const input = agentInputSchema.parse(prompt());
    expect(input.type).toBe("prompt");
    const stream = claudePrompt(prompt());
    expect(typeof stream).not.toBe("string");
    if (typeof stream === "string") throw Error();
    for await (const message of stream) {
      expect(message.message.content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      ]);
    }
    expect(openCodeParts(prompt([image()], "Inspect"))).toMatchObject([
      { type: "text", text: "Inspect" },
      { type: "file", mime: "image/png", url: `data:image/png;base64,${png}` },
    ]);
    expect(claudePrompt(prompt([], "text only"))).toBe("text only");
    expect(agentInputSchema.safeParse(prompt([])).success).toBe(false);
  });
  it("rejects spoofed MIME, URLs, SVG, malformed/truncated base64, dimensions and unknown fields", () => {
    for (const change of [
      { mime: "image/jpeg" },
      { mime: "image/svg+xml" },
      { data: "https://example.test/image.png" },
      { data: `${png}\n` },
      { data: png.slice(0, -4) },
      { data: "!!!!" },
      { data: png.replace("O+ip1s", "O+aX1c") },
      { data: "<svg/>" },
      { path: "../../secret" },
      { url: "file:///private" },
      { data: "A".repeat(4 * imageByteLimit) },
    ])
      expect(agentImageSchema.safeParse({ ...image(), ...change }).success).toBe(false);
    const wide = Buffer.from(png, "base64");
    wide.writeUInt32BE(9000, 16);
    expect(agentImageSchema.safeParse({ ...image(), data: wide.toString("base64") }).success).toBe(
      false,
    );
    expect(agentInputSchema.safeParse({ ...prompt(), extra: "unbounded" }).success).toBe(false);
    expect(agentInputSchema.safeParse(prompt(Array.from({ length: 5 }, image))).success).toBe(
      false,
    );
    const duplicate = image();
    expect(agentInputSchema.safeParse(prompt([duplicate, duplicate])).success).toBe(false);
  });
  it("enforces decoded aggregate size within the socket frame bound", () => {
    // A large bounded PNG chunk avoids relying on inflated compressed-pixel size.
    const original = Buffer.from(png, "base64");
    const chunk = Buffer.alloc(1500000);
    chunk.writeUInt32BE(chunk.length - 12);
    chunk.write("tEXt", 4);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const data = Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]).toString(
      "base64",
    );
    const large = () => ({ ...image(), data });
    expect(agentInputSchema.safeParse(prompt([large(), large()])).success).toBe(true);
    expect(agentInputSchema.safeParse(prompt([large(), large(), large()])).success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(prompt([large(), large()])))).toBeLessThan(
      agentWireByteLimit,
    );
  });
  it("caps MANY image turns, restores private thumbnails, and never mixes bytes into text/details", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-images-"));
    try {
      const path = join(root, "conversation.json");
      const journal = new AgentJournal(path);
      for (let i = 0; i < 40; i++)
        journal.record({
          type: "user",
          id: `turn-${i}`,
          text: "Inspect screenshot",
          images: [{ ...image(), data: `${png}${"x".repeat(400000)}` }],
        });
      const latest = image();
      journal.record({ type: "user", id: "latest", text: "", images: [latest] });
      journal.flush();
      expect(statSync(path).size).toBeLessThan(historyByteLimit + 10000);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const restored = new AgentJournal(path);
      expect(restored.events.at(-1)?.images).toEqual([latest]);
      const replay = new AgentReplay();
      for (const event of restored.events) replay.accept({ ...event, replayed: true });
      expect(Buffer.byteLength(JSON.stringify(replay.events))).toBeLessThanOrEqual(
        historyByteLimit,
      );
      expect(replay.events.map((event) => event.text + event.details).join(" ")).not.toContain(png);
      expect(readFileSync(path, "utf8")).not.toContain("key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails closed on missing image capability without switching model or exposing payloads", () => {
    expect(() => requireImageCapability(true)).not.toThrow();
    expect(() => requireImageCapability(false)).toThrow();
    expect(agentFailure({ name: "ImageCapabilityError" })).toContain("Remove the images");
    expect(agentFailure({ message: `Model does not support image input ${png}` })).not.toContain(
      png,
    );
  });
});
