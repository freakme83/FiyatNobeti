import test from "node:test";
import assert from "node:assert/strict";
import { resolveAmazonShortLink } from "../src/shortlink.js";

function redirect(location, status = 302, type = "basic") {
  return { status, type, headers: new Headers(location ? { location } : {}) };
}

async function rejectsCode(promise, code, diagnostics = {}) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(error.diagnostics, diagnostics);
    return true;
  });
}

const shortUrl = "https://amzn.eu/d/02JpD8hn";

test("resolves a short link through a bounded manual redirect to a canonical Türkiye URL", async () => {
  const calls = [];
  const result = await resolveAmazonShortLink(shortUrl, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return redirect("https://www.amazon.com.tr/Soundcore-Kulakl%C4%B1k/dp/b0cqxkxbr7?ref_=share");
    }
  });
  assert.deepEqual(result, {
    type: "product",
    asin: "B0CQXKXBR7",
    canonicalUrl: "https://www.amazon.com.tr/dp/B0CQXKXBR7"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].url, shortUrl);
});

test("distinguishes opaque redirects and missing Location headers with safe metadata", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => ({ status: 0, type: "opaqueredirect", headers: new Headers() })
  }), "SHORT_LINK_OPAQUE_REDIRECT", {
    responseType: "opaqueredirect", redirectCount: 0, locationAccessible: false
  });

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => redirect(null, 302)
  }), "SHORT_LINK_LOCATION_MISSING", {
    httpStatus: 302, responseType: "basic", redirectCount: 0, locationAccessible: false
  });
});

test("reports unexpected HTTP statuses and network failures without raw exception details", async () => {
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => redirect(null, 503)
  }), "SHORT_LINK_HTTP_STATUS", {
    httpStatus: 503, responseType: "basic", redirectCount: 0, locationAccessible: false
  });
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => { throw new Error("private raw network details"); }
  }), "SHORT_LINK_NETWORK_ERROR", { redirectCount: 0 });
});

test("classifies aborted requests as timeout rather than network errors", async () => {
  const controller = new AbortController();
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    signal: controller.signal,
    fetchImpl: async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
  }), "SHORT_LINK_TIMEOUT", { redirectCount: 0 });
  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }
  }), "SHORT_LINK_TIMEOUT", { redirectCount: 0 });
});

test("rejects unsafe targets and unsupported Amazon marketplaces before fetching them", async () => {
  for (const [location, code] of [
    ["https://www.amazon.de/dp/B0CQXKXBR7", "SHORT_LINK_UNSUPPORTED_MARKETPLACE"],
    ["https://evil.example/dp/B0CQXKXBR7", "SHORT_LINK_UNSAFE_REDIRECT"],
    ["http://www.amazon.com.tr/dp/B0CQXKXBR7", "SHORT_LINK_UNSAFE_REDIRECT"],
    ["https://www.amazon.com.tr.evil.example/dp/B0CQXKXBR7", "SHORT_LINK_UNSAFE_REDIRECT"],
    ["https://www.amazon.com.tr/s?k=dji", "SHORT_LINK_UNSAFE_REDIRECT"]
  ]) {
    const requested = [];
    await rejectsCode(resolveAmazonShortLink(shortUrl, {
      fetchImpl: async url => {
        requested.push(url);
        return redirect(location);
      }
    }), code, {
      httpStatus: 302,
      responseType: "basic",
      redirectCount: 1,
      locationAccessible: true
    });
    assert.deepEqual(requested, [shortUrl]);
  }
});

test("follows only valid Amazon short-link hops and detects redirect loops", async () => {
  let count = 0;
  const result = await resolveAmazonShortLink(shortUrl, {
    fetchImpl: async url => {
      count++;
      if (url.endsWith("02JpD8hn")) return redirect("/d/ABcd1234");
      return redirect("https://www.amazon.com.tr/dp/B0FZ9Y4GPF");
    }
  });
  assert.equal(count, 2);
  assert.equal(result.asin, "B0FZ9Y4GPF");

  await rejectsCode(resolveAmazonShortLink(shortUrl, {
    fetchImpl: async () => redirect(shortUrl)
  }), "SHORT_LINK_REDIRECT_LOOP", { redirectCount: 1 });
});

test("stops excessive redirect chains within the configured bounded limit", async () => {
  let number = 0;
  await rejectsCode(resolveAmazonShortLink("https://amzn.eu/d/AA000000", {
    fetchImpl: async () => redirect(`https://amzn.eu/d/AA${String(++number).padStart(6, "0")}`),
    maxRedirects: 2
  }), "SHORT_LINK_TOO_MANY_REDIRECTS", {
    httpStatus: 302, responseType: "basic", redirectCount: 2, locationAccessible: true
  });
  assert.equal(number, 3);
});
