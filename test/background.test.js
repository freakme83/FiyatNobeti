import test from "node:test";
import assert from "node:assert/strict";
import { createProductRow, errorMessage } from "../src/watchlist-view.js";
import { createProductRecord, normalizeProductTitle } from "../src/watchlist.js";
import { AUTO_ALARM_NAME, AUTO_INTERVAL_MS, AUTO_PACE_MS } from "../src/automatic.js";

const previous = {
  asin: "B0FZ9Y4GPF",
  canonicalUrl: "https://www.amazon.com.tr/dp/B0FZ9Y4GPF",
  checkedAt: "2026-10-21T10:00:00.000Z",
  status: "success",
  priceTry: 36399
};
const stored = { lastSuccess: previous };
let listener;
let permission = true;
let fetchResult;
let fetched;
let fetchHandler;
let parseHandler;
let permissionChecks = [];
let alarmListener;
let installedListener;
let startupListener;
const alarms = new Map();
const alarmCreations = [];
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    onMessage: { addListener(fn) { listener = fn; } },
    onInstalled: { addListener(fn) { installedListener = fn; } },
    onStartup: { addListener(fn) { startupListener = fn; } },
    async sendMessage(message) {
      assert.ok(["PARSE_HTML", "PARSE_HTML_DIAG"].includes(message.type));
      assert.match(message.html, /corePrice_feature_div/);
      if (parseHandler) return parseHandler(message.html, message.type);
      return { status: "success", priceTry: 36000 };
    }
  },
  permissions: { async contains({ origins }) {
    permissionChecks.push(...origins);
    return permission && !origins.some(origin => deniedOrigins.has(origin));
  } },
  alarms: {
    onAlarm: { addListener(fn) { alarmListener = fn; } },
    async get(name) { return alarms.get(name); },
    async create(name, info) {
      alarms.set(name, { name, scheduledTime: info.when });
      alarmCreations.push({ name, ...info });
    },
    async clear(name) { return alarms.delete(name); }
  },
  offscreen: {
    async hasDocument() { return true; },
    async createDocument() { throw new Error("unexpected"); }
  },
  storage: { local: {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map(key => [key, stored[key]]));
    },
    async set(value) { Object.assign(stored, value); }
  } }
};
const deniedOrigins = new Set();
globalThis.fetch = async (url, options) => {
  fetched = { url, options };
  if (fetchHandler) return fetchHandler(url, options);
  return fetchResult;
};
const {
  diagnoseProductForDev,
  prepareAutomaticAlarmTestForDev,
  runAutomaticAlarmTestForDev,
  runOneAutomaticCheckForDev,
  setDeveloperEventRecorderForDev
} = await import("../background.js");
assert.equal(globalThis.fiyatNobetiDev, undefined);
const productionListeners = { listener, alarmListener, installedListener, startupListener };

function useProductionBackground() {
  ({ listener, alarmListener, installedListener, startupListener } = productionListeners);
}

function enableDeveloperTestApi() {
  if (globalThis.fiyatNobetiDev) return;
  Object.defineProperty(globalThis, "fiyatNobetiDev", {
    value: Object.freeze({ runOneAutomaticCheck: runOneAutomaticCheckForDev }),
    enumerable: true,
    configurable: false,
    writable: false
  });
}

async function check(url = previous.canonicalUrl) {
  return new Promise(resolve => {
    assert.equal(listener({ type: "CHECK_PRICE", url }, { id: "test-extension" }, resolve), true);
  });
}

function message(type, fields = {}) {
  return new Promise(resolve => {
    assert.equal(listener({ type, ...fields }, { id: "test-extension" }, resolve), true);
  });
}

const productUrl = asin => `https://www.amazon.com.tr/dp/${asin}`;
const deferred = () => {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
};
const htmlResponse = (asin = "B0FZ9Y4GPF") => new Response(`<div id="corePrice_feature_div">${asin}</div>`, {
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8" }
});
const resetWatchlist = async () => {
  stored.watchlist = { version: 1, products: {} };
  stored.automaticChecks = { version: 1, enabled: true, intervalMinutes: 360 };
  stored.automaticCheckState = { version: 1, nextRunAt: null, notBefore: null, unknownSince: {}, lastErrorCode: null };
  alarms.clear();
  alarmCreations.length = 0;
  fetchHandler = async () => htmlResponse();
  parseHandler = null;
  permission = true;
  deniedOrigins.clear();
};

async function fireAutomaticAlarm() {
  const alarm = alarms.get(AUTO_ALARM_NAME);
  assert.ok(alarm, "automatic alarm must exist");
  alarms.delete(AUTO_ALARM_NAME);
  await alarmListener(alarm);
}

async function withClock(start, task) {
  const RealDate = globalThis.Date;
  let now = Date.parse(start);
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try { return await task({ advance(ms) { now += ms; }, get now() { return now; } }); }
  finally { globalThis.Date = RealDate; }
}

function seedProduct(asin, { attemptedAt = null, addedAt = "2026-10-20T00:00:00.000Z", status = "never" } = {}) {
  const product = createProductRecord({ asin, canonicalUrl: productUrl(asin), addedAt });
  product.lastAttemptedCheckAt = attemptedAt;
  product.lastCheckStatus = status;
  stored.watchlist.products[asin] = product;
  return product;
}

function advanceToAlarm(clock) {
  const alarm = alarms.get(AUTO_ALARM_NAME);
  assert.ok(alarm);
  clock.advance(Math.max(0, alarm.scheduledTime - clock.now));
}

