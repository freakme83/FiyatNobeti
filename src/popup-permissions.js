export const AMAZON_SHORT_LINK_PERMISSION_ORIGIN = "https://amzn.eu/*";

export async function requestShortLinkPermission(permissions) {
  const granted = await permissions.request({ origins: [AMAZON_SHORT_LINK_PERMISSION_ORIGIN] });
  const present = await permissions.contains({ origins: [AMAZON_SHORT_LINK_PERMISSION_ORIGIN] });
  return granted === true && present === true;
}
