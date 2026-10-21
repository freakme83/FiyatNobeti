import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAmazonUrl, parseAmazonInput } from "../src/url.js";

test("supports canonical, legacy, title and percent-encoded Turkish product URLs", () => {
  const cases = [
    ["https://www.amazon.com.tr/dp/B0CQXKXBR7", "B0CQXKXBR7"],
    ["https://www.amazon.com.tr/gp/product/b0cqxkxbr7", "B0CQXKXBR7"],
    ["https://www.amazon.com.tr/Soundcore-Kablosuz-Kulaklik/dp/B0CQXKXBR7", "B0CQXKXBR7"],
    ["https://www.amazon.com.tr/Soundcore-Kulakl%C4%B1k-G%C3%BCr%C3%BClt%C3%BC/dp/B0CQXKXBR7", "B0CQXKXBR7"],
    ["https://www.amazon.com.tr/Soundcore-Kablosuz-Kulaklik/dp/b0cqxkxbr7/ref=sr_1_1?pd_rd_w=example&ref_=example#details", "B0CQXKXBR7"],
    ["https://www.amazon.com.tr/gp/product/B0CQXKXBR7/ref=ox_sc_act_title_1/?tag=discard", "B0CQXKXBR7"],
    ["https://www.amazon.com.tr/dp/B0FZ9Y4GPF?tag=sample#details", "B0FZ9Y4GPF"]
  ];
  for (const [input, asin] of cases) {
    assert.deepEqual(normalizeAmazonUrl(input), {
      asin,
      canonicalUrl: `https://www.amazon.com.tr/dp/${asin}`
    });
  }
});

test("accepts an Amazon short link only in the expected HTTPS format", () => {
  assert.deepEqual(parseAmazonInput("https://amzn.eu/d/02JpD8hn?ref_=share"), {
    type: "short",
    shortUrl: "https://amzn.eu/d/02JpD8hn"
  });
  assert.deepEqual(parseAmazonInput("https://amzn.eu/d/02JpD8hn/").type, "short");
  for (const value of [
    "http://amzn.eu/d/02JpD8hn",
    "https://amzn.eu/",
    "https://amzn.eu/d/",
    "https://amzn.eu/d/short",
    "https://amzn.eu/gp/product/B0CQXKXBR7",
    "https://amzn.eu.evil.example/d/02JpD8hn",
    "https://user@amzn.eu/d/02JpD8hn",
    "https://amzn.eu:444/d/02JpD8hn"
  ]) assert.throws(() => parseAmazonInput(value));
});

test("rejects unrelated hosts, deceptive subdomains, credentials, ports and unsafe protocols", () => {
  for (const value of [
    "https://amazon.com.tr/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr.evil.example/dp/B0FZ9Y4GPF",
    "https://evilamazon.com.tr/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr@evil.example/dp/B0FZ9Y4GPF",
    "https://evil.example/?next=https://www.amazon.com.tr/dp/B0FZ9Y4GPF",
    "https://user@www.amazon.com.tr/dp/B0FZ9Y4GPF",
    "http://www.amazon.com.tr/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr:8443/dp/B0FZ9Y4GPF",
    "not a URL"
  ]) assert.throws(() => normalizeAmazonUrl(value));
  assert.throws(() => normalizeAmazonUrl("https://www.amazon.de/dp/B0FZ9Y4GPF"), { message: "UNSUPPORTED_MARKETPLACE" });
});

test("rejects malformed, ambiguous and arbitrary paths instead of searching query text", () => {
  for (const value of [
    "https://www.amazon.com.tr/",
    "https://www.amazon.com.tr/s?k=B0FZ9Y4GPF",
    "https://www.amazon.com.tr/foo/bar/dp/B0FZ9Y4GPF",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GPF/dp/B0CQXKXBR7",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GP/ref=abc",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GPF/ref=ok/other",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GPF",
    "https://www.amazon.com.tr/%2Fdp/B0FZ9Y4GPF"
  ]) assert.throws(() => normalizeAmazonUrl(value));
  assert.equal(
    normalizeAmazonUrl("https://www.amazon.com.tr/dp/B0FZ9Y4GPF?path=/dp/B0CQXKXBR7").asin,
    "B0FZ9Y4GPF"
  );
});