test("background fetch is canonical, manual, credential-free and stores success", async () => {
  fetchResult = new Response('<div id="corePrice_feature_div"></div>', {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" }
  });
  const result = await check(previous.canonicalUrl + "?tag=tracking");
  assert.equal(fetched.url, previous.canonicalUrl);
  assert.equal(fetched.options.credentials, "omit");
  assert.equal(fetched.options.redirect, "manual");
  assert.equal(result.priceTry, 36000);
  assert.equal(stored.lastCheck.status, "success");
  assert.deepEqual(stored.lastSuccess, result);
  assert.equal("html" in stored.lastCheck, false);
});

test("failed HTTP response records a failure but preserves the earlier valid price", async () => {
  stored.lastSuccess = previous;
  fetchResult = new Response("Denied", { status: 503, headers: { "content-type": "text/html" } });
  const result = await check();
  assert.equal(result.errorCode, "HTTP_ERROR");
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(stored.lastSuccess, previous);
  assert.deepEqual(stored.lastCheck, result);
});

test("missing permission is saved and never triggers a fetch", async () => {
  permission = false;
  fetched = undefined;
  const result = await check();
  assert.equal(result.errorCode, "PERMISSION_REQUIRED");
  assert.equal(fetched, undefined);
  assert.deepEqual(stored.lastSuccess, previous);
});

test("short links request short-host access only on short-link checks", async () => {
  permission = true;
  deniedOrigins.clear();
  permissionChecks = [];
  fetchHandler = async () => { throw new Error("network should not be reached"); };
  const normal = await check(previous.canonicalUrl);
  assert.equal(normal.status, "failure");
  assert.deepEqual(permissionChecks, ["https://www.amazon.com.tr/*"]);

  permissionChecks = [];
  deniedOrigins.add("https://amzn.eu/*");
  const short = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(short.errorCode, "SHORT_LINK_PERMISSION_REQUIRED");
  assert.deepEqual(permissionChecks, ["https://amzn.eu/*"]);
  assert.deepEqual(stored.lastSuccess, previous);
  assert.equal(stored.lastCheck.inputUrl, "https://amzn.eu/d/02JpD8hn");
});

test("short-link network failure stores a safe diagnostic and preserves the last valid price", async () => {
  permission = true;
  deniedOrigins.clear();
  stored.lastSuccess = previous;
  fetchHandler = async () => { throw new Error("private raw network details"); };
  const result = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(result.errorCode, "SHORT_LINK_NETWORK_ERROR");
  assert.equal(result.diagnostics, undefined);
  assert.equal(result.checkedAt, stored.lastCheck.checkedAt);
  assert.equal(JSON.stringify(result).includes("private raw network details"), false);
  assert.deepEqual(stored.lastSuccess, previous);
  assert.equal(stored.lastCheck.inputUrl, "https://amzn.eu/d/02JpD8hn");
});

test("short links follow automatically, then use the existing manual canonical price fetch", async () => {
  permission = true;
  deniedOrigins.clear();
  stored.lastSuccess = previous;
  const calls = [];
  fetchHandler = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://amzn.eu/d/02JpD8hn") {
      return { url: "https://www.amazon.com.tr/Soundcore-Kulakl%C4%B1k/dp/B0CQXKXBR7?ref_=share", status: 200, ok: true, type: "basic" };
    }
    return new Response('<div id="corePrice_feature_div"></div>', {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" }
    });
  };

  const result = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(result.status, "success");
  assert.equal(result.asin, "B0CQXKXBR7");
  assert.equal(result.canonicalUrl, "https://www.amazon.com.tr/dp/B0CQXKXBR7");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "follow");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[1].url, result.canonicalUrl);
  assert.equal(calls[1].options.redirect, "manual");
  assert.deepEqual(stored.lastSuccess, result);
});

test("an unsafe final short-link URL records a failure and preserves the previous successful price", async () => {
  permission = true;
  deniedOrigins.clear();
  stored.lastSuccess = previous;
  let calls = 0;
  fetchHandler = async () => {
    calls++;
    return { url: "https://unrelated.example/dp/B0CQXKXBR7", status: 200, ok: true, type: "basic" };
  };
  const result = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(result.errorCode, "SHORT_LINK_UNSAFE_REDIRECT");
  assert.deepEqual(result.diagnostics, { httpStatus: 200, responseType: "basic" });
  assert.equal(calls, 1);
  assert.deepEqual(stored.lastSuccess, previous);
  assert.equal(stored.lastCheck.inputUrl, "https://amzn.eu/d/02JpD8hn");
});

test("opaque short-link redirect details reach local diagnostics without changing last success", async () => {
  permission = true;
  deniedOrigins.clear();
  stored.lastSuccess = previous;
  fetchHandler = async () => ({ status: 0, type: "opaqueredirect", headers: new Headers() });
  const result = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(result.errorCode, "SHORT_LINK_OPAQUE_REDIRECT");
  assert.deepEqual(result.diagnostics, {
    responseType: "opaqueredirect"
  });
  assert.ok(result.checkedAt);
  assert.deepEqual(stored.lastSuccess, previous);
  assert.deepEqual(stored.lastCheck, result);
});

test("after safe resolution, missing Amazon Türkiye permission prevents the price fetch", async () => {
  permission = true;
  deniedOrigins.clear();
  deniedOrigins.add("https://www.amazon.com.tr/*");
  let networkRequests = [];
  fetchHandler = async (url, options) => {
    networkRequests.push(url);
    return { url: "https://www.amazon.com.tr/dp/B0CQXKXBR7", status: 200, ok: true, type: "basic" };
  };
  const result = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(result.errorCode, "PERMISSION_REQUIRED");
  assert.deepEqual(networkRequests, ["https://amzn.eu/d/02JpD8hn"]);
  assert.equal(fetched.options.redirect, "follow");
  assert.deepEqual(stored.lastSuccess, previous);
});

