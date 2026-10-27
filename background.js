import { parseAmazonInput } from "./src/url.js";
import { resolveAmazonShortLink } from "./src/shortlink.js";
import {
  createProductRecord,
  createWatchlist,
  establishFirstBaseline,
  normalizeProductTitle,
  normalizeWatchlist,
  WATCHLIST_KEY
} from "./src/watchlist.js";
import {
  AUTO_ALARM_NAME, AUTO_INTERVAL_MS, AUTO_PACE_MS, AUTO_SETTINGS_KEY, AUTO_STATE_KEY,
  defaultAutoState, defaultAutoSettings, nextEligibleAt, normalizeAutoSettings,
  normalizeAutoState, timestampMs, migrateLegacyAutoState
} from "./src/automatic.js";
import { acceptAutomaticPriceTransition } from "./src/automatic-price-notification.js";
import { presentPriceChangeNotification } from "./src/price-drop-notification.js";
import { appendDiagnosticHistory, completedCheckEntry } from "./src/price-check-diagnostics.js";
import { MANUAL_CHECK_COOLDOWN_MS } from "./src/manual-check-cooldown.js";

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
const productInstances = new Map();
let nextProductInstance = 0;
let automaticRun;
let developerEventRecorder;
let pendingAutomaticAlarm;
let recoveryFailed = false;
let startupRecovery;

export function setDeveloperEventRecorderForDev(record) {
  developerEventRecorder = typeof record === "function" ? record : undefined;
}

function recordDeveloperEvent(event) {
  try { developerEventRecorder?.(event)?.catch?.(() => {}); }
  catch { /* Developer diagnostics cannot affect normal checks. */ }
}

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

async function readLimitedHtml(response, diagnostic) {
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
  if (diagnostic) diagnostic.responseBytes = size;
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk, index) => decoder.decode(chunk, { stream: index < chunks.length - 1 })).join("") + decoder.decode();
}

function classifyResponseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "NON_HTTPS";
    if (url.hostname !== "www.amazon.com.tr") return "OTHER_HOST";
    try { return parseAmazonInput(value).type === "product" ? "AMAZON_PRODUCT" : "AMAZON_OTHER"; }
    catch { return "AMAZON_OTHER"; }
  } catch { return "UNAVAILABLE"; }
}

