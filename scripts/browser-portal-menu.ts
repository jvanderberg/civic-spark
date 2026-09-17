import type { Page } from "playwright";

export async function openPortalMenu(page: Page) {
  const menu = page.getByRole("button", { name: "Portal navigation", exact: true });
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true")
    await menu.click();
}

export async function openAdminSection(
  page: Page,
  name: "Event details" | "Projects" | "Sprites" | "Teams" | "People & roles",
) {
  await openPortalMenu(page);
  const parent = page.getByRole("button", { name: "Admin", exact: true });
  if ((await parent.getAttribute("aria-expanded")) !== "true") await parent.click();
  await page
    .getByRole("navigation", { name: "Admin navigation", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}
