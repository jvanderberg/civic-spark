import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Page } from "playwright";

const markdown = `# Brief overview

## Data sources

Explore **community connections** with *careful comparisons* and ~~old assumptions~~.

- Local access
- Shared resources
  - Neighborhood detail

1. Read the data
2. Compare results

> Keep the source context.

[Dataset](https://example.test/data.csv?year=2026&area=%20#source)

Use \`PROJECT.md\` for context.

\`\`\`ts
const source = "${"long-source-".repeat(35)}";
const example = "<script>literal code</script>";
\`\`\`

| Neighborhood | Bus access | Rail access | Walking access | Notes |
| --- | --- | --- | --- | --- |
| North | Frequent | Frequent | Nearby | Check the source |

- [x] Read source
- [ ] Compare access

![Tracking image](https://brief-tracker.invalid/pixel.png)

[Unsafe script](javascript:alert%281%29)
[Unsafe data](data:text/html;base64,PHNjcmlwdD4=)
[Unsafe vbscript](vbscript:msgbox%281%29)

<script>window.briefUnsafe = true</script>
<img src="https://brief-tracker.invalid/html.png" onerror="window.briefUnsafe = true">
<iframe src="https://brief-tracker.invalid/frame"></iframe>

`;
const ending = "\n\n## End of brief\n\nFinal source notes.\n";
// Match the longest imported brief without putting event-specific data in source.
export const projectBriefFixture =
  markdown +
  "Explore neighborhood access with the original data and document the limitations.\n\n"
    .repeat(150)
    .slice(0, 9985 - markdown.length - ending.length) +
  ending;

export function watchBriefRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("brief-tracker.invalid")) requests.push(request.url());
  });
  return requests;
}

export async function verifyProjectBrief(
  page: Page,
  card: Locator,
  actionName: string,
  artifacts: string,
  surface: string,
) {
  const initialViewport = page.viewportSize();
  const brief = card.locator(".project-brief");
  const summary = brief.locator("summary");
  assert.equal(await brief.getAttribute("open"), null);
  assert.equal(await summary.innerText(), "Read project brief");
  await summary.focus();
  await summary.press("Enter");
  assert.equal(await brief.getAttribute("open"), "");
  const rendered = brief.locator(".project-brief-markdown");
  await rendered.getByRole("heading", { name: "Brief overview", level: 1 }).waitFor();
  assert.equal(await rendered.getByRole("heading", { name: "Data sources", level: 2 }).count(), 1);
  assert.equal(await rendered.locator("strong").innerText(), "community connections");
  assert.equal(await rendered.locator("em").innerText(), "careful comparisons");
  assert.equal(await rendered.locator("del").innerText(), "old assumptions");
  assert.equal(await rendered.locator("ul ul > li").innerText(), "Neighborhood detail");
  assert.equal(await rendered.locator("ol > li").count(), 2);
  assert.equal(await rendered.locator("blockquote").innerText(), "Keep the source context.");
  assert.equal(await rendered.locator("p > code").innerText(), "PROJECT.md");
  assert(
    (await rendered.locator("pre code").innerText()).includes("<script>literal code</script>"),
  );
  assert.equal(await rendered.locator("table th").count(), 5);
  assert.equal(await rendered.locator("table tbody tr").count(), 1);
  assert.equal(await rendered.locator('input[type="checkbox"]:disabled').count(), 2);
  const link = rendered.getByRole("link", { name: "Dataset", exact: true });
  assert.equal(
    await link.getAttribute("href"),
    "https://example.test/data.csv?year=2026&area=%20#source",
  );
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  for (const text of ["Unsafe script", "Unsafe data", "Unsafe vbscript"]) {
    assert.equal(await rendered.getByText(text, { exact: true }).getAttribute("href"), "");
  }
  assert.equal(await rendered.locator("script, img, iframe, object, embed").count(), 0);
  assert.equal(await page.evaluate(() => Reflect.get(window, "briefUnsafe")), undefined);
  assert.equal(await rendered.getByText("Image: Tracking image", { exact: true }).count(), 1);

  const panel = brief.getByRole("region", { name: "Project brief", exact: true });
  for (const colorScheme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [360, 780],
      [390, 844],
      [1440, 900],
      [360, 430],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        colorScheme,
      );
      assert.equal(await brief.getAttribute("open"), "", "Resize/theme retains disclosure state");
      assert(await panel.evaluate((el) => el.scrollHeight > el.clientHeight));
      const panelBox = await panel.boundingBox();
      assert(panelBox && panelBox.height <= height / 2 + 1);
      await summary.scrollIntoViewIfNeeded();
      assert(((await summary.boundingBox())?.height ?? 0) >= 44);
      await panel.evaluate((el) => {
        el.scrollTop = 0;
      });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: join(artifacts, `brief-${surface}-${width}-${height}-${colorScheme}.png`),
      });

      for (const scroller of [rendered.locator("pre"), rendered.locator(".project-brief-table")]) {
        await scroller.focus();
        await scroller.press("ArrowRight");
        await page.waitForFunction((el) => el && el.scrollLeft > 0, await scroller.elementHandle());
        assert(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth));
      }
      await page.screenshot({
        path: join(artifacts, `brief-${surface}-code-table-${width}-${height}-${colorScheme}.png`),
      });
      await panel.focus();
      await panel.press("End");
      await rendered
        .getByRole("heading", { name: "End of brief", exact: true })
        .scrollIntoViewIfNeeded();
      assert(await panel.evaluate((el) => el.scrollTop > 0));
      const action = card.getByRole("button", { name: actionName, exact: true });
      await action.scrollIntoViewIfNeeded();
      const box = await action.boundingBox();
      assert(
        box &&
          box.x >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y >= 0 &&
          box.y + box.height <= height + 1,
      );
      await summary.scrollIntoViewIfNeeded();
      if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await summary.tap();
      else await summary.click();
      assert.equal(await brief.getAttribute("open"), null);
      await summary.focus();
      await summary.press("Space");
      assert.equal(await brief.getAttribute("open"), "");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await summary.click();
  if (initialViewport) await page.setViewportSize(initialViewport);
  await page.emulateMedia({ colorScheme: "light" });
}
