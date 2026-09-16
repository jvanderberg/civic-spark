import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HighlightedCodeLines } from "../apps/web/src/vendor/t3code/HighlightedCodeLines.tsx";
import { createIncrementalHighlightedDocument } from "../apps/web/src/vendor/t3code/incrementalHighlighting.ts";
import { getSyntaxHighlighterPromise } from "../apps/web/src/vendor/t3code/syntaxHighlighting.ts";

const markup = (root: Parameters<typeof HighlightedCodeLines>[0]["root"]) =>
  renderToStaticMarkup(createElement(HighlightedCodeLines, { root }));

describe("T3 source code highlighting", () => {
  it("preserves grammar across streamed multiline chunks and source replacements", async () => {
    const highlighter = await getSyntaxHighlighterPromise("javascript");
    const incremental = createIncrementalHighlightedDocument(
      highlighter,
      "javascript",
      "pierre-light",
    );
    for (const code of [
      "const message = `first",
      "const message = `first\nsecond",
      "const message = `first\nsecond`;\nconsole.log(message);\n",
      "/* open comment\ncontinued */\nconst total = 42;\n",
    ]) {
      expect(markup(incremental(code))).toBe(
        markup(highlighter.codeToHast(code, { lang: "javascript", theme: "pierre-light" })),
      );
    }
  });
  it("uses distinct upstream Pierre palettes and escapes HTML-looking source", async () => {
    const highlighter = await getSyntaxHighlighterPromise("sql");
    const code = "SELECT '<img src=x onerror=alert(1)>' AS value;";
    const light = markup(highlighter.codeToHast(code, { lang: "sql", theme: "pierre-light" }));
    const dark = markup(highlighter.codeToHast(code, { lang: "sql", theme: "pierre-dark" }));
    expect(light).toContain("color:");
    expect(dark).not.toBe(light);
    expect(light).toContain("&lt;img");
    expect(light).not.toContain("<img");
  });
  it("unknown languages leave a working plain-text highlighter", async () => {
    const highlighter = await getSyntaxHighlighterPromise("vibehack-unknown-language");
    const result = markup(
      highlighter.codeToHast("<script>example</script>\n", { lang: "text", theme: "pierre-light" }),
    );
    expect(result).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(result).not.toContain("<script>");
  });
});
