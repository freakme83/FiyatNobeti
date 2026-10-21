import {
  isAmazonMarketplaceHost,
  isAmazonTrHost,
  normalizeAmazonUrl,
  parseAmazonInput
} from "./url.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const RESPONSE_TYPES = new Set(["basic", "cors", "default", "error", "opaque", "opaqueredirect"]);

export class ShortLinkResolutionError extends Error {
  constructor(code, diagnostics = {}) {
    super(code);
    this.name = "ShortLinkResolutionError";
    this.code = code;
    this.diagnostics = safeDiagnostics(diagnostics);
  }
}

function safeDiagnostics(value = {}) {
  const result = {};
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) {
    result.httpStatus = value.httpStatus;
  }
  if (RESPONSE_TYPES.has(value.responseType)) result.responseType = value.responseType;
  if (Number.isInteger(value.redirectCount)) result.redirectCount = Math.max(0, Math.min(MAX_REDIRECTS, value.redirectCount));
  if (typeof value.locationAccessible === "boolean") result.locationAccessible = value.locationAccessible;
  return result;
}

function failure(code, redirectCount, response, extras = {}) {
  return new ShortLinkResolutionError(code, {
    redirectCount,
    responseType: response?.type,
    httpStatus: response?.status,
    ...extras
  });
}

function validateRedirect(location, currentUrl, redirectCount) {
  let next;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new ShortLinkResolutionError("SHORT_LINK_UNSAFE_REDIRECT", { redirectCount });
  }
  if (next.protocol !== "https:" || next.username || next.password || next.port) {
    throw new ShortLinkResolutionError("SHORT_LINK_UNSAFE_REDIRECT", { redirectCount });
  }
  if (isAmazonTrHost(next.hostname)) {
    try {
      return { type: "product", ...normalizeAmazonUrl(next.href) };
    } catch {
      throw new ShortLinkResolutionError("SHORT_LINK_UNSAFE_REDIRECT", { redirectCount });
    }
  }
  if (next.hostname === "amzn.eu") {
    try {
      return parseAmazonInput(next.href);
    } catch {
      throw new ShortLinkResolutionError("SHORT_LINK_UNSAFE_REDIRECT", { redirectCount });
    }
  }
  if (isAmazonMarketplaceHost(next.hostname)) {
    throw new ShortLinkResolutionError("SHORT_LINK_UNSUPPORTED_MARKETPLACE", { redirectCount });
  }
  throw new ShortLinkResolutionError("SHORT_LINK_UNSAFE_REDIRECT", { redirectCount });
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
    throw new ShortLinkResolutionError(error?.message || "INVALID_URL");
  }
  if (parsed.type !== "short") throw new ShortLinkResolutionError("UNSUPPORTED_URL");

  const redirectLimit = Number.isInteger(maxRedirects)
    ? Math.max(0, Math.min(MAX_REDIRECTS, maxRedirects))
    : MAX_REDIRECTS;
  let current = parsed.shortUrl;
  let redirectsFollowed = 0;
  const visited = new Set();
  while (true) {
    if (visited.has(current)) {
      throw new ShortLinkResolutionError("SHORT_LINK_REDIRECT_LOOP", { redirectCount: redirectsFollowed });
    }
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
    } catch (error) {
      const code = signal?.aborted || error?.name === "AbortError"
        ? "SHORT_LINK_TIMEOUT"
        : "SHORT_LINK_NETWORK_ERROR";
      throw new ShortLinkResolutionError(code, { redirectCount: redirectsFollowed });
    }

    if (response?.type === "opaqueredirect") {
      throw failure("SHORT_LINK_OPAQUE_REDIRECT", redirectsFollowed, response, { locationAccessible: false });
    }

    if (!REDIRECT_STATUSES.has(response?.status)) {
      let locationAccessible = false;
      try { locationAccessible = Boolean(response?.headers?.get("location")); } catch { /* omit response details */ }
      throw failure("SHORT_LINK_HTTP_STATUS", redirectsFollowed, response, { locationAccessible });
    }

    let location;
    try { location = response.headers?.get("location") || null; } catch { location = null; }
    if (!location) {
      throw failure("SHORT_LINK_LOCATION_MISSING", redirectsFollowed, response, { locationAccessible: false });
    }
    if (redirectsFollowed >= redirectLimit) {
      throw failure("SHORT_LINK_TOO_MANY_REDIRECTS", redirectsFollowed, response, { locationAccessible: true });
    }

    let destination;
    try {
      destination = validateRedirect(location, current, redirectsFollowed + 1);
    } catch (error) {
      if (error instanceof ShortLinkResolutionError) {
        const details = safeDiagnostics({
          ...error.diagnostics,
          httpStatus: response.status,
          responseType: response.type,
          redirectCount: redirectsFollowed + 1,
          locationAccessible: true
        });
        throw new ShortLinkResolutionError(error.code, details);
      }
      throw new ShortLinkResolutionError("SHORT_LINK_RESOLUTION_FAILED", {
        httpStatus: response.status,
        responseType: response.type,
        redirectCount: redirectsFollowed,
        locationAccessible: true
      });
    }
    redirectsFollowed += 1;
    if (destination.type === "product") return destination;
    current = destination.shortUrl;
  }
}
