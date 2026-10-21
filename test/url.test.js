import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAmazonUrl } from "../src/url.js";

test("accepts both supported Amazon Türkiye paths and discards tracking parameters", () => {
  assert.deepEqual(normalizeAmazonUrl("https://www.amazon.com.tr/dp/B0FZ9Y4GPF?tag=sample#details"), {
    asin: "B0FZ9Y4GPF",
    canonicalUrl: "https://www.amazon.com.tr/dp/B0FZ9Y4GPF"
  });
  assert.deepEqual(normalizeAmazonUrl("https://www.amazon.com.tr/gp/product/b0fz9y4gpf/").asin, "B0FZ9Y4GPF");
});

test("rejects unrelated and misleading hosts, credentials and insecure URLs", () => {
  for (const value of [
    "https://amazon.com.tr/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr.evil.example/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr@evil.example/dp/B0FZ9Y4GPF",
    "https://evil.example/?next=https://www.amazon.com.tr/dp/B0FZ9Y4GPF",
    "https://user@www.amazon.com.tr/dp/B0FZ9Y4GPF",
    "http://www.amazon.com.tr/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr:8443/dp/B0FZ9Y4GPF",
    "not a URL"
  ]) assert.throws(() => normalizeAmazonUrl(value));
});

test("rejects unsupported paths and malformed ASINs", () => {
  for (const value of [
    "https://www.amazon.com.tr/",
    "https://www.amazon.com.tr/s?k=dji",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GP",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GPF/ref=foo",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GPF",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GP!"
  ]) assert.throws(() => normalizeAmazonUrl(value), { message: "UNSUPPORTED_URL" });
});
