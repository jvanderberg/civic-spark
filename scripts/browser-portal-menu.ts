import type { Page } from "playwright";

export async function openPortalMenu(page: Page) {
  const menu = page.getByRole("button", { name: "Portal navigation", exact: true });
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true")
    await menu.click();
}

export async function openAdminSection(
  page: Page,
  name: "Overview" | "Projects" | "Sprites" | "Teams" | "People & roles",
) {
  await page.getByRole("button", { name: "Event admin", exact: true }).click();
  await openPortalMenu(page);
  await page
    .getByRole("navigation", { name: "Admin navigation", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}
