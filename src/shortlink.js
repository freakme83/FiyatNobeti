import {
  isAmazonMarketplaceHost,
  isAmazonTrHost,
  normalizeAmazonUrl,
  parseAmazonInput
} from "./url.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function validateRedirect(location, currentUrl) {
  let next;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new Error("SHORT_LINK_RESOLUTION_FAILED");
  }
  if (next.protocol !== "https:" || next.username || next.password || next.port) {
    throw new Error("UNSAFE_REDIRECT");
  }
  if (isAmazonTrHost(next.hostname)) {
    try {
      return { type: "product", ...normalizeAmazonUrl(next.href) };
    } catch {
      throw new Error("SHORT_LINK_RESOLUTION_FAILED");
    }
  }
  if (next.hostname === "amzn.eu") {
    try {
      return parseAmazonInput(next.href);
    } catch {
      throw new Error("SHORT_LINK_RESOLUTION_FAILED");
    }
  }
  if (isAmazonMarketplaceHost(next.hostname)) {
    throw new Error("UNSUPPORTED_MARKETPLACE");
  }
  throw new Error("UNSAFE_REDIRECT");
}

export async function resolveAmazonShortLink(input, {
  fetchImpl = fetch,
  maxRedirects = MAX_REDIRECTS,
  signal
} = {}) {
  let parsed;
  try {
    parsed = parseAmazonInput(input);
  } catch (error) {
    throw new Error(error.message);
  }
  if (parsed.type !== "short") throw new Error("UNSUPPORTED_URL");

  let current = parsed.shortUrl;
  let redirectsFollowed = 0;
  const visited = new Set();
  while (true) {
    if (visited.has(current)) throw new Error("SHORT_LINK_REDIRECT_LOOP");
    visited.add(current);

    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "manual",
        signal
      });
    } catch {
      throw new Error("SHORT_LINK_RESOLUTION_FAILED");
    }

    if (response.type === "opaqueredirect") {
      throw new Error("SHORT_LINK_RESOLUTION_FAILED");
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      throw new Error("SHORT_LINK_RESOLUTION_FAILED");
    }
    const location = response.headers?.get("location");
    if (!location) throw new Error("SHORT_LINK_RESOLUTION_FAILED");
    if (redirectsFollowed >= maxRedirects) throw new Error("SHORT_LINK_TOO_MANY_REDIRECTS");

    const destination = validateRedirect(location, current);
    redirectsFollowed += 1;
    if (destination.type === "product") return destination;
    current = destination.shortUrl;
  }
}