test("adds a new product, runs an initial check, and persists the versioned watchlist", async () => {
  await resetWatchlist();
  parseHandler = async () => ({ status: "success", priceTry: 1298, title: "Oral-B 3D White Fırça Başlığı" });
  const result = await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  assert.equal(result.status, "added");
  const item = result.watchlist.products.B0D47HCRZ6;
  assert.equal(result.check.status, "success");
  assert.equal(item.canonicalUrl, productUrl("B0D47HCRZ6"));
  assert.equal(item.title, "Oral-B 3D White Fırça Başlığı");
  assert.equal(item.lastSuccessfulPriceTry, 1298);
  assert.ok(item.lastSuccessfulCheckAt);
  assert.ok(item.lastAttemptedCheckAt);
  assert.ok(item.addedAt);
  assert.equal(result.watchlist.version, 1);
  assert.deepEqual((await message("GET_WATCHLIST")).watchlist, stored.watchlist);
});

test("direct ASIN input uses the existing add flow and deduplicates against its canonical URL", async () => {
  await resetWatchlist();
  let requests = 0;
  fetchHandler = async (url, options) => {
    requests++;
    assert.equal(url, productUrl("B0CKXJBQ6L"));
    return htmlResponse("B0CKXJBQ6L");
  };
  parseHandler = async () => ({ status: "success", priceTry: 2999, title: "SoundPEATS" });
  const added = await message("ADD_PRODUCT", { url: " b0ckxjbq6l " });
  assert.equal(added.status, "added");
  assert.equal(added.asin, "B0CKXJBQ6L");
  assert.equal(added.watchlist.products.B0CKXJBQ6L.canonicalUrl, productUrl("B0CKXJBQ6L"));
  assert.equal(requests, 1);

  const duplicate = await message("ADD_PRODUCT", { url: productUrl("B0CKXJBQ6L") });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(requests, 1);

  const invalid = await message("ADD_PRODUCT", { url: "product B0CKXJBQ6L" });
  assert.equal(invalid.status, "failure");
  assert.equal(requests, 1);
  assert.equal(Object.keys(stored.watchlist.products).length, 1);
});

test("adds a product from an existing amzn.eu short-link flow", async () => {
  await resetWatchlist();
  const calls = [];
  fetchHandler = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://amzn.eu/d/02JpD8hn") {
      return { url: productUrl("B0CQXKXBR7"), status: 200, ok: true, type: "basic" };
    }
    return htmlResponse("B0CQXKXBR7");
  };
  parseHandler = async () => ({ status: "success", priceTry: 2500, title: "Soundcore" });
  const result = await message("ADD_PRODUCT", { url: "https://amzn.eu/d/02JpD8hn" });
  assert.equal(result.status, "added");
  assert.equal(result.asin, "B0CQXKXBR7");
  assert.equal(result.watchlist.products.B0CQXKXBR7.lastSuccessfulPriceTry, 2500);
  assert.equal(calls[0].options.redirect, "follow");
  assert.equal(calls[1].url, productUrl("B0CQXKXBR7"));
});

test("keeps a new product saved when its initial price check fails", async () => {
  await resetWatchlist();
  fetchHandler = async () => new Response("Denied", { status: 503, headers: { "content-type": "text/html" } });
  const result = await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  assert.equal(result.status, "added");
  assert.equal(result.check.errorCode, "HTTP_ERROR");
  assert.equal(result.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, null);
  assert.equal(result.watchlist.products.B0D47HCRZ6.lastCheckStatus, "failure");
});

test("rejects duplicate ASIN entries without replacing the saved product", async () => {
  await resetWatchlist();
  const first = await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  const saved = first.watchlist.products.B0D47HCRZ6;
  let requests = 0;
  fetchHandler = async () => { requests++; return htmlResponse("B0D47HCRZ6"); };
  const duplicate = await message("ADD_PRODUCT", { url: "https://www.amazon.com.tr/Oral-B/dp/b0d47hcrz6?ref_=share" });
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate.product, saved);
  assert.equal(requests, 0);
  assert.equal(Object.keys(stored.watchlist.products).length, 1);
});

test("removes only the selected product and preserves other records", async () => {
  await resetWatchlist();
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  await message("ADD_PRODUCT", { url: productUrl("B0CQXKXBR7") });
  const removed = await message("REMOVE_PRODUCT", { asin: "B0D47HCRZ6" });
  assert.equal(removed.status, "success");
  assert.equal("B0D47HCRZ6" in removed.watchlist.products, false);
  assert.equal("B0CQXKXBR7" in removed.watchlist.products, true);
});

test("failed manual checks preserve the previous successful price and title", async () => {
  await resetWatchlist();
  parseHandler = async () => ({ status: "success", priceTry: 1298, title: "Saved title" });
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  const before = stored.watchlist.products.B0D47HCRZ6;
  fetchHandler = async () => new Response("Denied", { status: 503, headers: { "content-type": "text/html" } });
  const failed = await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
  const after = stored.watchlist.products.B0D47HCRZ6;
  assert.equal(failed.status, "failure");
  assert.equal(after.lastSuccessfulPriceTry, before.lastSuccessfulPriceTry);
  assert.equal(after.lastSuccessfulCheckAt, before.lastSuccessfulCheckAt);
  assert.equal(after.title, "Saved title");
  assert.equal(after.lastCheckStatus, "failure");
  assert.equal(after.lastErrorCode, "HTTP_ERROR");
  assert.ok(after.lastAttemptedCheckAt);
});

