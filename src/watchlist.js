export const WATCHLIST_KEY = "watchlist";
export const WATCHLIST_VERSION = 2;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const MAX_PRICE_CENTS = 99_999_999_999;

export function priceCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const scaled = value * 100;
  if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-7) return null;
  const cents = Math.round(scaled);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_PRICE_CENTS ? cents : null;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function establishFirstBaseline(product, price, checkedAt) {
  if (product.baselineSource !== null || priceCents(price) === null || !validTimestamp(checkedAt)) return;
  product.baselinePriceTry = price;
  product.baselineCheckedAt = checkedAt;
  product.baselineSource = "first";
}

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
    // Manual cooldown must remain independent of automatic attempts.
    lastManualCheckAt: null,
    lastCheckStatus: "never",
    lastErrorCode: null,
    baselinePriceTry: null,
    baselineCheckedAt: null,
    baselineSource: null,
    addedAt
  };
}

export function normalizeWatchlist(value) {
  if (value == null) return createWatchlist();
  if (!value || ![1, WATCHLIST_VERSION].includes(value.version) || !value.products ||
      typeof value.products !== "object" || Array.isArray(value.products)) {
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
    if (value.version === 1) {
      if (priceCents(record.lastSuccessfulPriceTry) !== null) {
        record.baselinePriceTry = record.lastSuccessfulPriceTry;
        record.baselineCheckedAt = validTimestamp(record.lastSuccessfulCheckAt) ? record.lastSuccessfulCheckAt : null;
        record.baselineSource = "migrated";
      }
    } else {
      const source = candidate.baselineSource;
      if (source === null && candidate.baselinePriceTry === null && candidate.baselineCheckedAt === null) {
        // Pending first valid observation.
      } else if (["first", "migrated"].includes(source) && priceCents(candidate.baselinePriceTry) !== null &&
          (validTimestamp(candidate.baselineCheckedAt) || source === "migrated" && candidate.baselineCheckedAt === null)) {
        record.baselinePriceTry = candidate.baselinePriceTry;
        record.baselineCheckedAt = candidate.baselineCheckedAt;
        record.baselineSource = source;
      } else {
        // Never invent a replacement reference for a corrupt version 2 record.
        throw new Error("WATCHLIST_UNSUPPORTED_VERSION");
      }
    }
    record.lastAttemptedCheckAt = typeof candidate.lastAttemptedCheckAt === "string" ? candidate.lastAttemptedCheckAt : null;
    record.lastManualCheckAt = validTimestamp(candidate.lastManualCheckAt) ? candidate.lastManualCheckAt : null;
    record.lastCheckStatus = ["never", "checking", "success", "failure"].includes(candidate.lastCheckStatus)
      ? candidate.lastCheckStatus : "never";
    record.lastErrorCode = typeof candidate.lastErrorCode === "string" && /^[A-Z0-9_]{1,64}$/.test(candidate.lastErrorCode)
      ? candidate.lastErrorCode : null;
    products[asin] = record;
  }
  return { version: WATCHLIST_VERSION, products };
}
