export function normalizeAmazonUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("INVALID_URL");
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("INVALID_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.amazon.com.tr" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("INVALID_URL");
  }

  const match = /^\/(?:dp|gp\/product)\/([A-Z0-9]{10})\/?$/i.exec(url.pathname);
  if (!match) {
    throw new Error("UNSUPPORTED_URL");
  }
  const asin = match[1].toUpperCase();
  return { asin, canonicalUrl: `https://www.amazon.com.tr/dp/${asin}` };
}
