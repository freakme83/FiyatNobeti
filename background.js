import { parseAmazonInput } from "./src/url.js";
import { resolveAmazonShortLink } from "./src/shortlink.js";
import {
  createProductRecord,
  createWatchlist,
  normalizeProductTitle,
  normalizeWatchlist,
  WATCHLIST_KEY
} from "./src/watchlist.js";

const AMAZON_ORIGIN = "https://www.amazon.com.tr/*";
const SHORT_LINK_ORIGIN = "https://amzn.eu/*";
const OFFSCREEN_PATH = "offscreen.html";
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const SHORT_LINK_ERROR_CODES = new Set([
  "SHORT_LINK_OPAQUE_REDIRECT", "SHORT_LINK_LOCATION_MISSING", "SHORT_LINK_HTTP_STATUS",
  "SHORT_LINK_NETWORK_ERROR", "SHORT_LINK_TIMEOUT", "SHORT_LINK_REDIRECT_LOOP",
  "SHORT_LINK_TOO_MANY_REDIRECTS", "SHORT_LINK_UNSAFE_REDIRECT", "SHORT_LINK_UNSUPPORTED_MARKETPLACE",
  "SHORT_LINK_OPAQUE_RESPONSE", "SHORT_LINK_UNUSABLE_RESPONSE", "SHORT_LINK_FINAL_URL_MISSING",
  "SHORT_LINK_FINAL_URL_INVALID", "SHORT_LINK_UNSUPPORTED_PRODUCT_URL"
]);
const SHORT_LINK_RESPONSE_TYPES = new Set(["basic", "cors", "default", "error", "opaque", "opaqueredirect"]);
let creatingOffscreen;
let watchlistMutationQueue = Promise.resolve();
const inFlightChecks = new Map();
const checkGenerations = new Map();

function shortLinkDiagnostics(error) {
  const diagnostics = {};
  const source = error?.diagnostics || {};
  if (Number.isInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599) diagnostics.httpStatus = source.httpStatus;
  if (SHORT_LINK_RESPONSE_TYPES.has(source.responseType)) diagnostics.responseType = source.responseType;
  if (Number.isInteger(source.redirectCount) && source.redirectCount >= 0 && source.redirectCount <= 5) diagnostics.redirectCount = source.redirectCount;
  if (typeof source.locationAccessible === "boolean") diagnostics.locationAccessible = source.locationAccessible;
  return diagnostics;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Elle getirilen Amazon HTML içeriğinde birincil fiyatı ve ürün başlığını DOM ile ayrıştırmak"
    }).finally(() => { creatingOffscreen = undefined; });
  }
  await creatingOffscreen;
}

async function readLimitedHtml(response) {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_HTML_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("NETWORK_ERROR");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) throw new Error("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk, index) => decoder.decode(chunk, { stream: index < chunks.length - 1 })).join("") + decoder.decode();
}

