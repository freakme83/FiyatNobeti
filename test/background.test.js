import test from "node:test";
import assert from "node:assert/strict";
import { createProductRow, errorMessage } from "../src/watchlist-view.js";
import { normalizeProductTitle } from "../src/watchlist.js";

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
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) {
      assert.equal(message.type, "PARSE_HTML");
      assert.match(message.html, /corePrice_feature_div/);
      if (parseHandler) return parseHandler(message.html);
      return { status: "success", priceTry: 36000 };
    }
  },
  permissions: { async contains({ origins }) {
    permissionChecks.push(...origins);
    return permission && !origins.some(origin => deniedOrigins.has(origin));
  } },
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
await import("../background.js");

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
  fetchHandler = async () => htmlResponse();
  parseHandler = null;
  permission = true;
  deniedOrigins.clear();
};

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
