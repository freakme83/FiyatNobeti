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
  permissions: { async contains() { return permission; } },
  offscreen: {
    async hasDocument() { return true; },
    async createDocument() { throw new Error("unexpected"); }
  },
  storage: { local: { async set(value) { Object.assign(stored, value); } } }
};
globalThis.fetch = async (url, options) => {
  fetched = { url, options };
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
