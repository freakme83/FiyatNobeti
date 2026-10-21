import test from "node:test";
import assert from "node:assert/strict";
import { extractPrimaryPrice, parseTurkishPrice } from "../src/price.js";

// Synthetic HTML fixture adapter: supplies only the DOM methods the extractor reads.
// Browser DOMParser integration remains a manual test, as Node has no built-in HTML DOM.
function fixture(html) {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] || "";
  const bodyText = html.replace(/<[^>]*>/g, " ");
  const core = /<div\s+id="corePrice_feature_div"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  const prices = [...(core || "").matchAll(/<span\s+class="a-offscreen"[^>]*>([^<]*)<\/span>/gi)]
    .map(match => ({ textContent: match[1] }));
  return {
    title,
    body: { textContent: bodyText },
    querySelector(selector) {
      if (selector === "#corePrice_feature_div") return core === undefined ? null : {};
      if (selector === "#ap_email") return /id="ap_email"/.test(html) ? {} : null;
      throw new Error("Unexpected selector: " + selector);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "#corePrice_feature_div .a-offscreen");
      return prices;
    }
  };
}

test("normalizes Turkish TRY with separators, rejecting ambiguous or non-TRY text", () => {
  assert.equal(parseTurkishPrice("36.399,00TL"), 36399);
  assert.equal(parseTurkishPrice("₺ 1.234,50"), 1234.5);
  assert.equal(parseTurkishPrice("1.234,50\u00a0TL"), 1234.5);
  for (const price of ["1,234.50 TL", "36.399 TL", "36.399,00 USD", "0,00TL", "1.23,00TL", "36.399,00 TL / ay", "36.399,00"]) {
    assert.equal(parseTurkishPrice(price), null, price);
  }
});

test("extracts only the verified primary selector despite unrelated prices", () => {
  const doc = fixture(`
    <title>Ürün</title>
    <div class="sponsored"><span class="a-offscreen">15.000,00TL</span></div>
    <div id="corePrice_feature_div"><span class="a-offscreen">36.399,00TL</span></div>
    <div class="recommendation"><span class="a-offscreen">10.000,00TL</span></div>
    <div id="listPrice"><span class="a-offscreen">42.000,00TL</span></div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 36399 });
});

test("never substitutes related or list prices for missing primary price", () => {
  assert.deepEqual(extractPrimaryPrice(fixture(`
    <div id="corePrice_feature_div"></div>
    <div class="related"><span class="a-offscreen">1.000,00TL</span></div>`)),
  { status: "failure", errorCode: "PRICE_MISSING" });
  assert.deepEqual(extractPrimaryPrice(fixture('<span class="a-offscreen">1.000,00TL</span>')),
    { status: "failure", errorCode: "HTML_STRUCTURE" });
});

test("rejects multiple primary candidates and unrecognized primary prices", () => {
  assert.deepEqual(extractPrimaryPrice(fixture(`
    <div id="corePrice_feature_div">
      <span class="a-offscreen">36.399,00TL</span>
      <span class="a-offscreen">40.000,00TL</span>
    </div>`)), { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
  assert.deepEqual(extractPrimaryPrice(fixture('<div id="corePrice_feature_div"><span class="a-offscreen">See options</span></div>')),
    { status: "failure", errorCode: "PRICE_UNRECOGNIZED" });
});

test("classifies bot checks, access denied, and sign-in pages before price extraction", () => {
  assert.deepEqual(extractPrimaryPrice(fixture('<title>Robot Check</title><p>Enter the characters you see below</p>')),
    { status: "failure", errorCode: "BOT_VERIFICATION" });
  assert.deepEqual(extractPrimaryPrice(fixture('<title>Access Denied</title>')),
    { status: "failure", errorCode: "ACCESS_DENIED" });
  assert.deepEqual(extractPrimaryPrice(fixture('<title>Amazon Sign-In</title><input id="ap_email">')),
    { status: "failure", errorCode: "AUTH_REQUIRED" });
});