test("concurrent updates for different products preserve both results", async () => {
  await resetWatchlist();
  parseHandler = async () => ({ status: "success", priceTry: 100, title: null });
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  await message("ADD_PRODUCT", { url: productUrl("B0CQXKXBR7") });
  const gates = new Map();
  const started = new Map();
  fetchHandler = async url => {
    const asin = url.split("/").at(-1);
    started.get(asin)?.();
    return htmlResponse(asin);
  };
  const promises = new Map();
  for (const asin of ["B0D47HCRZ6", "B0CQXKXBR7"]) {
    promises.set(asin, new Promise(resolve => { started.set(asin, resolve); }));
    gates.set(asin, {});
    gates.get(asin).promise = new Promise(resolve => { gates.get(asin).resolve = resolve; });
  }
  parseHandler = async html => {
    const asin = /B0[A-Z0-9]{8}/.exec(html)?.[0];
    return gates.get(asin).promise;
  };
  const first = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
  const second = message("CHECK_PRODUCT", { asin: "B0CQXKXBR7" });
  await Promise.all(promises.values());
  gates.get("B0D47HCRZ6").resolve({ status: "success", priceTry: 111, title: "A" });
  gates.get("B0CQXKXBR7").resolve({ status: "success", priceTry: 222, title: "B" });
  await Promise.all([first, second]);
  assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 111);
  assert.equal(stored.watchlist.products.B0CQXKXBR7.lastSuccessfulPriceTry, 222);
});

test("prevents duplicate simultaneous checks for the same ASIN", async () => {
  await resetWatchlist();
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  let started;
  const fetchStarted = new Promise(resolve => { started = resolve; });
  let completeParse;
  const parsed = new Promise(resolve => { completeParse = resolve; });
  let requests = 0;
  fetchHandler = async () => { requests++; started(); return htmlResponse("B0D47HCRZ6"); };
  parseHandler = () => parsed;
  const first = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
  await fetchStarted;
  const second = await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
  assert.equal(second.status, "busy");
  assert.equal((await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" })).status, "busy");
  assert.equal(requests, 1);
  completeParse({ status: "success", priceTry: 1500, title: null });
  await first;
});

test("remove and re-add creates an independent check instance while discarding the old result", async () => {
  await resetWatchlist();
  parseHandler = async () => ({ status: "success", priceTry: 100, title: "Old title" });
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  const oldParse = deferred();
  const newParse = deferred();
  const oldStarted = deferred();
  const newStarted = deferred();
  const parseCalls = [{ ...oldParse, started: oldStarted }, { ...newParse, started: newStarted }];
  fetchHandler = async () => htmlResponse("B0D47HCRZ6");
  parseHandler = () => {
    const next = parseCalls.shift();
    next.started.resolve();
    return next.promise;
  };

  const oldCheck = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
  await oldStarted.promise;
  await message("REMOVE_PRODUCT", { asin: "B0D47HCRZ6" });
  const readd = message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  await newStarted.promise;
  assert.equal((await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" })).status, "busy");

  oldParse.resolve({ status: "success", priceTry: 999, title: "Stale title" });
  const oldResult = await oldCheck;
  assert.equal(oldResult.status, "failure");
  assert.equal(oldResult.errorCode, "CHECK_CANCELLED");
  assert.equal(stored.watchlist.products.B0D47HCRZ6.lastCheckStatus, "checking");
  assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, null);
  assert.notEqual(stored.watchlist.products.B0D47HCRZ6.title, "Stale title");
  assert.equal((await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" })).status, "busy");

  newParse.resolve({ status: "success", priceTry: 888, title: "New title" });
  const added = await readd;
  assert.equal(added.check.status, "success");
  assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 888);
  assert.equal(stored.watchlist.products.B0D47HCRZ6.title, "New title");
});

test("a restarted service worker recovers orphaned checks and preserves successful data", async () => {
  await resetWatchlist();
  parseHandler = async () => ({ status: "success", priceTry: 777, title: "Saved title" });
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  const product = stored.watchlist.products.B0D47HCRZ6;
  product.lastSuccessfulPriceTry = 777;
  product.lastSuccessfulCheckAt = "2026-10-20T12:00:00.000Z";
  product.lastAttemptedCheckAt = "2026-10-21T12:00:00.000Z";
  product.lastCheckStatus = "checking";
  product.lastErrorCode = null;

  await import("../background.js?service-worker-restart");
  const recovered = (await message("GET_WATCHLIST")).watchlist.products.B0D47HCRZ6;
  assert.equal(recovered.lastCheckStatus, "failure");
  assert.equal(recovered.lastErrorCode, "CHECK_INTERRUPTED");
  assert.equal(recovered.lastSuccessfulPriceTry, 777);
  assert.equal(recovered.lastSuccessfulCheckAt, "2026-10-20T12:00:00.000Z");
  assert.equal(recovered.lastAttemptedCheckAt, "2026-10-21T12:00:00.000Z");
  assert.equal(recovered.title, "Saved title");
  assert.equal(recovered.asin, "B0D47HCRZ6");

  parseHandler = async () => ({ status: "success", priceTry: 778, title: null });
  assert.equal((await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" })).status, "success");
  assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 778);
});

test("watchlist reads do not interrupt a genuinely active check", async () => {
  await resetWatchlist();
  await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
  const parsed = deferred();
  const started = deferred();
  fetchHandler = async () => { started.resolve(); return htmlResponse("B0D47HCRZ6"); };
  parseHandler = () => parsed.promise;

  const checkPromise = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
  await started.promise;
  const duringCheck = (await message("GET_WATCHLIST")).watchlist.products.B0D47HCRZ6;
  assert.equal(duringCheck.lastCheckStatus, "checking");
  assert.notEqual(duringCheck.lastErrorCode, "CHECK_INTERRUPTED");

  parsed.resolve({ status: "success", priceTry: 400, title: null });
  assert.equal((await checkPromise).status, "success");
});

test("watchlist rendering treats untrusted titles as plain text", () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
  }
  const doc = { createElement: tagName => new Element(tagName) };
  const untrustedTitle = '<img src=x onerror="alert(1)"> & "product"';
  const row = createProductRow(doc, {
    asin: "B0D47HCRZ6", title: untrustedTitle, addedAt: "2026-10-21T00:00:00Z",
    lastSuccessfulPriceTry: null, lastSuccessfulCheckAt: null,
    lastAttemptedCheckAt: null, lastCheckStatus: "never", lastErrorCode: null
  });
  assert.equal(row.children[0].textContent, untrustedTitle);
  assert.equal(row.children[0].children.length, 0);
  assert.equal(normalizeProductTitle(`  ${untrustedTitle}  `), untrustedTitle);
  assert.match(errorMessage("CHECK_INTERRUPTED"), /yeniden başladığı için kesildi/);
});

test("automatic checks default to six hours and restore only a missing owned alarm", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    delete stored.automaticChecks;
    await installedListener();
    const settings = await message("GET_AUTO_SETTINGS");
    assert.deepEqual(settings.settings, { version: 1, enabled: true, intervalMinutes: 360 });
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
    const count = alarmCreations.length;
    await installedListener();
    assert.equal(alarmCreations.length, count);
    alarms.delete(AUTO_ALARM_NAME);
    await installedListener();
    assert.equal(alarmCreations.length, count + 1);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("disabling clears only the automatic alarm while manual checks still work", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async () => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6");
    alarms.set("unrelated-alarm", { name: "unrelated-alarm", scheduledTime: 1 });
    await installedListener();
    assert.equal((await message("SET_AUTO_ENABLED", { enabled: false })).settings.enabled, false);
    assert.equal(alarms.has(AUTO_ALARM_NAME), false);
    assert.equal(alarms.has("unrelated-alarm"), true);
    await alarmListener({ name: AUTO_ALARM_NAME });
    assert.equal(alarms.has(AUTO_ALARM_NAME), false);
    const manual = await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
    assert.equal(manual.status, "success");
    assert.equal((await message("SET_AUTO_ENABLED", { enabled: true })).settings.enabled, true);
    assert.equal(alarms.has(AUTO_ALARM_NAME), true);
  });
});

test("addition and manual refresh delay automatic eligibility for six elapsed hours", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    let requests = 0;
    fetchHandler = async () => { requests++; return htmlResponse("B0D47HCRZ6"); };
    await message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
    assert.equal(requests, 1);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
    clock.advance(AUTO_INTERVAL_MS - 60 * 1000);
    await message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
    assert.equal(requests, 2);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
    await alarmListener({ name: AUTO_ALARM_NAME, scheduledTime: clock.now });
    assert.equal(requests, 2);
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.equal(requests, 3);
  });
});

