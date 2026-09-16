import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";
import { editorInput, readEditor, waitEditorText, writeEditor } from "./browser-editor.ts";

const root = mkdtempSync(join(tmpdir(), "vibehack-editor-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") throw new Error("No port");
      server.close(() => resolve(a.port));
    });
  });
const port = await freePort();
const devPort = process.env.VIBEHACK_EDITOR_DEV === "1" ? await freePort() : undefined;
const address = `http://127.0.0.1:${devPort ?? port}`;
const vite = devPort
  ? await (await import("vite")).createServer({
      cacheDir: join(root, "vite-cache"),
      server: {
        host: "127.0.0.1",
        port: devPort,
        strictPort: true,
        proxy: { "/api": { target: `http://127.0.0.1:${port}`, ws: true } },
      },
    })
  : undefined;
const { app, service, authentication } = await createApp(root, false, address, undefined, "email");
await app.listen({ host: "127.0.0.1", port });
await vite?.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
const blockedHtmlRequests = new Set<string>();
const blockHtml = process.env.VIBEHACK_EDITOR_BLOCK_HTML === "1";
page.on("pageerror", (e) => errors.push(e.message));
if (blockHtml) {
  // Reproduce the stale/lost lazy grammar request that otherwise leaves a live
  // Monaco editor permanently gray. Eager grammar dependencies must still work.
  await page.route(/\/(?:deps|assets)\/html-[A-Za-z0-9_-]+\.js(?:\?|$)/, async (route) => {
    blockedHtmlRequests.add(route.request().url());
    await route.fulfill({
      status: 504,
      contentType: "text/javascript",
      body: "Outdated Optimize Dep",
    });
  });
}
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
try {
  const user = await testIdentity(authentication, "Editor owner");
  assert(user.actor);
  const event = unwrap(
    service.createEvent(user.actor, {
      name: "Editor rehearsal",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(user.actor, {
      eventId: event.id,
      name: "Syntax highlighting",
      projectId: "data-starter",
    }),
  );
  const id = team.workspace.id;
  const endpoint = `${address}/api/workspaces/${id}`;
  await page.context().addCookies([user.browserCookie]);

  const fixtures: [string, string, string][] = [
    [
      "index.html",
      "html",
      '<!doctype html>\n<html lang="en">\n<head><style>body { color: red; }</style></head>\n<body><h1 class="title">Hello</h1>\n<script>const count = 42; console.log("hello", count);</script>\n</body></html>\n',
    ],
    ["style.css", "css", "body { color: red; margin: 12px; }"],
    ["style.scss", "scss", "$color: red;\nbody { color: $color; }"],
    ["style.less", "less", "@color: red;\nbody { color: @color; }"],
    ["app.js", "javascript", 'const count = 42; console.log("hello");'],
    ["app.cjs", "javascript", 'const count = 42; console.log("hello");'],
    ["app.jsx", "javascript", 'const title = <h1 className="title">Hello</h1>;'],
    ["app.ts", "typescript", 'const count: number = 42; console.log("hello");'],
    ["app.tsx", "typescript", 'const title = <h1 className="title">Hello</h1>;'],
    ["app.mts", "typescript", 'const count: number = 42; console.log("hello");'],
    ["data.json", "json", '{ "hello": true, "count": 42 }'],
    ["map.geojson", "json", '{ "type": "FeatureCollection", "features": [] }'],
    ["notes.md", "markdown", "# Heading\n**Important** and `code`"],
    ["analysis.py", "python", 'def hello():\n  return "hello" # comment'],
    ["query.sql", "sql", "SELECT name FROM users WHERE id = 42; -- comment"],
    ["config.yaml", "yaml", 'name: "hello"\ncount: 42 # comment'],
    ["script.sh", "shell", '#!/bin/bash\necho "hello" # comment'],
    ["script.zsh", "shell", '#!/bin/zsh\necho "hello" # comment'],
    ["data.xml", "xml", '<?xml version="1.0"?><root name="hello">Text</root>'],
    ["logo.svg", "xml", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'],
    ["main.rs", "rust", 'fn main() { let count = 42; println!("hello"); }'],
    ["main.go", "go", 'package main\nfunc main() { println("hello") }'],
    ["main.java", "java", 'public class App { String title = "hello"; }'],
    ["main.c", "c", "int main() { return 42; /* comment */ }"],
    ["main.cpp", "cpp", "int main() { return 42; // comment\n}"],
    ["main.cs", "csharp", 'public class App { string title = "hello"; }'],
    ["main.rb", "ruby", 'def hello\n  puts "hello" # comment\nend'],
    ["main.php", "php", '<?php echo "hello"; // comment'],
    ["main.swift", "swift", 'let message: String = "hello" // comment'],
    ["main.kt", "kotlin", 'fun main() { println("hello") }'],
    ["main.R", "r", 'count <- 42 # comment\nprint("hello")'],
    ["Dockerfile", "dockerfile", 'FROM node:22\nRUN echo "hello" # comment'],
    ["Containerfile.dev", "dockerfile", 'FROM node:22\nRUN echo "hello"'],
    ["settings.ini", "ini", "[settings]\nname = hello # comment"],
    ["pyproject.toml", "ini", '[project]\nname = "hello"'],
    ["schema.graphql", "graphql", "type Query { hello: String! } # comment"],
    ["infra.tf", "hcl", 'variable "name" { default = "hello" } # comment'],
    ["script.ps1", "powershell", 'Write-Host "hello" # comment'],
    ["component.vue", "html", '<template><h1 class="title">Hello</h1></template>'],
    ["component.svelte", "html", '<h1 class="title">Hello</h1>'],
    ["INDEX.XHTML", "html", '<html lang="en"><body>Hello</body></html>'],
  ];
  for (const [path, , content] of fixtures)
    writeFileSync(join(service.workspacePath(id), path), content);
  await page.goto(`${address}/#workspace=${id}`);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [path, language, content] of fixtures) {
      await page.getByRole("treeitem", { name: path, exact: true }).click();
      await waitEditorText(page, content.slice(0, 20));
      await page
        .waitForFunction(
          ({ language, theme }) => {
            const host = document.querySelector(".code-editor-host");
            const editor = host?.querySelector(".monaco-editor");
            const tokens = host?.querySelectorAll('.view-lines span[class^="mtk"]') ?? [];
            const colors = new Set(
              [...tokens]
                .filter(
                  (token) =>
                    !token.className.includes("bracket-highlighting") && token.textContent?.trim(),
                )
                .map((token) => getComputedStyle(token).color),
            );
            return (
              host?.getAttribute("data-language") === language &&
              editor?.classList.contains(theme === "dark" ? "vs-dark" : "vs") &&
              colors.size >= 2
            );
          },
          { language, theme },
          { timeout: 10000 },
        )
        .catch((error) => {
          throw new Error(`${path} (${language}, ${theme}) did not render syntax colors`, {
            cause: error,
          });
        });
      if (path === "index.html") {
        // Embedded JS and CSS must tokenize too, not just the surrounding HTML tags.
        const tokenColor = async (text: string) =>
          page
            .locator('.view-lines span[class^="mtk"]')
            .filter({ hasText: new RegExp(`^${text}$`) })
            .first()
            .evaluate((token) => getComputedStyle(token).color);
        assert.notEqual(await tokenColor("const"), await tokenColor("42"));
        assert.notEqual(await tokenColor("color:"), await tokenColor("red"));
        await (await editorInput(page)).press("ArrowLeft");
        await page.screenshot({ path: join(artifacts, `editor-html-${theme}.png`) });
      }
    }
  }
  // Theme changes preserve an unsaved buffer, and an ordinary save still works.
  await page.getByRole("treeitem", { name: "index.html", exact: true }).click();
  await waitEditorText(page, "<!doctype html>");
  const draft = "Unsaved editor draft\n";
  await writeEditor(page, draft);
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() =>
    document.querySelector(".monaco-editor")?.classList.contains("vs"),
  );
  assert.equal(await readEditor(page), draft);
  await (await editorInput(page)).press("ControlOrMeta+S");
  await page.waitForFunction(
    () => document.querySelector<HTMLButtonElement>('.file-action[aria-label="Save"]')?.disabled,
  );
  const saved = await (await page.request.get(`${endpoint}/blob?path=index.html`)).json();
  assert.equal(Buffer.from(saved.data, "base64").toString(), draft);
  const expectedLazyErrors = errors.filter(
    (error) => blockHtml && [...blockedHtmlRequests].some((url) => error.includes(url)),
  );
  assert.deepEqual(
    errors.filter((error) => !expectedLazyErrors.includes(error)),
    [],
  );
  if (blockHtml) {
    console.log(
      `Blocked-lazy regression: ${blockedHtmlRequests.size} obsolete HTML requests blocked; ${expectedLazyErrors.length} expected old-loader errors; HTML and embedded CSS/JS still colored, draft preserved.`,
    );
  }
  console.log(
    `PASS (${vite ? "Vite dev" : "production"}): ${fixtures.length} file types render syntax tokens in light/dark themes; embedded HTML CSS/JS, repeated file switching, unsaved draft/theme and save verified.`,
  );
} finally {
  await browser.close();
  await app.close();
  await vite?.close();
  rmSync(root, { recursive: true, force: true });
}
