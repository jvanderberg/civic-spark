import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { chromium, type WebSocketRoute } from "playwright";
import { createServer } from "vite";
import { expect, it } from "vitest";
import type { AgentEvent, AgentInput } from "../packages/agents/src/protocol.ts";

// Exercise the real React bridge in isolation. The only transport is a mocked
// Sprite socket; no provider key, participant data, or paid request is involved.
it("external requests send once after an explicit action, preserve drafts, and ignore replay completion", async () => {
  const fixture = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Agent } from '/apps/web/src/Agent.tsx';
    function Harness() {
      const [request, setRequest] = useState();
      const [visible, setVisible] = useState(true);
      const [dirty, setDirty] = useState(false);
      const [sent, setSent] = useState([]);
      const [finished, setFinished] = useState([]);
      const [cancelled, setCancelled] = useState([]);
      const [working, setWorking] = useState(false);
      window.bridge = { request: (id, prompt) => setRequest({id, prompt}), visible: setVisible, dirty: setDirty };
      return React.createElement(React.Fragment, null,
        React.createElement('output', {'data-sent': true}, JSON.stringify(sent)),
        React.createElement('output', {'data-finished': true}, JSON.stringify(finished)),
        React.createElement('output', {'data-cancelled': true}, JSON.stringify(cancelled)),
        React.createElement('output', {'data-working': true}, String(working)),
        React.createElement(Agent, {workspace:'request-test', available:true, visible, dirty, request,
          onRequestSent:id=>{setSent(value=>[...value,id]);setRequest(undefined)},
          onRequestFinished:id=>setFinished(value=>[...value,id]),
          onRequestCancelled:id=>{setCancelled(value=>[...value,id]);setRequest(undefined)},
          onWorkingChange:setWorking, onUpdated:()=>{}, onOpenFile:()=>{}, onReview:()=>{}}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
  `;
  const cacheDir = mkdtempSync(join(tmpdir(), "civic-spark-request-vite-"));
  const server = await createServer({
    configFile: false,
    cacheDir,
    optimizeDeps: {
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "lucide-react",
        "@pierre/diffs",
        "hast-util-to-jsx-runtime",
        "class-variance-authority",
        "tailwind-merge",
        "react-markdown",
        "remark-gfm",
        "zod",
      ],
    },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      react(),
      {
        name: "agent-request-fixture",
        resolveId(id) {
          if (id === "virtual:agent-request") return "\0agent-request-fixture.js";
        },
        load(id) {
          if (id === "\0agent-request-fixture.js") return fixture;
        },
        configureServer(server) {
          server.middlewares.use("/__agent-request", async (_req, res) => {
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__agent-request",
                '<div id="root"></div><script type="module" src="/@id/__x00__agent-request-fixture.js"></script>',
              ),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const inputs: AgentInput[] = [];
  let socket: WebSocketRoute | undefined;
  let reconnect = false;
  const state: AgentEvent = {
    type: "state",
    id: "snapshot",
    text: "Ready",
    runtimeReady: true,
    working: false,
    configuredProviders: ["opencode"],
  };
  const emit = (event: AgentEvent) => {
    if (!socket) throw new Error("No socket");
    socket.send(JSON.stringify(event));
  };
  const prompts = () => inputs.filter((input) => input.type === "prompt");
  const request = (id: string, prompt = `Resolve ${id}`) =>
    page.evaluate(
      ({ id, prompt }) => {
        (
          window as unknown as { bridge: { request: (id: string, prompt: string) => void } }
        ).bridge.request(id, prompt);
      },
      { id, prompt },
    );
  const toggle = (name: "visible" | "dirty", value: boolean) =>
    page.evaluate(
      ({ name, value }) => {
        (
          window as unknown as { bridge: Record<"visible" | "dirty", (value: boolean) => void> }
        ).bridge[name](value);
      },
      { name, value },
    );
  const output = (name: string) => page.locator(`[data-${name}]`).innerText();
  try {
    await page.route("**/agent/prepare", (route) => route.fulfill({ json: { ready: true } }));
    await page.routeWebSocket("**/api/workspaces/*/agent", (connection) => {
      socket = connection;
      connection.onMessage((message) => inputs.push(JSON.parse(message.toString()) as AgentInput));
      if (reconnect) {
        // Journal messages precede the authoritative snapshot on reattachment.
        connection.send(JSON.stringify({ type: "done", id: "old-done", text: "Ready" }));
        connection.send(JSON.stringify({ ...state, working: true, text: "Working" }));
      }
    });
    await page.goto(`http://127.0.0.1:${address.port}/__agent-request`);
    await expect
      .poll(
        () => {
          if (errors.length) throw new Error(errors.join("\n"));
          return !!socket;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    const composer = page.getByLabel("Message to agent");
    await request("gated");
    await page.getByRole("region", { name: "Pending team resolution request" }).waitFor();
    expect(await composer.inputValue()).toBe("Resolve gated");
    expect(prompts()).toHaveLength(0);
    emit({ ...state, configuredProviders: [] });
    emit({ type: "configured", id: "opencode", text: "GLM ready" });
    await page
      .getByRole("status")
      .filter({ hasText: /^Ready$/ })
      .waitFor();
    await toggle("visible", false);
    await toggle("visible", true);
    expect(prompts()).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel request" }).click();
    expect(await composer.inputValue()).toBe("");
    expect(await output("cancelled")).toBe('["gated"]');

    await request("ready");
    await expect.poll(() => prompts().length).toBe(1);
    expect(await output("sent")).toBe('["ready"]');
    expect(await output("working")).toBe("true");
    await request("ready"); // Parent rerenders/retries the same request ID.
    emit({ type: "done", id: "unrelated-done", text: "Ready" });
    await page
      .getByRole("status")
      .filter({ hasText: /^Ready$/ })
      .waitFor();
    expect(await output("finished")).toBe("[]");
    emit({ type: "user", id: "user-ready", text: "Resolve ready" });
    emit({ type: "done", id: "done-ready", text: "Ready" });
    await expect.poll(() => output("finished")).toBe('["ready"]');
    expect(prompts()).toHaveLength(1);

    emit({ ...state, working: true, text: "Working" });
    await page
      .getByRole("status")
      .filter({ hasText: /^Working$/ })
      .waitFor();
    await request("busy");
    await page.getByRole("region", { name: "Pending team resolution request" }).waitFor();
    emit(state);
    await page
      .getByRole("status")
      .filter({ hasText: /^Ready$/ })
      .waitFor();
    expect(prompts()).toHaveLength(1);
    await page.getByRole("button", { name: "Cancel request" }).click();

    await toggle("visible", false);
    await composer.waitFor({ state: "hidden" });
    await request("hidden");
    await page
      .locator('[aria-label="Pending team resolution request"]')
      .waitFor({ state: "attached" });
    await toggle("visible", true);
    await page.getByRole("region", { name: "Pending team resolution request" }).waitFor();
    expect(prompts()).toHaveLength(1);
    await page.getByRole("button", { name: "Cancel request" }).click();

    await composer.fill("My unsent draft");
    await request("draft");
    await page.getByRole("button", { name: "Use resolution prompt" }).click();
    expect(await composer.inputValue()).toBe("Resolve draft");
    await page.getByRole("button", { name: "Cancel request" }).click();
    expect(await composer.inputValue()).toBe("My unsent draft");
    expect(prompts()).toHaveLength(1);

    await composer.fill("");
    await toggle("dirty", true);
    await request("dirty");
    await page.getByRole("region", { name: "Pending team resolution request" }).waitFor();
    await toggle("dirty", false);
    await page.getByRole("button", { name: "Send to agent" }).waitFor();
    expect(prompts()).toHaveLength(1);
    await composer.press("Enter");
    await expect.poll(() => prompts().length).toBe(2);
    emit({ type: "user", id: "user-dirty", text: "Resolve dirty" });
    emit({ type: "error", id: "error-dirty", text: "Fixture error" });
    emit({ type: "done", id: "done-dirty", text: "Ready" });
    await expect.poll(() => output("finished")).toBe('["ready","dirty"]');
    await page.getByRole("button", { name: "Dismiss agent error" }).click();

    await request("reconnect");
    await expect.poll(() => prompts().length).toBe(3);
    emit({ type: "user", id: "user-reconnect", text: "Resolve reconnect" });
    await page.getByText("Resolve reconnect", { exact: true }).waitFor();
    reconnect = true;
    await socket?.close({ code: 1011, reason: "Fixture reconnect" });
    await page
      .getByRole("status")
      .filter({ hasText: /^Working$/ })
      .waitFor();
    expect(await output("finished")).toBe('["ready","dirty"]');
    expect(prompts()).toHaveLength(3);
    emit({ type: "done", id: "done-reconnect", text: "Ready" });
    await expect.poll(() => output("finished")).toBe('["ready","dirty","reconnect"]');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}, 30000);