test("failed automatic checks also defer retry by six hours", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T06:00:00.000Z" });
    fetchHandler = async () => new Response("Denied", { status: 503, headers: { "content-type": "text/html" } });
    await installedListener();
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastErrorCode, "HTTP_ERROR");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt, new Date(clock.now).toISOString());
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("overdue products run one per alarm with durable pacing and no overlapping auto fetches", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0CQXKXBR7", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    const firstStarted = deferred();
    const firstFinished = deferred();
    const urls = [];
    fetchHandler = async url => {
      urls.push(url);
      if (urls.length === 1) {
        firstStarted.resolve();
        await firstFinished.promise;
      }
      return htmlResponse(url.split("/").at(-1));
    };
    await installedListener();
    advanceToAlarm(clock);
    const first = fireAutomaticAlarm();
    await firstStarted.promise;
    assert.equal(urls.length, 1);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_PACE_MS);
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.equal(urls.length, 1);
    firstFinished.resolve();
    await first;
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.deepEqual(urls, [productUrl("B0CQXKXBR7"), productUrl("B0D47HCRZ6")]);
    assert.equal(stored.watchlist.products.B0CQXKXBR7.lastCheckStatus, "success");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastCheckStatus, "success");
  });
});

test("an active manual check prevents a duplicate automatic request", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    await installedListener();
    const parsing = deferred();
    const started = deferred();
    let requests = 0;
    fetchHandler = async () => { requests++; started.resolve(); return htmlResponse("B0D47HCRZ6"); };
    parseHandler = () => parsing.promise;
    const manual = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
    await started.promise;
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.equal(requests, 1);
    parsing.resolve({ status: "success", priceTry: 555, title: null });
    await manual;
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("missing Amazon permission causes no automatic fetch and a bounded retry", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    await installedListener();
    permission = false;
    let requests = 0;
    fetchHandler = async () => { requests++; return htmlResponse(); };
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.equal(requests, 0);
    assert.equal((await message("GET_AUTO_SETTINGS")).errorCode, "PERMISSION_REQUIRED");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt, "2026-10-20T06:00:00.000Z");
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
    permission = true;
    assert.equal((await message("GET_AUTO_SETTINGS")).errorCode, null);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_PACE_MS);
  });
});

test("removing an overdue product during a scan prevents its later request", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0CQXKXBR7", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    const started = deferred();
    const finished = deferred();
    const requests = [];
    fetchHandler = async url => {
      requests.push(url);
      started.resolve();
      await finished.promise;
      return htmlResponse(url.split("/").at(-1));
    };
    await installedListener();
    advanceToAlarm(clock);
    const scan = fireAutomaticAlarm();
    await started.promise;
    await message("REMOVE_PRODUCT", { asin: "B0D47HCRZ6" });
    finished.resolve();
    await scan;
    advanceToAlarm(clock);
    await fireAutomaticAlarm();
    assert.deepEqual(requests, [productUrl("B0CQXKXBR7"), productUrl("B0CQXKXBR7")]);
    assert.equal(stored.watchlist.products.B0D47HCRZ6, undefined);
  });
});

