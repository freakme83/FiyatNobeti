export const WATCHLIST_KEY = "watchlist";
export const WATCHLIST_VERSION = 1;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

export function createWatchlist() {
  return { version: WATCHLIST_VERSION, products: {} };
}

export function normalizeProductTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!title || title.length > 200 || !/[\p{L}\p{N}]/u.test(title)) return null;
  return title;
}

export function createProductRecord({ asin, canonicalUrl, title = null, addedAt = new Date().toISOString() }) {
  const normalizedAsin = typeof asin === "string" ? asin.toUpperCase() : "";
  if (!ASIN_PATTERN.test(normalizedAsin) || typeof canonicalUrl !== "string" ||
      canonicalUrl !== `https://www.amazon.com.tr/dp/${normalizedAsin}`) {
    throw new Error("INVALID_PRODUCT");
  }
  return {
    asin: normalizedAsin,
    canonicalUrl,
    title: normalizeProductTitle(title),
    lastSuccessfulPriceTry: null,
    lastSuccessfulCheckAt: null,
    lastAttemptedCheckAt: null,
    lastCheckStatus: "never",
    lastErrorCode: null,
    addedAt
  };
}

export function normalizeWatchlist(value) {
  if (value == null) return createWatchlist();
  if (!value || value.version !== WATCHLIST_VERSION || !value.products || typeof value.products !== "object") {
    throw new Error("WATCHLIST_UNSUPPORTED_VERSION");
  }
  const products = {};
  for (const [key, candidate] of Object.entries(value.products)) {
    if (!candidate || typeof candidate !== "object") continue;
    const asin = typeof candidate.asin === "string" ? candidate.asin.toUpperCase() : "";
    if (key !== asin || !ASIN_PATTERN.test(asin)) continue;
    const canonicalUrl = `https://www.amazon.com.tr/dp/${asin}`;
    const record = createProductRecord({ asin, canonicalUrl, title: candidate.title, addedAt: candidate.addedAt });
    if (Number.isFinite(candidate.lastSuccessfulPriceTry) && candidate.lastSuccessfulPriceTry > 0) {
      record.lastSuccessfulPriceTry = candidate.lastSuccessfulPriceTry;
      record.lastSuccessfulCheckAt = typeof candidate.lastSuccessfulCheckAt === "string" ? candidate.lastSuccessfulCheckAt : null;
    }
    record.lastAttemptedCheckAt = typeof candidate.lastAttemptedCheckAt === "string" ? candidate.lastAttemptedCheckAt : null;
    record.lastCheckStatus = ["never", "checking", "success", "failure"].includes(candidate.lastCheckStatus)
      ? candidate.lastCheckStatus : "never";
    record.lastErrorCode = typeof candidate.lastErrorCode === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate.lastErrorCode)
      ? candidate.lastErrorCode : null;
    products[asin] = record;
  }
  return { version: WATCHLIST_VERSION, products };
}
