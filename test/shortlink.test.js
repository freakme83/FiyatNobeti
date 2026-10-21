import test from "node:test";
import assert from "node:assert/strict";
import { resolveAmazonShortLink } from "../src/shortlink.js";

const shortUrl = "https://amzn.eu/d/02JpD8hn";

function finalResponse(url, { status = 200, type = "basic" } = {}) {
  return { url, status, type, ok: status >= 200 && status <= 299 };
}

async function rejectsCode(promise, code, diagnostics = {}) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(error.diagnostics, diagnostics);
    return true;
  });
}

test("automatically follows a short link and normalizes a valid final Türkiye product URL", async () => {
  let request;
  const result = await resolveAmazonShortLink(shortUrl, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return finalResponse("https://www.amazon.com.tr/dp/B0FZ9Y4GPF");
    }
  });
  assert.deepEqual(result, {
    type: "product",
    asin: "B0FZ9Y4GPF",
    canonicalUrl: "https://www.amazon.com.tr/dp/B0FZ9Y4GPF"
  });
  assert.equal(request.url, shortUrl);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "follow");
});

test("accepts a long encoded Türkiye destination and discards its tracking data", async () => {
  const result = await resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse(
      "https://www.amazon.com.tr/Soundcore-Kulakl%C4%B1k-G%C3%BCr%C3%BClt%C3%BC/dp/b0cqxkxbr7?ref_=share&tag=tracking#details"
    )
  });
  assert.deepEqual(result, {
    type: "product",
    asin: "B0CQXKXBR7",
    canonicalUrl: "https://www.amazon.com.tr/dp/B0CQXKXBR7"
  });
});

test("rejects destinations outside Türkiye and HTTP destinations", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("https://www.amazon.de/dp/B0CQXKXBR7")
  }), "SHORT_LINK_UNSUPPORTED_MARKETPLACE", { httpStatus: 200, responseType: "basic" });

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("http://www.amazon.com.tr/dp/B0CQXKXBR7")
  }), "SHORT_LINK_UNSAFE_REDIRECT", { httpStatus: 200, responseType: "basic" });

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("https://unrelated.example/dp/B0CQXKXBR7")
  }), "SHORT_LINK_UNSAFE_REDIRECT", { httpStatus: 200, responseType: "basic" });
});

test("rejects unsupported, malformed, or credential-bearing final product URLs", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("https://www.amazon.com.tr/s?k=B0CQXKXBR7")
  }), "SHORT_LINK_UNSUPPORTED_PRODUCT_URL", { httpStatus: 200, responseType: "basic" });

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("not a URL")
  }), "SHORT_LINK_FINAL_URL_INVALID", { httpStatus: 200, responseType: "basic" });

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("https://user@www.amazon.com.tr/dp/B0CQXKXBR7")
  }), "SHORT_LINK_UNSAFE_REDIRECT", { httpStatus: 200, responseType: "basic" });
});

test("reports missing final response URLs and unsuccessful HTTP statuses", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse(undefined)
  }), "SHORT_LINK_FINAL_URL_MISSING", { httpStatus: 200, responseType: "basic" });

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("https://www.amazon.com.tr/dp/B0CQXKXBR7", { status: 503 })
  }), "SHORT_LINK_HTTP_STATUS", { httpStatus: 503, responseType: "basic" });
});

test("fails closed for opaque or otherwise unreadable responses", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("", { status: 0, type: "opaqueredirect" })
  }), "SHORT_LINK_OPAQUE_REDIRECT", { responseType: "opaqueredirect" });
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("", { status: 0, type: "opaque" })
  }), "SHORT_LINK_OPAQUE_RESPONSE", { responseType: "opaque" });
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => finalResponse("", { status: 0, type: "error" })
  }), "SHORT_LINK_UNUSABLE_RESPONSE", { responseType: "error" });
});

test("classifies network failures, timeouts, and browser redirect-limit rejection safely", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => { throw new TypeError("private CORS/network detail"); }
  }), "SHORT_LINK_NETWORK_ERROR");

  const controller = new AbortController();
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    signal: controller.signal,
    fetchImpl: async () => {
      controller.abort();
      throw Object.assign(new Error("private abort detail"), { name: "AbortError" });
    }
  }), "SHORT_LINK_TIMEOUT");
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => { throw Object.assign(new Error("abort"), { name: "AbortError" }); }
  }), "SHORT_LINK_TIMEOUT");

  // Fetch does not expose whether a rejected follow-mode request hit its redirect cap or a network/CORS restriction.
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "follow");
      throw new TypeError("redirect limit reached: private details");
    }
  }), "SHORT_LINK_NETWORK_ERROR");
});

test("validates the submitted short URL before fetching and rejects ordinary product URLs", async () => {
  let called = false;
  await assert.rejects(resolveAmazonShortLink("https://evil.example/d/02JpD8hn", {
    fetchImpl: async () => { called = true; }
  }));
  await assert.rejects(resolveAmazonShortLink("https://www.amazon.com.tr/dp/B0FZ9Y4GPF", {
    fetchImpl: async () => { called = true; }
  }), { message: "UNSUPPORTED_URL" });
  assert.equal(called, false);
});