async function fetchProduct(canonicalUrl) {
  if (!await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
    return { status: "failure", errorCode: "PERMISSION_REQUIRED" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(canonicalUrl, {
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal
    });
    if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
      return { status: "failure", errorCode: "REDIRECT" };
    }
    if (response.status === 401 || response.status === 403) return { status: "failure", errorCode: "ACCESS_DENIED" };
    if (!response.ok) return { status: "failure", errorCode: "HTTP_ERROR", httpStatus: response.status };
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      return { status: "failure", errorCode: "HTML_STRUCTURE" };
    }
    const html = await readLimitedHtml(response);
    await ensureOffscreen();
    const parsed = await chrome.runtime.sendMessage({ type: "PARSE_HTML", html });
    if (parsed?.status === "success" && Number.isFinite(parsed.priceTry)) {
      return { status: "success", priceTry: parsed.priceTry, title: normalizeProductTitle(parsed.title) };
    }
    return { status: "failure", errorCode: parsed?.errorCode || "PARSE_ERROR" };
  } catch (error) {
    return {
      status: "failure",
      errorCode: error?.message === "RESPONSE_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveProductInput(input) {
  let requested;
  try {
    requested = parseAmazonInput(input);
  } catch (error) {
    return { status: "failure", errorCode: error.message };
  }
  if (requested.type === "product") return { status: "success", product: requested };
  if (!await chrome.permissions.contains({ origins: [SHORT_LINK_ORIGIN] })) {
    return { status: "failure", errorCode: "SHORT_LINK_PERMISSION_REQUIRED" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    return { status: "success", product: await resolveAmazonShortLink(requested.shortUrl, { signal: controller.signal }) };
  } catch (error) {
    const errorCode = SHORT_LINK_ERROR_CODES.has(error?.code) ? error.code : "SHORT_LINK_RESOLUTION_FAILED";
    const diagnostics = shortLinkDiagnostics(error);
    return { status: "failure", errorCode, ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}

async function probe(input) {
  let inputShortUrl;
  try {
    const submitted = parseAmazonInput(input);
    if (submitted.type === "short") inputShortUrl = submitted.shortUrl;
  } catch { /* resolveProductInput returns the safe validation error. */ }
  const resolution = await resolveProductInput(input);
  const result = {
    ...(resolution.product ? { asin: resolution.product.asin, canonicalUrl: resolution.product.canonicalUrl } : {}),
    ...(!resolution.product && inputShortUrl ? { inputUrl: inputShortUrl } : {}),
    checkedAt: new Date().toISOString(),
    status: "failure",
    ...(resolution.status === "failure" ? { errorCode: resolution.errorCode, ...(resolution.diagnostics ? { diagnostics: resolution.diagnostics } : {}) } : {})
  };
  if (resolution.status === "success") Object.assign(result, await fetchProduct(resolution.product.canonicalUrl));
  result.checkedAt = new Date().toISOString();
  try {
    const update = { lastCheck: result };
    if (result.status === "success") update.lastSuccess = result;
    await chrome.storage.local.set(update);
  } catch {
    return { ...result, storageError: true };
  }
  return result;
}

function withWatchlistLock(task) {
  const next = watchlistMutationQueue.then(task, task);
  watchlistMutationQueue = next.catch(() => {});
  return next;
}

async function readWatchlist() {
  const stored = await chrome.storage.local.get([WATCHLIST_KEY, "lastCheck", "lastSuccess"]);
  if (stored[WATCHLIST_KEY] !== undefined) return normalizeWatchlist(stored[WATCHLIST_KEY]);

  const watchlist = createWatchlist();
  const success = stored.lastSuccess;
  if (success?.status === "success" && Number.isFinite(success.priceTry) && success.asin && success.canonicalUrl) {
    try {
      const record = createProductRecord({ asin: success.asin, canonicalUrl: success.canonicalUrl, title: success.title, addedAt: success.checkedAt });
      record.lastSuccessfulPriceTry = success.priceTry;
      record.lastSuccessfulCheckAt = success.checkedAt || null;
      record.lastAttemptedCheckAt = stored.lastCheck?.checkedAt || success.checkedAt || null;
      record.lastCheckStatus = stored.lastCheck?.status === "failure" ? "failure" : "success";
      record.lastErrorCode = stored.lastCheck?.status === "failure" ? stored.lastCheck.errorCode || null : null;
      watchlist.products[record.asin] = record;
    } catch { /* Ignore invalid legacy probe data without altering it. */ }
  }
  await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
  return watchlist;
}

async function getWatchlist() {
  return withWatchlistLock(async () => {
    try { return { status: "success", watchlist: await readWatchlist() }; }
    catch (error) { return { status: "failure", errorCode: error?.message === "WATCHLIST_UNSUPPORTED_VERSION" ? error.message : "STORAGE_ERROR" }; }
  });
}

async function checkWatchlistProduct(asin) {
  if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) return { status: "failure", errorCode: "INVALID_PRODUCT" };
  asin = asin.toUpperCase();
  if (inFlightChecks.has(asin)) return { status: "busy", asin };
  const generation = (checkGenerations.get(asin) || 0) + 1;
  checkGenerations.set(asin, generation);

  const operation = (async () => {
    const start = await withWatchlistLock(async () => {
      const watchlist = await readWatchlist();
      const product = watchlist.products[asin];
      if (!product) return null;
      product.lastAttemptedCheckAt = new Date().toISOString();
      product.lastCheckStatus = "checking";
      product.lastErrorCode = null;
      await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
      return product.canonicalUrl;
    });
    if (!start) return { status: "failure", asin, errorCode: "PRODUCT_NOT_FOUND" };

    const fetched = await fetchProduct(start);
    const checkedAt = new Date().toISOString();
    return withWatchlistLock(async () => {
      const watchlist = await readWatchlist();
      const product = watchlist.products[asin];
      if (!product || checkGenerations.get(asin) !== generation) return { ...fetched, asin, stale: true };
      product.lastAttemptedCheckAt = checkedAt;
      if (fetched.status === "success") {
        product.lastSuccessfulPriceTry = fetched.priceTry;
        product.lastSuccessfulCheckAt = checkedAt;
        if (fetched.title) product.title = fetched.title;
        product.lastCheckStatus = "success";
        product.lastErrorCode = null;
      } else {
        product.lastCheckStatus = "failure";
        product.lastErrorCode = fetched.errorCode || "PARSE_ERROR";
      }
      await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
      return { ...fetched, asin, checkedAt, product: { ...product } };
    });
  })();

  inFlightChecks.set(asin, operation);
  try { return await operation; }
  catch { return { status: "failure", asin, errorCode: "STORAGE_ERROR" }; }
  finally { if (inFlightChecks.get(asin) === operation) inFlightChecks.delete(asin); }
}

async function addProduct(input) {
  const resolution = await resolveProductInput(input);
  if (resolution.status !== "success") return resolution;
  const { asin, canonicalUrl } = resolution.product;
  const added = await withWatchlistLock(async () => {
    const watchlist = await readWatchlist();
    if (watchlist.products[asin]) return { duplicate: true, product: { ...watchlist.products[asin] } };
    const product = createProductRecord({ asin, canonicalUrl });
    watchlist.products[asin] = product;
    await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
    return { duplicate: false, product: { ...product } };
  });
  if (added.duplicate) return { status: "duplicate", asin, product: added.product };
  const check = await checkWatchlistProduct(asin);
  const current = await getWatchlist();
  return { status: "added", asin, check, watchlist: current.watchlist };
}

async function removeProduct(asin) {
  if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/i.test(asin)) return { status: "failure", errorCode: "INVALID_PRODUCT" };
  asin = asin.toUpperCase();
  checkGenerations.set(asin, (checkGenerations.get(asin) || 0) + 1);
  return withWatchlistLock(async () => {
    const watchlist = await readWatchlist();
    if (!watchlist.products[asin]) return { status: "failure", errorCode: "PRODUCT_NOT_FOUND" };
    delete watchlist.products[asin];
    await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
    return { status: "success", asin, watchlist };
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  let operation;
  if (message?.type === "CHECK_PRICE") operation = probe(message.url);
  else if (message?.type === "GET_WATCHLIST") operation = getWatchlist();
  else if (message?.type === "ADD_PRODUCT") operation = addProduct(message.url);
  else if (message?.type === "CHECK_PRODUCT") operation = checkWatchlistProduct(message.asin);
  else if (message?.type === "REMOVE_PRODUCT") operation = removeProduct(message.asin);
  else return;
  operation.then(sendResponse).catch(() => sendResponse({ status: "failure", errorCode: "STORAGE_ERROR" }));
  return true;
});