test("disabling during an active automatic check stops later scheduled requests", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0CQXKXBR7", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T06:00:00.000Z" });
    const started = deferred();
    const finished = deferred();
    let requests = 0;
    fetchHandler = async () => { requests++; started.resolve(); await finished.promise; return htmlResponse(); };
    await installedListener();
    advanceToAlarm(clock);
    const scan = fireAutomaticAlarm();
    await started.promise;
    await message("SET_AUTO_ENABLED", { enabled: false });
    assert.equal(alarms.has(AUTO_ALARM_NAME), false);
    finished.resolve();
    await scan;
    await alarmListener({ name: AUTO_ALARM_NAME });
    assert.equal(requests, 1);
    assert.equal(alarms.has(AUTO_ALARM_NAME), false);
  });
});

test("restart recovers a checking product and waits for its six-hour eligibility", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    const product = seedProduct("B0D47HCRZ6", {
      attemptedAt: "2026-10-21T11:59:00.000Z", status: "checking"
    });
    product.lastSuccessfulPriceTry = 123;
    product.lastSuccessfulCheckAt = "2026-10-20T10:00:00.000Z";
    await import("../background.js?automatic-service-worker-restart");
    await message("GET_AUTO_SETTINGS");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastErrorCode, "CHECK_INTERRUPTED");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 123);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, Date.parse("2026-10-21T17:59:00.000Z"));
    assert.ok(alarms.get(AUTO_ALARM_NAME).scheduledTime > clock.now);
  });
});

test("malformed timestamps receive a persistent cooldown across a worker restart", async () => {
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "invalid", addedAt: "invalid" });
    await installedListener();
    const firstDue = alarms.get(AUTO_ALARM_NAME).scheduledTime;
    assert.equal(firstDue, clock.now + AUTO_INTERVAL_MS);
    const since = stored.automaticCheckState.unknownSince.B0D47HCRZ6;
    clock.advance(1000);
    await import("../background.js?automatic-malformed-restart");
    await message("GET_AUTO_SETTINGS");
    assert.equal(stored.automaticCheckState.unknownSince.B0D47HCRZ6, since);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, firstDue);
  });
});

test("developer trigger bypasses eligibility for one product and resumes the six-hour schedule", async () => {
  useProductionBackground();
  enableDeveloperTestApi();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0CQXKXBR7", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const requests = [];
    fetchHandler = async (url, options) => {
      requests.push({ url, options });
      return htmlResponse(url.split("/").at(-1));
    };
    parseHandler = async () => ({ status: "success", priceTry: 321, title: "Test ürünü" });

    const result = await globalThis.fiyatNobetiDev.runOneAutomaticCheck();

    assert.deepEqual(result, {
      asin: "B0CQXKXBR7",
      outcome: "success",
      checkedAt: new Date(clock.now).toISOString()
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, productUrl("B0CQXKXBR7"));
    assert.equal(requests[0].options.credentials, "omit");
    assert.equal(requests[0].options.cache, "no-store");
    assert.equal(stored.watchlist.products.B0CQXKXBR7.lastSuccessfulPriceTry, 321);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt, "2026-10-21T11:59:00.000Z");
    assert.equal(stored.automaticChecks.intervalMinutes, 360);
    assert.equal(AUTO_INTERVAL_MS, 6 * 60 * 60 * 1000);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
    await alarmListener({ name: AUTO_ALARM_NAME, scheduledTime: clock.now });
    assert.equal(requests.length, 1);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("developer trigger never overlaps an existing automatic developer run", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const parsing = deferred();
    const started = deferred();
    let requests = 0;
    fetchHandler = async () => { requests++; started.resolve(); return htmlResponse("B0D47HCRZ6"); };
    parseHandler = () => parsing.promise;

    const first = globalThis.fiyatNobetiDev.runOneAutomaticCheck();
    await started.promise;
    const duplicate = await globalThis.fiyatNobetiDev.runOneAutomaticCheck();
    assert.equal(duplicate.outcome, "busy");
    assert.equal(duplicate.errorCode, "AUTOMATIC_CHECK_RUNNING");
    assert.equal(requests, 1);

    parsing.resolve({ status: "success", priceTry: 456, title: null });
    assert.equal((await first).outcome, "success");
    assert.equal(requests, 1);
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("developer trigger does not duplicate a manual check already active for the product", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const parsing = deferred();
    const started = deferred();
    let requests = 0;
    fetchHandler = async () => { requests++; started.resolve(); return htmlResponse("B0D47HCRZ6"); };
    parseHandler = () => parsing.promise;

    const manual = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
    await started.promise;
    const result = await globalThis.fiyatNobetiDev.runOneAutomaticCheck();

    assert.equal(result.asin, "B0D47HCRZ6");
    assert.equal(result.outcome, "busy");
    assert.equal(requests, 1);
    parsing.resolve({ status: "success", priceTry: 654, title: null });
    assert.equal((await manual).status, "success");
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("developer trigger respects missing permission without fetching", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    permission = false;
    let requests = 0;
    fetchHandler = async () => { requests++; return htmlResponse(); };

    const result = await globalThis.fiyatNobetiDev.runOneAutomaticCheck();

    assert.equal(result.asin, "B0D47HCRZ6");
    assert.equal(result.outcome, "failure");
    assert.equal(result.errorCode, "PERMISSION_REQUIRED");
    assert.equal(requests, 0);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt, "2026-10-21T11:59:00.000Z");
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("developer result cannot overwrite a removed and re-added product", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const oldParse = deferred();
    const newParse = deferred();
    const oldStarted = deferred();
    const newStarted = deferred();
    const parses = [
      { gate: oldParse, started: oldStarted },
      { gate: newParse, started: newStarted }
    ];
    fetchHandler = async () => htmlResponse("B0D47HCRZ6");
    parseHandler = () => {
      const current = parses.shift();
      current.started.resolve();
      return current.gate.promise;
    };

    const oldCheck = globalThis.fiyatNobetiDev.runOneAutomaticCheck();
    await oldStarted.promise;
    await message("REMOVE_PRODUCT", { asin: "B0D47HCRZ6" });
    const readd = message("ADD_PRODUCT", { url: productUrl("B0D47HCRZ6") });
    await newStarted.promise;

    oldParse.resolve({ status: "success", priceTry: 999, title: "Eski ürün" });
    const oldResult = await oldCheck;
    assert.equal(oldResult.outcome, "failure");
    assert.equal(oldResult.errorCode, "CHECK_CANCELLED");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastCheckStatus, "checking");
    assert.notEqual(stored.watchlist.products.B0D47HCRZ6.title, "Eski ürün");

    newParse.resolve({ status: "success", priceTry: 888, title: "Yeni ürün" });
    assert.equal((await readd).check.status, "success");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 888);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.title, "Yeni ürün");
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("scheduled developer runner bypasses eligibility and uses the automatic fetch path once", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    let requests = 0;
    fetchHandler = async () => { requests++; return htmlResponse("B0D47HCRZ6"); };
    parseHandler = async () => ({ status: "success", priceTry: 777, title: "Alarm ürünü" });

    const target = await prepareAutomaticAlarmTestForDev();
    assert.equal(target.status, "ready");
    assert.equal(requests, 0);
    const result = await runAutomaticAlarmTestForDev(target);

    assert.equal(result.status, "success");
    assert.equal(result.requestStarted, true);
    assert.equal(requests, 1);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 777);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt, new Date(clock.now).toISOString());
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_INTERVAL_MS);
  });
});

