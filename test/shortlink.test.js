import test from "node:test";
import assert from "node:assert/strict";
import { resolveAmazonShortLink } from "../src/shortlink.js";

function redirect(location, status = 302) {
  return { status, type: "basic", headers: new Headers(location ? { location } : {}) };
}

test("resolves a short link through a bounded manual redirect to a canonical Türkiye URL", async () => {
  const calls = [];
  const result = await resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
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
  assert.equal(calls[0].url, "https://amzn.eu/d/02JpD8hn");
});

test("rejects redirects to other Amazon marketplaces and unrelated hosts before fetching them", async () => {
  for (const [location, code] of [
    ["https://www.amazon.de/dp/B0CQXKXBR7", "UNSUPPORTED_MARKETPLACE"],
    ["https://evil.example/dp/B0CQXKXBR7", "UNSAFE_REDIRECT"],
    ["http://www.amazon.com.tr/dp/B0CQXKXBR7", "UNSAFE_REDIRECT"],
    ["https://www.amazon.com.tr.evil.example/dp/B0CQXKXBR7", "UNSAFE_REDIRECT"],
    ["https://www.amazon.com.tr/s?k=dji", "SHORT_LINK_RESOLUTION_FAILED"]
  ]) {
    const requested = [];
    await assert.rejects(
      resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
        fetchImpl: async url => {
          requested.push(url);
          return redirect(location);
        }
      }),
      { message: code }
    );
    assert.deepEqual(requested, ["https://amzn.eu/d/02JpD8hn"]);
  }
});

test("follows only valid Amazon short-link hops and detects redirect loops", async () => {
  let count = 0;
  const result = await resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
    fetchImpl: async url => {
      count++;
      if (url.endsWith("02JpD8hn")) return redirect("/d/ABcd1234");
      return redirect("https://www.amazon.com.tr/dp/B0FZ9Y4GPF");
    }
  });
  assert.equal(count, 2);
  assert.equal(result.asin, "B0FZ9Y4GPF");

  await assert.rejects(
    resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
      fetchImpl: async () => redirect("https://amzn.eu/d/02JpD8hn")
    }),
    { message: "SHORT_LINK_REDIRECT_LOOP" }
  );
});

test("stops excessive redirect chains and rejects missing or opaque redirect targets", async () => {
  let number = 0;
  await assert.rejects(
    resolveAmazonShortLink("https://amzn.eu/d/AA000000", {
      fetchImpl: async () => redirect(`https://amzn.eu/d/AA${String(++number).padStart(6, "0")}`)
    }),
    { message: "SHORT_LINK_TOO_MANY_REDIRECTS" }
  );
  await assert.rejects(
    resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
      fetchImpl: async () => redirect(null)
    }),
    { message: "SHORT_LINK_RESOLUTION_FAILED" }
  );
  await assert.rejects(
    resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
      fetchImpl: async () => ({ status: 0, type: "opaqueredirect", headers: new Headers() })
    }),
    { message: "SHORT_LINK_RESOLUTION_FAILED" }
  );
});

test("reports network errors and non-redirect responses without live requests", async () => {
  await assert.rejects(
    resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
      fetchImpl: async () => { throw new Error("offline"); }
    }),
    { message: "SHORT_LINK_RESOLUTION_FAILED" }
  );
  await assert.rejects(
    resolveAmazonShortLink("https://amzn.eu/d/02JpD8hn", {
      fetchImpl: async () => ({ status: 404, type: "basic", headers: new Headers() })
    }),
    { message: "SHORT_LINK_RESOLUTION_FAILED" }
  );
});