async function fetchProduct(canonicalUrl, { onRequestStart, diagnostic, developerParse = false } = {}) {
  if (!await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
    return { status: "failure", errorCode: "PERMISSION_REQUIRED" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    if (await onRequestStart?.() === false) return { status: "failure", errorCode: "CHECK_CANCELLED" };
    const response = await fetch(canonicalUrl, {
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal
    });
    if (diagnostic) {
      diagnostic.httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      diagnostic.contentType = typeof mime === "string" && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]{1,60}$/.test(mime) ? mime : null;
      diagnostic.finalUrlClassification = classifyResponseUrl(response.url);
      diagnostic.responseType = ["basic", "cors", "default", "opaque", "opaqueredirect", "error"].includes(response.type) ? response.type : "unknown";
    }
    if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
      return { status: "failure", errorCode: "REDIRECT" };
    }
    if (response.status === 401 || response.status === 403) return { status: "failure", errorCode: "ACCESS_DENIED" };
    if (!response.ok) return { status: "failure", errorCode: "HTTP_ERROR", httpStatus: response.status };
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      return { status: "failure", errorCode: "HTML_STRUCTURE" };
    }
    const html = await readLimitedHtml(response, diagnostic);
    await ensureOffscreen();
    const parsed = await chrome.runtime.sendMessage({ type: developerParse ? "PARSE_HTML_DIAG" : "PARSE_HTML", html });
    if (diagnostic && parsed?.diagnostics) diagnostic.structure = parsed.diagnostics;
    if (parsed?.status === "success" && Number.isFinite(parsed.priceTry)) {
      return { status: "success", priceTry: parsed.priceTry, title: normalizeProductTitle(parsed.title) };
    }
    return { status: "failure", errorCode: parsed?.errorCode || "PARSE_ERROR" };
  } catch (error) {
    return {
      status: "failure",
      errorCode: error?.message === "STORAGE_ERROR" ? "STORAGE_ERROR"
        : error?.message === "RESPONSE_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function diagnoseProductForDev(asin) {
  const startedAt = new Date().toISOString();
  const report = { asin: typeof asin === "string" && /^[A-Z0-9]{10}$/.test(asin) ? asin : null,
    startedAt, completedAt: null, outcome: "failure", requestStarted: false };
  const finish = (result) => {
    report.completedAt = new Date().toISOString();
    report.outcome = result.status;
    if (result.errorCode) report.errorCode = result.errorCode;
    return report;
  };
  if (!developerEventRecorder) return finish({ status: "failure", errorCode: "DIAGNOSTICS_UNAVAILABLE" });
  await startupRecovery;
  if (recoveryFailed) return finish({ status: "failure", errorCode: "STORAGE_ERROR" });
  if (!report.asin) return finish({ status: "failure", errorCode: "INVALID_PRODUCT" });
  let flightKey;
  let ownsFlight = false;
  try {
    const start = await withWatchlistLock(async () => {
      // Direct read: diagnosis must not migrate or modify the watchlist.
      const stored = await chrome.storage.local.get(WATCHLIST_KEY);
      const product = normalizeWatchlist(stored[WATCHLIST_KEY]).products[asin];
      if (!product) return { errorCode: "PRODUCT_NOT_FOUND" };
      const identity = productInstance(asin);
      flightKey = `${asin}:${identity}`;
      if (automaticRun || inFlightChecks.has(flightKey)) return { errorCode: "CHECK_BUSY" };
      inFlightChecks.set(flightKey, true);
      ownsFlight = true;
      return { canonicalUrl: product.canonicalUrl, identity };
    });
    if (start.errorCode) return finish({ status: "failure", errorCode: start.errorCode });
    const fetched = await fetchProduct(start.canonicalUrl, {
      diagnostic: report,
      developerParse: true,
      onRequestStart: () => { report.requestStarted = true; }
    });
    const current = await withWatchlistLock(async () => {
      const stored = await chrome.storage.local.get(WATCHLIST_KEY);
      return normalizeWatchlist(stored[WATCHLIST_KEY]).products[asin];
    });
    if (!current || productInstances.get(asin) !== start.identity) {
      return finish({ status: "failure", errorCode: "CHECK_CANCELLED" });
    }
    return finish(fetched);
  } catch { return finish({ status: "failure", errorCode: "STORAGE_ERROR" }); }
  finally { if (ownsFlight && inFlightChecks.has(flightKey)) inFlightChecks.delete(flightKey); }
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
  if (stored[WATCHLIST_KEY] !== undefined) {
    const watchlist = normalizeWatchlist(stored[WATCHLIST_KEY]);
    if (stored[WATCHLIST_KEY].version === 1) {
      // Commit the old price as the reference before any check can replace it.
      await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
    }
    return watchlist;
  }

  const watchlist = createWatchlist();
  const success = stored.lastSuccess;
  if (success?.status === "success" && Number.isFinite(success.priceTry) && success.asin && success.canonicalUrl) {
    try {
      const record = createProductRecord({ asin: success.asin, canonicalUrl: success.canonicalUrl, title: success.title, addedAt: success.checkedAt });
      record.lastSuccessfulPriceTry = success.priceTry;
      record.lastSuccessfulCheckAt = success.checkedAt || null;
      // The legacy single-product probe is also a migrated observation.
      const migrated = normalizeWatchlist({ version: 1, products: { [record.asin]: record } });
      Object.assign(record, migrated.products[record.asin]);
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

function productInstance(asin) {
  let identity = productInstances.get(asin);
  if (identity === undefined) {
    identity = ++nextProductInstance;
    productInstances.set(asin, identity);
  }
  return identity;
}

async function checkWatchlistProduct(asin, {
  automatic = false,
  expectedIdentity,
  bypassEligibility = false,
  onRequestStart
} = {}) {
  if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) return { status: "failure", errorCode: "INVALID_PRODUCT" };
  asin = asin.toUpperCase();
  let flightKey;
  let ownsFlight = false;
  try {
    const start = await withWatchlistLock(async () => {
      const watchlist = await readWatchlist();
      const product = watchlist.products[asin];
      if (!product) return { missing: true };
      const identity = productInstance(asin);
      flightKey = `${asin}:${identity}`;
      if (inFlightChecks.has(flightKey)) return { busy: true };
      if (!automatic) {
        const lastManualAt = typeof product.lastManualCheckAt === "string" ? Date.parse(product.lastManualCheckAt) : NaN;
        if (Number.isFinite(lastManualAt) && Date.now() - lastManualAt < MANUAL_CHECK_COOLDOWN_MS) {
          const retryAt = lastManualAt + MANUAL_CHECK_COOLDOWN_MS;
          return { cooldown: true, retryAt, remainingMs: retryAt - Date.now() };
        }
      }
      if (automatic) {
        const settings = await readAutoSettings();
        const state = await readAutoState();
        if (!settings.enabled || identity !== expectedIdentity ||
            !bypassEligibility && nextEligibleAt(product, state.unknownSince[asin]) > Date.now()) return { skipped: true };
      }
      product.lastAttemptedCheckAt = new Date().toISOString();
      product.lastCheckStatus = "checking";
      product.lastErrorCode = null;
      inFlightChecks.set(flightKey, true);
      ownsFlight = true;
      try {
        await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
      } catch (error) {
        inFlightChecks.delete(flightKey);
        ownsFlight = false;
        throw error;
      }
      return { canonicalUrl: product.canonicalUrl, identity };
    });
    if (start.missing) return { status: "failure", asin, errorCode: "PRODUCT_NOT_FOUND" };
    if (start.busy) return { status: "busy", asin };
    if (start.skipped) return { status: "skipped", asin };
    if (start.cooldown) return { status: "cooldown", asin,
      retryAt: new Date(start.retryAt).toISOString(), remainingMs: start.remainingMs };

    const responseDiagnostic = {};
    let requestStarted = false;
    const fetched = await fetchProduct(start.canonicalUrl, {
      diagnostic: responseDiagnostic,
      onRequestStart: async () => {
        if (!automatic) {
          try {
            const marked = await withWatchlistLock(async () => {
              const watchlist = await readWatchlist();
              const current = watchlist.products[asin];
              if (!current || productInstances.get(asin) !== start.identity) return false;
              current.lastManualCheckAt = new Date().toISOString();
              await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
              return true;
            });
            if (!marked) return false;
          } catch { throw new Error("STORAGE_ERROR"); }
        }
        requestStarted = true;
        await onRequestStart?.();
        return true;
      }
    });
    const checkedAt = new Date().toISOString();
    return withWatchlistLock(async () => {
      const watchlist = await readWatchlist();
      const product = watchlist.products[asin];
      if (!product || productInstances.get(asin) !== start.identity) {
        return { status: "failure", asin, errorCode: "CHECK_CANCELLED", stale: true };
      }
      product.lastAttemptedCheckAt = checkedAt;
      const previousPrice = product.lastSuccessfulPriceTry;
      if (fetched.status === "success") {
        establishFirstBaseline(product, fetched.priceTry, checkedAt);
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
      if (requestStarted) {
        try {
          await appendDiagnosticHistory(chrome.storage.local,
            completedCheckEntry({ asin, automatic, result: fetched, checkedAt, response: responseDiagnostic }));
        } catch { /* A diagnostic write cannot change the completed price check. */ }
      }
      return {
        ...fetched, asin, checkedAt, product: { ...product },
        ...(automatic && !bypassEligibility && fetched.status === "success" && previousPrice !== null
          ? { notificationTransition: {
              product: { asin, title: product.title, url: product.canonicalUrl },
              previousPrice, newPrice: fetched.priceTry, currency: "TRY",
              addedAt: product.addedAt, checkedAt, identity: start.identity
            } }
          : {})
      };
    });
  }
  catch { return { status: "failure", asin, errorCode: "STORAGE_ERROR" }; }
  finally { if (ownsFlight) inFlightChecks.delete(flightKey); }
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
    productInstance(asin);
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
  return withWatchlistLock(async () => {
    const watchlist = await readWatchlist();
    if (!watchlist.products[asin]) return { status: "failure", errorCode: "PRODUCT_NOT_FOUND" };
    delete watchlist.products[asin];
    await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
    productInstances.delete(asin);
    return { status: "success", asin, watchlist };
  });
}

async function recoverInterruptedChecks() {
  return withWatchlistLock(async () => {
    const watchlist = await readWatchlist();
    let changed = false;
    const interrupted = [];
    for (const product of Object.values(watchlist.products)) {
      if (product.lastCheckStatus !== "checking") continue;
      product.lastCheckStatus = "failure";
      product.lastErrorCode = "CHECK_INTERRUPTED";
      changed = true;
      interrupted.push(product.asin);
    }
    if (changed) await chrome.storage.local.set({ [WATCHLIST_KEY]: watchlist });
    for (const asin of interrupted) recordDeveloperEvent({ type: "check_interrupted", asin, outcome: "failure", errorCode: "CHECK_INTERRUPTED" });
  });
}

async function readAutoSettings() {
  const stored = await chrome.storage.local.get(AUTO_SETTINGS_KEY);
  const original = stored[AUTO_SETTINGS_KEY];
  const settings = normalizeAutoSettings(original);
  if (original?.intervalMinutes === 360) {
    const state = migrateLegacyAutoState(await readAutoState(), Date.now());
    // Migrate once, then let reconciliation replace any obsolete six-hour alarm.
    await chrome.storage.local.set({ [AUTO_SETTINGS_KEY]: settings, [AUTO_STATE_KEY]: state });
  }
  if (original === undefined) await chrome.storage.local.set({ [AUTO_SETTINGS_KEY]: settings });
  return settings;
}

async function readAutoState() {
  const stored = await chrome.storage.local.get(AUTO_STATE_KEY);
  return normalizeAutoState(stored[AUTO_STATE_KEY]);
}

async function saveAutoState(state) {
  await chrome.storage.local.set({ [AUTO_STATE_KEY]: state });
}

function prepareEligibility(watchlist, state, now) {
  for (const asin of Object.keys(state.unknownSince)) {
    if (!watchlist.products[asin]) delete state.unknownSince[asin];
  }
  return Object.values(watchlist.products).map(product => {
    if (timestampMs(product.lastAttemptedCheckAt) !== null || timestampMs(product.addedAt) !== null) {
      delete state.unknownSince[product.asin];
    } else if (!state.unknownSince[product.asin]) {
      state.unknownSince[product.asin] = new Date(now).toISOString();
    }
    return { asin: product.asin, dueAt: nextEligibleAt(product, state.unknownSince[product.asin]) };
  }).sort((left, right) => left.dueAt - right.dueAt || left.asin.localeCompare(right.asin));
}

async function scheduleAutomaticLocked(now = Date.now()) {
  const settings = await readAutoSettings();
  const state = await readAutoState();
  if (!settings.enabled) {
    if (state.nextRunAt !== null) {
      state.nextRunAt = null;
      await saveAutoState(state);
    }
    await chrome.alarms.clear(AUTO_ALARM_NAME);
    return { settings, state };
  }
  if (state.lastErrorCode === "PERMISSION_REQUIRED" &&
      await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
    state.lastErrorCode = null;
    state.notBefore = null;
  }
  const products = prepareEligibility(await readWatchlist(), state, now);
  const earliestDue = products[0]?.dueAt ?? timestampMs(state.nextRunAt) ?? now + AUTO_INTERVAL_MS;
  const rawDue = Math.max(earliestDue, timestampMs(state.notBefore) ?? 0);
  const existing = await chrome.alarms.get(AUTO_ALARM_NAME);
  const previous = timestampMs(state.nextRunAt);
  const deliveredAt = timestampMs(pendingAutomaticAlarm?.scheduledAt);
  const deliveryIsPending = settings.enabled && deliveredAt !== null && previous !== null &&
    Math.abs(previous - deliveredAt) < 1000 && deliveredAt <= now + 1000 &&
    products[0]?.dueAt <= now && (timestampMs(state.notBefore) ?? 0) <= now;
  // Chrome consumes one-shot alarms before waking a cold service worker. Keep
  // the persisted due time intact while that exact delivery is being handled.
  if (deliveryIsPending) {
    await saveAutoState(state);
    return { settings, state };
  }
  const alarmMatchesState = existing && previous !== null && Math.abs(existing.scheduledTime - previous) < 1000;
  const stillAppropriate = previous !== null && previous >= rawDue - 1000 &&
    previous <= Math.max(rawDue, now) + AUTO_PACE_MS + 1000;
  if (alarmMatchesState && stillAppropriate) {
    await saveAutoState(state);
    return { settings, state };
  }
  const when = !existing && stillAppropriate && previous > now
    ? previous
    : Math.max(rawDue, now + AUTO_PACE_MS);
  state.nextRunAt = new Date(when).toISOString();
  await saveAutoState(state);
  await chrome.alarms.create(AUTO_ALARM_NAME, { when });
  recordDeveloperEvent({ type: "automatic_alarm_scheduled", alarmName: AUTO_ALARM_NAME, scheduledAt: new Date(when).toISOString() });
  return { settings, state };
}

function reconcileAutomaticSchedule() {
  return withWatchlistLock(() => scheduleAutomaticLocked());
}

async function notifyAutomaticResult(result) {
  const transition = result.notificationTransition;
  if (!transition) return;
  const accepted = await withWatchlistLock(async () => {
    if (productInstances.get(result.asin) !== transition.identity) return null;
    const watchlist = await readWatchlist();
    return acceptAutomaticPriceTransition({ storage: chrome.storage, transition, watchlist });
  });
  if (accepted) await presentPriceChangeNotification({ chromeApi: chrome, event: accepted });
}

async function getAutoSettings() {
  return withWatchlistLock(async () => {
    const { settings, state } = await scheduleAutomaticLocked();
    return { status: "success", settings, errorCode: state.lastErrorCode };
  });
}

async function setAutoEnabled(enabled) {
  if (typeof enabled !== "boolean") return { status: "failure", errorCode: "INVALID_SETTING" };
  return withWatchlistLock(async () => {
    const settings = { ...await readAutoSettings(), enabled };
    await chrome.storage.local.set({ [AUTO_SETTINGS_KEY]: settings });
    const state = await readAutoState();
    state.nextRunAt = null;
    if (enabled) {
      state.lastErrorCode = null;
      state.notBefore = null;
    }
    await saveAutoState(state);
    await scheduleAutomaticLocked();
    return { status: "success", settings };
  });
}

async function runAutomaticAlarm(deliveredAlarm) {
  if (automaticRun) {
    recordDeveloperEvent({ type: "automatic_check_skipped", outcome: "busy", errorCode: "AUTOMATIC_CHECK_RUNNING", requestStarted: false });
    return;
  }
  automaticRun = (async () => {
    const selected = await withWatchlistLock(async () => {
      const settings = await readAutoSettings();
      const state = await readAutoState();
      if (!settings.enabled) {
        await scheduleAutomaticLocked();
        return null;
      }
      const now = Date.now();
      const scheduledAt = Number.isFinite(deliveredAlarm?.scheduledTime) ? deliveredAlarm.scheduledTime : null;
      const storedScheduledAt = timestampMs(state.nextRunAt);
      if (scheduledAt === null || storedScheduledAt === null ||
          Math.abs(storedScheduledAt - scheduledAt) >= 1000 || now + 1000 < scheduledAt) {
        await scheduleAutomaticLocked(now);
        return null;
      }
      const products = prepareEligibility(await readWatchlist(), state, now);
      if (!products.length) {
        state.notBefore = new Date(now + AUTO_INTERVAL_MS).toISOString();
        state.nextRunAt = null;
        await saveAutoState(state);
        await scheduleAutomaticLocked(now);
        return null;
      }
      if (products[0].dueAt > now) {
        state.nextRunAt = null;
        await saveAutoState(state);
        await scheduleAutomaticLocked(now);
        return null;
      }
      if (!await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
        state.lastErrorCode = "PERMISSION_REQUIRED";
        state.notBefore = new Date(now + AUTO_INTERVAL_MS).toISOString();
        state.nextRunAt = null;
        await saveAutoState(state);
        await scheduleAutomaticLocked(now);
        return null;
      }
      const asin = products[0].asin;
      const identity = productInstance(asin);
      state.lastErrorCode = null;
      state.notBefore = new Date(now + AUTO_PACE_MS).toISOString();
      state.nextRunAt = null;
      await saveAutoState(state);
      await scheduleAutomaticLocked(now);
      return { asin, identity };
    });
    if (!selected) {
      recordDeveloperEvent({ type: "automatic_check_skipped", outcome: "skipped", requestStarted: false });
      return;
    }
    recordDeveloperEvent({ type: "automatic_check_selected", asin: selected.asin, requestStarted: false });
    let requestStarted = false;
    const result = await checkWatchlistProduct(selected.asin, {
      automatic: true, expectedIdentity: selected.identity,
      onRequestStart: () => {
        requestStarted = true;
        recordDeveloperEvent({ type: "automatic_request_started", asin: selected.asin, requestStarted: true });
      }
    });
    recordDeveloperEvent({ type: result.status === "busy" || result.status === "skipped" ? "automatic_check_skipped" : "automatic_check_completed",
      asin: selected.asin, outcome: result.status,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}), requestStarted });
    await reconcileAutomaticSchedule();
    // Presentation is secondary to the committed price and next alarm.
    try { await notifyAutomaticResult(result); } catch { /* Best effort; never retry a claimed event. */ }
  })();
  try { await automaticRun; }
  finally { automaticRun = undefined; }
}

function devDiagnostic(result, asin = null) {
  return {
    asin,
    outcome: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    checkedAt: result.checkedAt || new Date().toISOString()
  };
}

export async function runOneAutomaticCheckForDev() {
  await startupRecovery;
  if (recoveryFailed) return devDiagnostic({ status: "failure", errorCode: "STORAGE_ERROR" });
  if (automaticRun) return devDiagnostic({ status: "busy", errorCode: "AUTOMATIC_CHECK_RUNNING" });

  automaticRun = (async () => {
    const selected = await withWatchlistLock(async () => {
      const settings = await readAutoSettings();
      const state = await readAutoState();
      const now = Date.now();
      if (!settings.enabled) {
        await scheduleAutomaticLocked(now);
        return { diagnostic: devDiagnostic({ status: "skipped", errorCode: "AUTOMATIC_DISABLED" }) };
      }

      const products = prepareEligibility(await readWatchlist(), state, now);
      await saveAutoState(state);
      if (!products.length) {
        await scheduleAutomaticLocked(now);
        return { diagnostic: devDiagnostic({ status: "skipped", errorCode: "NO_PRODUCTS" }) };
      }

      const asin = products[0].asin;
      if (!await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
        state.lastErrorCode = "PERMISSION_REQUIRED";
        state.notBefore = new Date(now + AUTO_INTERVAL_MS).toISOString();
        state.nextRunAt = null;
        await saveAutoState(state);
        await scheduleAutomaticLocked(now);
        return { diagnostic: devDiagnostic({ status: "failure", errorCode: "PERMISSION_REQUIRED" }, asin) };
      }

      return { asin, identity: productInstance(asin) };
    });
    if (selected.diagnostic) return selected.diagnostic;

    const result = await checkWatchlistProduct(selected.asin, {
      automatic: true,
      expectedIdentity: selected.identity,
      bypassEligibility: true
    });
    await withWatchlistLock(async () => {
      const state = await readAutoState();
      state.nextRunAt = null;
      if (result.status !== "busy" && result.status !== "skipped") {
        state.notBefore = new Date(Date.now() + AUTO_INTERVAL_MS).toISOString();
      }
      await saveAutoState(state);
      await scheduleAutomaticLocked();
    });
    return devDiagnostic(result, selected.asin);
  })();

  try { return await automaticRun; }
  catch { return devDiagnostic({ status: "failure", errorCode: "STORAGE_ERROR" }); }
  finally { automaticRun = undefined; }
}

export async function prepareAutomaticAlarmTestForDev() {
  await startupRecovery;
  if (recoveryFailed) return { status: "failure", errorCode: "STORAGE_ERROR" };
  if (automaticRun) return { status: "busy", errorCode: "AUTOMATIC_CHECK_RUNNING" };
  try {
    return withWatchlistLock(async () => {
      const watchlist = await readWatchlist();
      const state = await readAutoState();
      const products = prepareEligibility(watchlist, state, Date.now());
      await saveAutoState(state);
      if (!products.length) return { status: "skipped", errorCode: "NO_PRODUCTS" };

      const product = watchlist.products[products[0].asin];
      const identity = productInstance(product.asin);
      if (inFlightChecks.has(`${product.asin}:${identity}`)) {
        return { status: "busy", asin: product.asin, errorCode: "CHECK_BUSY" };
      }
      return {
        status: "ready",
        asin: product.asin,
        productAddedAt: product.addedAt
      };
    });
  } catch {
    return { status: "failure", errorCode: "STORAGE_ERROR" };
  }
}

export async function runAutomaticAlarmTestForDev({ asin, productAddedAt } = {}) {
  await startupRecovery;
  if (recoveryFailed) return { status: "failure", asin: asin || null, errorCode: "STORAGE_ERROR", requestStarted: false };
  if (automaticRun) return { status: "skipped", asin: asin || null, errorCode: "AUTOMATIC_CHECK_RUNNING", requestStarted: false };

  automaticRun = (async () => {
    let requestStarted = false;
    const selected = await withWatchlistLock(async () => {
      const settings = await readAutoSettings();
      const state = await readAutoState();
      const now = Date.now();
      if (!settings.enabled) {
        await scheduleAutomaticLocked(now);
        return { diagnostic: { status: "skipped", asin: asin || null, errorCode: "AUTOMATIC_DISABLED", requestStarted } };
      }
      if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin) || typeof productAddedAt !== "string") {
        return { diagnostic: { status: "skipped", asin: asin || null, errorCode: "INVALID_TEST_TARGET", requestStarted } };
      }

      const watchlist = await readWatchlist();
      const product = watchlist.products[asin];
      if (!product) return { diagnostic: { status: "skipped", asin, errorCode: "PRODUCT_NOT_FOUND", requestStarted } };
      if (product.addedAt !== productAddedAt) {
        return { diagnostic: { status: "skipped", asin, errorCode: "PRODUCT_INSTANCE_CHANGED", requestStarted } };
      }

      const identity = productInstance(asin);
      if (inFlightChecks.has(`${asin}:${identity}`)) {
        return { diagnostic: { status: "skipped", asin, errorCode: "CHECK_BUSY", requestStarted } };
      }
      if (!await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
        state.lastErrorCode = "PERMISSION_REQUIRED";
        state.notBefore = new Date(now + AUTO_INTERVAL_MS).toISOString();
        state.nextRunAt = null;
        await saveAutoState(state);
        await scheduleAutomaticLocked(now);
        return { diagnostic: { status: "failure", asin, errorCode: "PERMISSION_REQUIRED", requestStarted } };
      }

      state.lastErrorCode = null;
      state.notBefore = new Date(now + AUTO_PACE_MS).toISOString();
      state.nextRunAt = null;
      await saveAutoState(state);
      await scheduleAutomaticLocked(now);
      return { asin, identity };
    });
    if (selected.diagnostic) return selected.diagnostic;

    const result = await checkWatchlistProduct(selected.asin, {
      automatic: true,
      expectedIdentity: selected.identity,
      bypassEligibility: true,
      onRequestStart: () => { requestStarted = true; }
    });
    await reconcileAutomaticSchedule();
    if (result.status === "busy" || result.status === "skipped") {
      return {
        status: "skipped",
        asin: selected.asin,
        errorCode: result.status === "busy" ? "CHECK_BUSY" : result.errorCode || "CHECK_SKIPPED",
        requestStarted
      };
    }
    return {
      status: result.status,
      asin: selected.asin,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.checkedAt ? { checkedAt: result.checkedAt } : {}),
      requestStarted
    };
  })();

  try { return await automaticRun; }
  catch { return { status: "failure", asin: asin || null, errorCode: "STORAGE_ERROR", requestStarted: false }; }
  finally { automaticRun = undefined; }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== AUTO_ALARM_NAME) return;
  pendingAutomaticAlarm = Number.isFinite(alarm.scheduledTime) ? { scheduledAt: new Date(alarm.scheduledTime).toISOString() } : undefined;
  recordDeveloperEvent({ type: "automatic_alarm_delivered", alarmName: AUTO_ALARM_NAME,
    ...(Number.isFinite(alarm.scheduledTime) ? { scheduledAt: new Date(alarm.scheduledTime).toISOString() } : {}) });
  const delivery = pendingAutomaticAlarm;
  return startupRecovery.then(() => { if (!recoveryFailed) return runAutomaticAlarm(alarm); }).catch(() => {})
    .finally(async () => {
      if (pendingAutomaticAlarm === delivery) pendingAutomaticAlarm = undefined;
      if (!recoveryFailed && !automaticRun) {
        try { await reconcileAutomaticSchedule(); } catch { /* A later recovery event can restore the alarm. */ }
      }
    });
});

