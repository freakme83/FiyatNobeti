import {
  isAmazonMarketplaceHost,
  isAmazonTrHost,
  normalizeAmazonUrl,
  parseAmazonInput
} from "./url.js";

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
  return result;
}

function responseDiagnostics(response) {
  return safeDiagnostics({ httpStatus: response?.status, responseType: response?.type });
}

function fail(code, response) {
  throw new ShortLinkResolutionError(code, responseDiagnostics(response));
}

export async function resolveAmazonShortLink(input, { fetchImpl = fetch, signal } = {}) {
  let parsed;
  try {
    parsed = parseAmazonInput(input);
  } catch (error) {
    throw new ShortLinkResolutionError(error?.message || "INVALID_URL");
  }
  if (parsed.type !== "short") throw new ShortLinkResolutionError("UNSUPPORTED_URL");

  let response;
  try {
    response = await fetchImpl(parsed.shortUrl, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal
    });
  } catch (error) {
    const code = signal?.aborted || error?.name === "AbortError"
      ? "SHORT_LINK_TIMEOUT"
      : "SHORT_LINK_NETWORK_ERROR";
    throw new ShortLinkResolutionError(code);
  }

  if (response?.type === "opaqueredirect") fail("SHORT_LINK_OPAQUE_REDIRECT", response);
  if (response?.type === "opaque") fail("SHORT_LINK_OPAQUE_RESPONSE", response);
  if (!response || !["basic", "cors", "default"].includes(response.type)) {
    fail("SHORT_LINK_UNUSABLE_RESPONSE", response);
  }

  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
    fail("SHORT_LINK_HTTP_STATUS", response);
  }

  if (typeof response.url !== "string" || !response.url.trim()) {
    fail("SHORT_LINK_FINAL_URL_MISSING", response);
  }

  let finalUrl;
  try {
    finalUrl = new URL(response.url);
  } catch {
    fail("SHORT_LINK_FINAL_URL_INVALID", response);
  }

  if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password || finalUrl.port) {
    fail("SHORT_LINK_UNSAFE_REDIRECT", response);
  }
  if (!isAmazonTrHost(finalUrl.hostname)) {
    if (isAmazonMarketplaceHost(finalUrl.hostname)) {
      fail("SHORT_LINK_UNSUPPORTED_MARKETPLACE", response);
    }
    fail("SHORT_LINK_UNSAFE_REDIRECT", response);
  }

  try {
    return { type: "product", ...normalizeAmazonUrl(finalUrl.href) };
  } catch {
    fail("SHORT_LINK_UNSUPPORTED_PRODUCT_URL", response);
  }
}
