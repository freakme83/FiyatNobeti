export const AMAZON_PERMISSION_ORIGIN = "https://www.amazon.com.tr/*";
export const AMAZON_SHORT_LINK_PERMISSION_ORIGIN = "https://amzn.eu/*";
export const REQUIRED_AMAZON_ORIGINS = Object.freeze([
  AMAZON_PERMISSION_ORIGIN,
  AMAZON_SHORT_LINK_PERMISSION_ORIGIN,
]);

export async function getMissingAmazonOrigins(permissions) {
  const checks = await Promise.all(REQUIRED_AMAZON_ORIGINS.map(async origin => [
    origin,
    await permissions.contains({ origins: [origin] }),
  ]));
  return checks.filter(([, present]) => present !== true).map(([origin]) => origin);
}
