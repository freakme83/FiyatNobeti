const AMAZON_TR_HOST = "www.amazon.com.tr";
const AMAZON_MARKETPLACES = new Set([
  "www.amazon.com", "www.amazon.co.uk", "www.amazon.de", "www.amazon.fr",
  "www.amazon.it", "www.amazon.es", "www.amazon.nl", "www.amazon.se",
  "www.amazon.pl", "www.amazon.com.be", "www.amazon.ca", "www.amazon.co.jp",
  "www.amazon.com.au", "www.amazon.in", "www.amazon.com.br", "www.amazon.com.mx",
  "www.amazon.sg", "www.amazon.ae", "www.amazon.sa", "www.amazon.eg"
]);
const ASIN = /^[A-Z0-9]{10}$/i;
const REFERRAL_SEGMENT = /^ref=[A-Z0-9._~-]+$/i;
const REFERRAL_ID_SEGMENT = /^\d{3}-\d{7}-\d{7}$/;
const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._~-]*$/u;
const SHORT_CODE = /^[A-Z0-9_-]{6,32}$/i;

function parseUrl(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("INVALID_URL");
  try {
    return new URL(input.trim());
  } catch {
    throw new Error("INVALID_URL");
  }
}

function assertSecureAmazonDestination(url) {
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("INVALID_URL");
  }
  if (url.hostname !== AMAZON_TR_HOST) {
    if (AMAZON_MARKETPLACES.has(url.hostname)) throw new Error("UNSUPPORTED_MARKETPLACE");
    throw new Error("INVALID_URL");
  }
}

function validateReferralTail(segments) {
  return segments.every((segment, index) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (REFERRAL_SEGMENT.test(decoded)) return true;
    return index === segments.length - 1 && index > 0 &&
      REFERRAL_SEGMENT.test(decodeURIComponent(segments[index - 1])) &&
      REFERRAL_ID_SEGMENT.test(decoded);
  });
}

function validateSlug(segment) {
  try {
    const decoded = decodeURIComponent(segment);
    return !/[\\/]/.test(decoded) && SLUG.test(decoded);
  } catch {
    return false;
  }
}

export function normalizeAmazonUrl(input) {
  const url = parseUrl(input);
  assertSecureAmazonDestination(url);
  const segments = url.pathname.split("/").slice(1);
  let asin;
  let tail;

  if (segments[0] === "dp" && segments.length >= 2) {
    asin = segments[1];
    tail = segments.slice(2);
  } else if (segments[0] === "gp" && segments[1] === "product" && segments.length >= 3) {
    asin = segments[2];
    tail = segments.slice(3);
  } else if (segments.length >= 3 && segments[1] === "dp" && validateSlug(segments[0])) {
    asin = segments[2];
    tail = segments.slice(3);
  } else {
    throw new Error("UNSUPPORTED_URL");
  }

  if (!ASIN.test(asin || "")) throw new Error("UNSUPPORTED_URL");
  const referralTail = tail.filter((segment, index) => !(index === tail.length - 1 && segment === ""));
  if (!validateReferralTail(referralTail)) throw new Error("UNSUPPORTED_URL");
  asin = asin.toUpperCase();
  return { asin, canonicalUrl: `https://${AMAZON_TR_HOST}/dp/${asin}` };
}

export function parseAmazonInput(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("INVALID_URL");
  const trimmed = input.trim();
  if (ASIN.test(trimmed)) {
    const asin = trimmed.toUpperCase();
    return { type: "product", asin, canonicalUrl: `https://${AMAZON_TR_HOST}/dp/${asin}` };
  }
  const url = parseUrl(trimmed);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("INVALID_URL");
  }
  if (url.hostname === "amzn.eu") {
    const segments = url.pathname.split("/").slice(1);
    const code = segments[1];
    const trailingSlash = segments.length === 3 && segments[2] === "";
    if (segments[0] !== "d" || !SHORT_CODE.test(code || "") || !(segments.length === 2 || trailingSlash)) {
      throw new Error("UNSUPPORTED_URL");
    }
    return { type: "short", shortUrl: `https://amzn.eu/d/${code}` };
  }
  return { type: "product", ...normalizeAmazonUrl(url.href) };
}

export function isAmazonMarketplaceHost(hostname) {
  return AMAZON_MARKETPLACES.has(hostname);
}

export function isAmazonTrHost(hostname) {
  return hostname === AMAZON_TR_HOST;
}