chrome.runtime.onInstalled.addListener(() => {
  return startupRecovery.then(() => { if (!recoveryFailed) return reconcileAutomaticSchedule(); }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  return startupRecovery.then(() => { if (!recoveryFailed) return reconcileAutomaticSchedule(); }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  let runOperation;
  if (message?.type === "CHECK_PRICE") runOperation = () => probe(message.url);
  else if (message?.type === "GET_WATCHLIST") runOperation = () => getWatchlist();
  else if (message?.type === "ADD_PRODUCT") runOperation = () => addProduct(message.url);
  else if (message?.type === "CHECK_PRODUCT") runOperation = () => checkWatchlistProduct(message.asin);
  else if (message?.type === "REMOVE_PRODUCT") runOperation = () => removeProduct(message.asin);
  else if (message?.type === "GET_AUTO_SETTINGS") runOperation = () => getAutoSettings();
  else if (message?.type === "SET_AUTO_ENABLED") runOperation = () => setAutoEnabled(message.enabled);
  else return;
  startupRecovery
    .then(() => recoveryFailed ? { status: "failure", errorCode: "STORAGE_ERROR" } : runOperation())
    .then(async result => {
      if (["ADD_PRODUCT", "CHECK_PRODUCT", "REMOVE_PRODUCT"].includes(message.type) &&
          result?.status !== "failure" && result?.status !== "cooldown") {
        try { await reconcileAutomaticSchedule(); } catch { /* The completed user action remains valid. */ }
      }
      return result;
    })
    .then(sendResponse)
    .catch(() => sendResponse({ status: "failure", errorCode: "STORAGE_ERROR" }));
  return true;
});

// Register all wake-up handlers before startup recovery can reconcile state.
// If a consumed one-shot alarm is delivered during this worker's cold start,
// its synchronous listener records the delivery before reconciliation runs.
startupRecovery = recoverInterruptedChecks().catch(() => { recoveryFailed = true; });
startupRecovery.then(() => { if (!recoveryFailed) return reconcileAutomaticSchedule(); }).catch(() => {});