test("scheduled developer check preserves another product's eligibility with normal pacing", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0CQXKXBR7", { attemptedAt: "2026-10-20T11:00:00.000Z" });
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T11:00:00.000Z" });
    const target = await prepareAutomaticAlarmTestForDev();
    assert.equal(target.asin, "B0CQXKXBR7");
    fetchHandler = async () => htmlResponse("B0CQXKXBR7");

    assert.equal((await runAutomaticAlarmTestForDev(target)).status, "success");
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt, "2026-10-20T11:00:00.000Z");
    assert.equal(alarms.get(AUTO_ALARM_NAME).scheduledTime, clock.now + AUTO_PACE_MS);
  });
});

test("scheduled developer runner rejects unavailable permission and disabled automatic checks", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async () => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const target = await prepareAutomaticAlarmTestForDev();
    let requests = 0;
    fetchHandler = async () => { requests++; return htmlResponse(); };

    permission = false;
    const denied = await runAutomaticAlarmTestForDev(target);
    assert.equal(denied.status, "failure");
    assert.equal(denied.errorCode, "PERMISSION_REQUIRED");
    assert.equal(denied.requestStarted, false);
    assert.equal(requests, 0);

    permission = true;
    stored.automaticChecks.enabled = false;
    const disabled = await runAutomaticAlarmTestForDev(target);
    assert.equal(disabled.status, "skipped");
    assert.equal(disabled.errorCode, "AUTOMATIC_DISABLED");
    assert.equal(disabled.requestStarted, false);
    assert.equal(requests, 0);
  });
});

test("scheduled developer target is invalidated by removal and same-ASIN re-addition", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const removedTarget = await prepareAutomaticAlarmTestForDev();
    await message("REMOVE_PRODUCT", { asin: "B0D47HCRZ6" });
    let requests = 0;
    fetchHandler = async () => { requests++; return htmlResponse(); };
    const removed = await runAutomaticAlarmTestForDev(removedTarget);
    assert.equal(removed.status, "skipped");
    assert.equal(removed.errorCode, "PRODUCT_NOT_FOUND");

    const replacement = createProductRecord({
      asin: "B0D47HCRZ6",
      canonicalUrl: productUrl("B0D47HCRZ6"),
      addedAt: new Date(clock.now + 1).toISOString()
    });
    stored.watchlist.products.B0D47HCRZ6 = replacement;
    const readded = await runAutomaticAlarmTestForDev(removedTarget);
    assert.equal(readded.status, "skipped");
    assert.equal(readded.errorCode, "PRODUCT_INSTANCE_CHANGED");
    assert.equal(requests, 0);
  });
});

test("scheduled developer runner cannot duplicate an active manual request", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async () => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z" });
    const target = await prepareAutomaticAlarmTestForDev();
    const parsing = deferred();
    const started = deferred();
    let requests = 0;
    fetchHandler = async () => { requests++; started.resolve(); return htmlResponse("B0D47HCRZ6"); };
    parseHandler = () => parsing.promise;
    const manual = message("CHECK_PRODUCT", { asin: "B0D47HCRZ6" });
    await started.promise;

    const result = await runAutomaticAlarmTestForDev(target);
    assert.equal(result.status, "skipped");
    assert.equal(result.errorCode, "CHECK_BUSY");
    assert.equal(result.requestStarted, false);
    assert.equal(requests, 1);
    parsing.resolve({ status: "success", priceTry: 700, title: null });
    await manual;
  });
});

test("scheduled developer runner cannot overlap an active production automatic check", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T11:00:00.000Z" });
    const target = await prepareAutomaticAlarmTestForDev();
    const parsing = deferred();
    const started = deferred();
    let requests = 0;
    fetchHandler = async () => { requests++; started.resolve(); return htmlResponse("B0D47HCRZ6"); };
    parseHandler = () => parsing.promise;
    await installedListener();
    advanceToAlarm(clock);
    const productionCheck = fireAutomaticAlarm();
    await started.promise;

    const result = await runAutomaticAlarmTestForDev(target);
    assert.equal(result.status, "skipped");
    assert.equal(result.errorCode, "AUTOMATIC_CHECK_RUNNING");
    assert.equal(result.requestStarted, false);
    assert.equal(requests, 1);

    parsing.resolve({ status: "success", priceTry: 701, title: null });
    await productionCheck;
  });
});

