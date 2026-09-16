import type { Page } from "playwright";

export async function openPortalMenu(page: Page) {
  const menu = page.getByRole("button", { name: "Portal navigation", exact: true });
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true")
    await menu.click();
}
