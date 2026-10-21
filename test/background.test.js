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
  assert.deepEqual(result.diagnostics, { redirectCount: 0 });
  assert.equal(result.checkedAt, stored.lastCheck.checkedAt);
  assert.equal(JSON.stringify(result).includes("private raw network details"), false);
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
    responseType: "opaqueredirect",
    redirectCount: 0,
    locationAccessible: false
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
    return new Response(null, {
      status: 302,
      headers: { location: "https://www.amazon.com.tr/dp/B0CQXKXBR7" }
    });
  };
  const result = await check("https://amzn.eu/d/02JpD8hn");
  assert.equal(result.errorCode, "PERMISSION_REQUIRED");
  assert.deepEqual(networkRequests, ["https://amzn.eu/d/02JpD8hn"]);
  assert.deepEqual(stored.lastSuccess, previous);
});
