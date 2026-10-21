import test from "node:test";
import assert from "node:assert/strict";

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
let permissionChecks = [];
globalThis.chrome = {
  runtime: {
    id: "test-extension",
    onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) {
      assert.equal(message.type, "PARSE_HTML");
      assert.match(message.html, /corePrice_feature_div/);
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
  storage: { local: { async set(value) { Object.assign(stored, value); } } }
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