test("failed scheduled developer fetch preserves the last successful price", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async () => {
    await resetWatchlist();
    const product = seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:59:00.000Z", status: "success" });
    product.lastSuccessfulPriceTry = 599.99;
    product.lastSuccessfulCheckAt = "2026-10-21T10:00:00.000Z";
    const target = await prepareAutomaticAlarmTestForDev();
    fetchHandler = async () => new Response("Denied", { status: 503, headers: { "content-type": "text/html" } });

    const result = await runAutomaticAlarmTestForDev(target);
    assert.equal(result.status, "failure");
    assert.equal(result.errorCode, "HTTP_ERROR");
    assert.equal(result.requestStarted, true);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulPriceTry, 599.99);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.lastSuccessfulCheckAt, "2026-10-21T10:00:00.000Z");
  });
});

test("developer diagnosis uses one safe fetch and does not mutate product check fields", async () => {
  await resetWatchlist();
  setDeveloperEventRecorderForDev(() => Promise.resolve());
  const product = seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-21T11:00:00.000Z", status: "success" });
  product.lastSuccessfulPriceTry = 599.99;
  const before = structuredClone(stored.watchlist);
  let requests = 0;
  fetchHandler = async () => {
    requests++;
    const response = htmlResponse("B0D47HCRZ6");
    Object.defineProperty(response, "url", { value: "https://www.amazon.com.tr/Oral-B-Firca/dp/B0D47HCRZ6?ref_=private" });
    return response;
  };
  parseHandler = (_, type) => {
    assert.equal(type, "PARSE_HTML_DIAG");
    return { status: "failure", errorCode: "PRICE_MISSING", diagnostics: {
      primaryContainerPresent: true, primaryCandidateCount: 0
    } };
  };
  try {
    const result = await diagnoseProductForDev("B0D47HCRZ6");
    assert.equal(result.outcome, "failure");
    assert.equal(result.errorCode, "PRICE_MISSING");
    assert.equal(result.structure.primaryCandidateCount, 0);
    assert.equal(result.responseBytes > 0, true);
    assert.equal(result.contentType, "text/html");
    assert.equal(result.finalUrlClassification, "AMAZON_PRODUCT");
    assert.equal(result.requestStarted, true);
    assert.equal(requests, 1);
    assert.equal(fetched.url, product.canonicalUrl);
    assert.equal(fetched.options.credentials, "omit");
    assert.equal(fetched.options.redirect, "manual");
    assert.deepEqual(stored.watchlist, before);
    assert.doesNotMatch(JSON.stringify(result), /corePrice_feature_div|cookie|<div|ref_=private/);
  } finally { setDeveloperEventRecorderForDev(undefined); }
});

test("developer diagnosis respects permission and does not fetch", async () => {
  await resetWatchlist();
  setDeveloperEventRecorderForDev(() => Promise.resolve());
  seedProduct("B0D47HCRZ6");
  deniedOrigins.add("https://www.amazon.com.tr/*");
  let requests = 0;
  fetchHandler = async () => { requests++; return htmlResponse(); };
  try {
    const result = await diagnoseProductForDev("B0D47HCRZ6");
    assert.equal(result.errorCode, "PERMISSION_REQUIRED");
    assert.equal(result.requestStarted, false);
    assert.equal(requests, 0);
  } finally { setDeveloperEventRecorderForDev(undefined); }
});

test("concurrent diagnosis is busy and removal invalidates an old response", async () => {
  await resetWatchlist();
  setDeveloperEventRecorderForDev(() => Promise.resolve());
  seedProduct("B0D47HCRZ6");
  const gate = deferred();
  const started = deferred();
  let requests = 0;
  fetchHandler = async () => { requests++; started.resolve(); await gate.promise; return htmlResponse("B0D47HCRZ6"); };
  try {
    const pending = diagnoseProductForDev("B0D47HCRZ6");
    await started.promise;
    assert.equal((await diagnoseProductForDev("B0D47HCRZ6")).errorCode, "CHECK_BUSY");
    await message("REMOVE_PRODUCT", { asin: "B0D47HCRZ6" });
    const replacement = seedProduct("B0D47HCRZ6", { addedAt: "2026-10-22T00:00:00.000Z" });
    gate.resolve();
    const result = await pending;
    assert.equal(result.errorCode, "CHECK_CANCELLED");
    assert.equal(requests, 1);
    assert.equal(stored.watchlist.products.B0D47HCRZ6.addedAt, replacement.addedAt);
  } finally { setDeveloperEventRecorderForDev(undefined); }
});

test("developer alarm events distinguish delivery and request without changing the six-hour schedule", async () => {
  useProductionBackground();
  await withClock("2026-10-21T12:00:00.000Z", async clock => {
    await resetWatchlist();
    seedProduct("B0D47HCRZ6", { attemptedAt: "2026-10-20T11:00:00.000Z" });
    const events = [];
    setDeveloperEventRecorderForDev(event => { events.push(event); return Promise.resolve(); });
    try {
      await installedListener();
      assert.ok(events.some(event => event.type === "automatic_alarm_scheduled"));
      assert.equal(events.some(event => event.type === "automatic_request_started"), false);
      advanceToAlarm(clock);
      await fireAutomaticAlarm();
      const types = events.map(event => event.type);
      assert.ok(types.indexOf("automatic_alarm_delivered") < types.indexOf("automatic_request_started"));
      assert.ok(types.indexOf("automatic_request_started") < types.indexOf("automatic_check_completed"));
      assert.equal(events.find(event => event.type === "automatic_check_completed").requestStarted, true);
      const checkedAt = Date.parse(stored.watchlist.products.B0D47HCRZ6.lastAttemptedCheckAt);
      assert.ok(alarms.get(AUTO_ALARM_NAME).scheduledTime >= checkedAt + AUTO_INTERVAL_MS);
    } finally { setDeveloperEventRecorderForDev(undefined); }
  });
});
