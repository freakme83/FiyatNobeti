export const PRICE_CHECK_DIAGNOSTICS_KEY = "priceCheckDiagnostics";
const LIMIT = 30;
const ERROR_CODES = new Set([
  "PERMISSION_REQUIRED", "REDIRECT", "ACCESS_DENIED", "BOT_VERIFICATION", "AUTH_REQUIRED",
  "HTTP_ERROR", "HTML_STRUCTURE", "PRICE_MISSING", "PRICE_AMBIGUOUS", "PRICE_UNRECOGNIZED",
  "RESPONSE_TOO_LARGE", "TIMEOUT", "NETWORK_ERROR", "PARSE_ERROR"
]);
const PAGE_CLASSES = new Set(["product", "verification", "access-denied", "authentication", "unrecognized"]);

export function sanitizeDiagnosticEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt) ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.asin !== "string" || !/^[A-Z0-9]{10}$/.test(value.asin) ||
      !["manual", "automatic"].includes(value.origin) || !["success", "failure"].includes(value.result)) return null;
  if (value.result === "failure" && !ERROR_CODES.has(value.errorCode)) return null;
  const entry = {
    checkedAt: value.checkedAt, asin: value.asin, origin: value.origin, result: value.result,
    ...(value.result === "failure" ? { errorCode: value.errorCode } : {})
  };
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) entry.httpStatus = value.httpStatus;
  if (["html", "other", "unknown"].includes(value.contentType)) entry.contentType = value.contentType;
  if (Number.isInteger(value.responseSizeBytesApprox) && value.responseSizeBytesApprox >= 0 &&
      value.responseSizeBytesApprox <= 5 * 1024 * 1024 && value.responseSizeBytesApprox % 1024 === 0) {
    entry.responseSizeBytesApprox = value.responseSizeBytesApprox;
  }
  if (PAGE_CLASSES.has(value.pageClass)) entry.pageClass = value.pageClass;
  return entry;
}

export function normalizeDiagnosticHistory(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.entries)) return { version: 1, entries: [] };
  return { version: 1, entries: value.entries.slice(-LIMIT).map(sanitizeDiagnosticEntry).filter(Boolean) };
}

export function completedCheckEntry({ asin, automatic, result, checkedAt, response }) {
  const pageClass = result.status === "success" ? "product" : ({
    BOT_VERIFICATION: "verification", ACCESS_DENIED: "access-denied", AUTH_REQUIRED: "authentication",
    HTML_STRUCTURE: "unrecognized"
  })[result.errorCode];
  return sanitizeDiagnosticEntry({
    checkedAt, asin, origin: automatic ? "automatic" : "manual", result: result.status,
    errorCode: ERROR_CODES.has(result.errorCode) ? result.errorCode : "PARSE_ERROR",
    httpStatus: response.httpStatus,
    contentType: response.contentType === "text/html" ? "html" : response.contentType ? "other" : "unknown",
    responseSizeBytesApprox: Number.isInteger(response.responseBytes)
      ? Math.ceil(response.responseBytes / 1024) * 1024 : undefined,
    pageClass
  });
}

// The caller serializes all check completions with the existing watchlist lock.
export async function appendDiagnosticHistory(storage, entry) {
  const safe = sanitizeDiagnosticEntry(entry);
  if (!safe) return;
  const stored = await storage.get(PRICE_CHECK_DIAGNOSTICS_KEY);
  const history = normalizeDiagnosticHistory(stored[PRICE_CHECK_DIAGNOSTICS_KEY]);
  history.entries.push(safe);
  history.entries = history.entries.slice(-LIMIT);
  await storage.set({ [PRICE_CHECK_DIAGNOSTICS_KEY]: history });
}
