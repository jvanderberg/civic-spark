/** Public routing configuration only; credentials never belong in preview origins. */
export function validatePreviewOriginTemplate(template: string, portal: string): string {
  const example = template.replace("{workspace}", "workspace");
  let url: URL;
  try {
    url = new URL(example);
  } catch {
    throw new Error("Invalid preview origin template");
  }
  const portalHost = new URL(portal).hostname;
  if (
    !/^https:\/\/\{workspace\}\.[a-z0-9.-]+(?::[0-9]+)?$/.test(template) ||
    url.origin !== example ||
    url.hostname === portalHost ||
    url.hostname.endsWith(`.${portalHost}`) ||
    url.hostname.endsWith(".localhost") ||
    !url.hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("Preview requires a separate HTTPS origin with one {workspace} hostname label");
  return template;
}
