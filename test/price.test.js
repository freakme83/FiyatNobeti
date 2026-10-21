import test from "node:test";
import assert from "node:assert/strict";
import { extractPrimaryPrice, parseTurkishPrice } from "../src/price.js";

// Small synthetic HTML tree with parentElement/classList relationships like DOMParser nodes.
// Browser DOMParser integration remains a manual test, as Node has no built-in HTML DOM.
function fixture(html) {
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  function makeNode(tagName, attributes, parentElement) {
    const classNames = (attributes.class || "").split(/\s+/).filter(Boolean);
    const children = [];
    let ownText = "";
    return {
      tagName,
      id: attributes.id || "",
      parentElement,
      children,
      classList: {
        length: classNames.length,
        item(index) { return classNames[index] ?? null; },
        contains(value) { return classNames.includes(value); }
      },
      appendText(value) { ownText += value; },
      get textContent() { return ownText + children.map(child => child.textContent).join(""); }
    };
  }

  const root = makeNode("#document", {}, null);
  const stack = [root];
  for (const tokenMatch of html.matchAll(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)) {
    const token = tokenMatch[0];
    if (token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) {
      stack.at(-1).appendText(token);
      continue;
    }
    const close = /^<\s*\/\s*([\w-]+)/.exec(token);
    if (close) {
      const index = stack.map(node => node.tagName).lastIndexOf(close[1].toLowerCase());
      if (index > 0) stack.length = index;
      continue;
    }
    const opening = /^<\s*([\w-]+)\b([^>]*)>/.exec(token);
    if (!opening) continue;
    const tagName = opening[1].toLowerCase();
    const attributes = {};
    for (const match of opening[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    const node = makeNode(tagName, attributes, stack.at(-1));
    stack.at(-1).children.push(node);
    if (!voidTags.has(tagName) && !/\/\s*>$/.test(token)) stack.push(node);
  }

  const findAll = (node, predicate, output = []) => {
    for (const child of node.children) {
      if (predicate(child)) output.push(child);
      findAll(child, predicate, output);
    }
    return output;
  };
  const findById = id => findAll(root, node => node.id === id)[0] || null;
  const body = findById("body");
  return {
    title: findAll(root, node => node.tagName === "title")[0]?.textContent || "",
    body: body || { textContent: root.textContent },
    querySelector(selector) {
      if (selector === "#corePrice_feature_div") return findById("corePrice_feature_div");
      if (selector === "#ap_email") return findById("ap_email");
      throw new Error("Unexpected selector: " + selector);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "#corePrice_feature_div .a-offscreen");
      const core = findById("corePrice_feature_div");
      return core ? findAll(core, node => node.classList.contains("a-offscreen")) : [];
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

test("keeps the selling price when Amazon also places a per-unit price before it", () => {
  const doc = fixture(`
    <div id="corePrice_feature_div">
      <span class="a-price a-text-price apex-priceperunit">
        <span><span class="a-offscreen">150,00TL</span></span>
      </span>
      <span class="a-price aok-align-center apex-pricetoprice">
        <span><span class="a-offscreen">599,99TL</span></span>
      </span>
    </div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 599.99 });
});

test("keeps the selling price when the per-unit component follows it", () => {
  const doc = fixture(`
    <div id="corePrice_feature_div">
      <span class="a-price aok-align-center apex-pricetoprice">
        <span class="a-offscreen">599,99TL</span>
      </span>
      <span class="a-price a-text-price apex-priceperunit-desktop">
        <span class="a-offscreen">150,00TL</span>
      </span>
    </div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 599.99 });
});

test("filters multiple nested per-unit candidates without hiding the selling price", () => {
  const doc = fixture(`
    <div id="corePrice_feature_div">
      <div class="apex-priceperunit-container">
        <span class="a-price a-text-price apex-priceperunit">
          <span><span class="a-offscreen">150,00TL</span></span>
        </span>
        <span class="a-price a-text-price apex-priceperunit-secondary">
          <span class="a-offscreen">149,99TL</span>
        </span>
      </div>
      <span class="a-price apex-pricetoprice"><span class="a-offscreen">599,99TL</span></span>
    </div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 599.99 });
});

test("leaves multiple genuine selling-price candidates ambiguous, including equal values", () => {
  const doc = fixture(`
    <div id="corePrice_feature_div">
      <span class="a-price apex-pricetoprice"><span class="a-offscreen">599,99TL</span></span>
      <span class="a-price apex-pricetoprice"><span class="a-offscreen">599,99TL</span></span>
    </div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
});

test("returns missing when the primary container contains only per-unit prices", () => {
  const doc = fixture(`
    <div id="corePrice_feature_div">
      <span class="a-price a-text-price apex-priceperunit"><span class="a-offscreen">150,00TL</span></span>
      <span class="a-price a-text-price apex-priceperunit-alt"><span class="a-offscreen">149,99TL</span></span>
    </div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_MISSING" });
});

test("keeps invalid-format behavior for the remaining selling-price candidate", () => {
  const doc = fixture(`
    <div id="corePrice_feature_div">
      <span class="a-price apex-pricetoprice"><span class="a-offscreen">599 TL / ay</span></span>
      <span class="a-price a-text-price apex-priceperunit"><span class="a-offscreen">150,00TL</span></span>
    </div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_UNRECOGNIZED" });
});

test("never substitutes related or list prices for missing primary price", () => {
  assert.deepEqual(extractPrimaryPrice(fixture(`
    <div id="corePrice_feature_div"></div>
    <div class="related"><span class="a-offscreen">1.000,00TL</span></div>`)),
  { status: "failure", errorCode: "PRICE_MISSING" });
  assert.deepEqual(extractPrimaryPrice(fixture('<span class="a-offscreen">1.000,00TL</span>')),
    { status: "failure", errorCode: "HTML_STRUCTURE" });
});

test("preserves the existing DJI and Soundcore primary-price extraction cases", () => {
  const cases = [
    [`<div id="corePrice_feature_div"><span class="a-offscreen">36.399,00TL</span></div>`, 36399],
    [`<div id="corePrice_feature_div"><span class="a-offscreen">2.499,00TL</span></div>`, 2499]
  ];
  for (const [html, expected] of cases) {
    assert.deepEqual(extractPrimaryPrice(fixture(html)), { status: "success", priceTry: expected });
  }
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
