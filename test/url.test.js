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
    ["https://www.amazon.com.tr/dp/B0FZ9Y4GPF?tag=sample#details", "B0FZ9Y4GPF"],
    ["https://www.amazon.com.tr/SoundPEATS-Air4-Pro-Kulakl%C4%B1klar-Uyarlanabilir/dp/B0CKXJBQ6L/ref=dp_fod_d_sccl_2/258-5197637-2641928?pd_rd_i=B0CKXJBQ6L&psc=1", "B0CKXJBQ6L"],
    ["https://www.amazon.com.tr/Kiz/dp/6052657669/ref=pd_bxgy_thbs_d_sccl_1/261-7744755-0782146?psc=1", "6052657669"]
  ];
  for (const [input, asin] of cases) {
    assert.deepEqual(normalizeAmazonUrl(input), {
      asin,
      canonicalUrl: `https://www.amazon.com.tr/dp/${asin}`
    });
  }
});

test("supports the Amazon Türkiye mobile /gp/aw/d/ product path", () => {
  const cases = [
    "https://www.amazon.com.tr/gp/aw/d/B0DL6JN8V4",
    "https://www.amazon.com.tr/gp/aw/d/b0dl6jn8v4?pd_rd_plhdr=t&hsa_cr_id=0&qid=1792952221&sr=1-1-941ebe59-d25b-49d0-b214-12cc5b66c90f&i=aps&aref=I4pc2F4x2y&_encoding=UTF8&ref_=sbx_s_sparkle_sbtcd_asin_0_img#details",
    "https://www.amazon.com.tr/gp/aw/d/B0DL6JN8V4/ref=abc/258-5197637-2641928"
  ];
  for (const input of cases) {
    assert.deepEqual(normalizeAmazonUrl(input), {
      asin: "B0DL6JN8V4",
      canonicalUrl: "https://www.amazon.com.tr/dp/B0DL6JN8V4"
    });
  }
  assert.deepEqual(parseAmazonInput(cases[1]), {
    type: "product", asin: "B0DL6JN8V4",
    canonicalUrl: "https://www.amazon.com.tr/dp/B0DL6JN8V4"
  });
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

test("accepts standalone ASINs and normalizes them to canonical product URLs", () => {
  const cases = [
    ["B0CKXJBQ6L", "B0CKXJBQ6L"],
    ["b0ckxjbq6l", "B0CKXJBQ6L"],
    ["6052657669", "6052657669"],
    ["  6259174209  ", "6259174209"]
  ];
  for (const [input, asin] of cases) {
    assert.deepEqual(parseAmazonInput(input), {
      type: "product",
      asin,
      canonicalUrl: `https://www.amazon.com.tr/dp/${asin}`
    });
  }
  assert.deepEqual(parseAmazonInput("https://www.amazon.com.tr/dp/b0ckxjbq6l?tag=discard"), {
    type: "product",
    asin: "B0CKXJBQ6L",
    canonicalUrl: "https://www.amazon.com.tr/dp/B0CKXJBQ6L"
  });
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
    "https://www.amazon.com.tr/dp/B0FZ9Y4GPF/ref=ok/258-5197637-2641928/extra",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GPF/ref=ok/258-5197637-264192",
    "https://www.amazon.com.tr/dp/B0FZ9Y4GPF/258-5197637-2641928",
    "https://www.amazon.com.tr/gp/aw/d/",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GP",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GPFX",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GPF/extra",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GPF/ref=ok/258-5197637-2641928/extra",
    "https://www.amazon.com.tr/gp/aw/d/B0FZ9Y4GPF/nested/dp/B0CQXKXBR7",
    "https://www.amazon.com.tr.evil.example/gp/aw/d/B0DL6JN8V4",
    "http://www.amazon.com.tr/gp/aw/d/B0DL6JN8V4",
    "https://www.amazon.com.tr/%2Fdp/B0FZ9Y4GPF"
  ]) assert.throws(() => normalizeAmazonUrl(value));
  assert.equal(
    normalizeAmazonUrl("https://www.amazon.com.tr/dp/B0FZ9Y4GPF?path=/dp/B0CQXKXBR7").asin,
    "B0FZ9Y4GPF"
  );
});

test("rejects malformed standalone ASINs and arbitrary text containing an ASIN", () => {
  for (const value of [
    "B0CKXJBQ6",
    "B0CKXJBQ6LX",
    "B0CKXJBQ-6",
    "B0CKXJBQ6İ",
    "product B0CKXJBQ6",
    "B0CKXJBQ6 extra",
    ""
  ]) assert.throws(() => parseAmazonInput(value));
});
