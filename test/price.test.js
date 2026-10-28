import test from "node:test";
import assert from "node:assert/strict";
import { extractPrimaryPrice, extractProductTitle, parseTurkishPrice } from "../src/price.js";

// Small synthetic HTML tree with parentElement/classList relationships like DOMParser nodes.
// Browser DOMParser integration remains a manual test, as Node has no built-in HTML DOM.
function fixture(html) {
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  function makeNode(tagName, attributes, parentElement) {
    const classNames = (attributes.class || "").split(/\s+/).filter(Boolean);
    const children = [];
    const childNodes = [];
    let ownText = "";
    return {
      nodeType: tagName === "#document" ? 9 : 1,
      tagName: tagName.toUpperCase(),
      id: attributes.id || "",
      getAttribute(name) { return attributes[name] ?? null; },
      parentElement,
      children,
      childNodes,
      classList: {
        length: classNames.length,
        item(index) { return classNames[index] ?? null; },
        contains(value) { return classNames.includes(value); }
      },
      appendText(value) {
        ownText += value;
        childNodes.push({ nodeType: 3, nodeValue: value, textContent: value });
      },
      closest(selector) {
        if (selector !== ".a-accordion-row") return null;
        for (let node = this; node; node = node.parentElement) {
          if (node.classList?.contains("a-accordion-row")) return node;
        }
        return null;
      },
      contains(target) {
        for (let node = target; node; node = node.parentElement) if (node === this) return true;
        return false;
      },
      querySelectorAll(selector) {
        if (selector !== "h5") throw new Error("Unexpected element selector: " + selector);
        return findAll(this, node => node.tagName === "H5");
      },
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
      const index = stack.map(node => node.tagName.toLowerCase()).lastIndexOf(close[1].toLowerCase());
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
    stack.at(-1).childNodes.push(node);
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
    title: findAll(root, node => node.tagName.toLowerCase() === "title")[0]?.textContent || "",
    body: body || { textContent: root.textContent },
    querySelector(selector) {
      if (selector === "#corePrice_feature_div") return findById("corePrice_feature_div");
      if (selector === "#ap_email") return findById("ap_email");
      if (selector === "#productTitle") return findById("productTitle");
      if (selector === "#apex-pricetopay-accessibility-label") return findById("apex-pricetopay-accessibility-label");
      throw new Error("Unexpected selector: " + selector);
    },
    querySelectorAll(selector) {
      if (selector === "form[action]") return findAll(root, node => node.tagName === "FORM" && node.getAttribute("action") !== null);
      if (selector === "p, label, h1, h2, h3") return findAll(root, node => ["P", "LABEL", "H1", "H2", "H3"].includes(node.tagName));
      if (selector === "#corePrice_feature_div .a-offscreen") {
        const core = findById("corePrice_feature_div");
        return core ? findAll(core, node => node.classList.contains("a-offscreen")) : [];
      }
      if (selector === "#apex-pricetopay-accessibility-label") {
        return findAll(root, node => node.id === "apex-pricetopay-accessibility-label");
      }
      if (/^#[\w-]+$/.test(selector)) return findAll(root, node => node.id === selector.slice(1));
      if (/^\.[\w-]+$/.test(selector)) return findAll(root, node => node.classList.contains(selector.slice(1)));
      throw new Error("Unexpected selector: " + selector);
    }
  };
}

const payableMarkup = (value, extra = "") => `<div id="desktop_qualifiedBuyBox"><div id="apex_offerDisplay_expanded"><div id="corePriceDisplay_desktop_feature_div"><div class="apex-core-price-identifier ${extra}"><span id="apex-pricetopay-accessibility-label">${value}</span></div></div></div></div>`;

test("normalizes Turkish TRY with separators, rejecting ambiguous or non-TRY text", () => {
  assert.equal(parseTurkishPrice("36.399,00TL"), 36399);
  assert.equal(parseTurkishPrice("₺ 1.234,50"), 1234.5);
  assert.equal(parseTurkishPrice("1.234,50\u00a0TL"), 1234.5);
  assert.equal(parseTurkishPrice("  194,74 TL  "), 194.74);
  assert.equal(parseTurkishPrice("194,74\u202fTL"), 194.74);
  for (const price of ["1,234.50 TL", "36.399 TL", "36.399,00 USD", "0,00TL", "1.23,00TL", "36.399,00 TL / ay", "36.399,00"]) {
    assert.equal(parseTurkishPrice(price), null, price);
  }
});

test("uses the uniquely identified payable-price label inside the observed main purchase region", () => {
  const doc = fixture(`<div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL")}`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 194.74 });
  const differentPrice = fixture(`<div id="corePrice_feature_div"></div>${payableMarkup("599,99 TL")}`);
  assert.deepEqual(extractPrimaryPrice(differentPrice), { status: "success", priceTry: 599.99 });
});

test("allows only DIV intermediaries in the recognized purchase-region hierarchy", () => {
  const accepted = fixture(`<div id="desktop_qualifiedBuyBox"><div><div id="apex_offerDisplay_expanded"><div id="corePriceDisplay_desktop_feature_div"><div class="apex-core-price-identifier"><div><span id="apex-pricetopay-accessibility-label">194,74 TL</span></div></div></div></div></div></div><div id="corePrice_feature_div"></div>`);
  const wrongOrder = fixture(`<div id="desktop_qualifiedBuyBox"><div id="corePriceDisplay_desktop_feature_div"><div id="apex_offerDisplay_expanded"><div class="apex-core-price-identifier"><span id="apex-pricetopay-accessibility-label">194,74 TL</span></div></div></div></div><div id="corePrice_feature_div"></div>`);
  const missingAnchor = fixture(`<div id="desktop_qualifiedBuyBox"><div id="apex_offerDisplay_expanded"><div class="apex-core-price-identifier"><span id="apex-pricetopay-accessibility-label">194,74 TL</span></div></div></div><div id="corePrice_feature_div"></div>`);
  const nonDivBridge = fixture(`<div id="desktop_qualifiedBuyBox"><section id="apex_offerDisplay_expanded"><div id="corePriceDisplay_desktop_feature_div"><div class="apex-core-price-identifier"><span id="apex-pricetopay-accessibility-label">194,74 TL</span></div></div></div></section></div><div id="corePrice_feature_div"></div>`);
  const duplicateAnchor = fixture(`<div id="desktop_qualifiedBuyBox"><div id="apex_offerDisplay_expanded"><div id="corePriceDisplay_desktop_feature_div"><div class="apex-core-price-identifier"><span id="apex-pricetopay-accessibility-label">194,74 TL</span></div></div></div></div><div id="desktop_qualifiedBuyBox"></div><div id="corePrice_feature_div"></div>`);
  assert.deepEqual(extractPrimaryPrice(accepted), { status: "success", priceTry: 194.74 });
  for (const rejected of [wrongOrder, missingAnchor, nonDivBridge, duplicateAnchor]) {
    assert.deepEqual(extractPrimaryPrice(rejected), { status: "failure", errorCode: "PRICE_MISSING" });
  }
});

test("keeps primary price authoritative when a qualified payable-price label is also present", () => {
  const doc = fixture(`<div id="corePrice_feature_div"><span class="a-offscreen">210,00 TL</span></div>${payableMarkup("194,74 TL")}`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 210 });
});

test("does not use payable-price fallback to override primary ambiguity or unrecognized text", () => {
  const ambiguous = fixture(`<div id="corePrice_feature_div"><span class="a-offscreen">210,00 TL</span><span class="a-offscreen">211,00 TL</span></div>${payableMarkup("194,74 TL")}`);
  const unrecognized = fixture(`<div id="corePrice_feature_div"><span class="a-offscreen">Fiyat için seçenekleri görün</span></div>${payableMarkup("194,74 TL")}`);
  assert.deepEqual(extractPrimaryPrice(ambiguous), { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
  assert.deepEqual(extractPrimaryPrice(unrecognized), { status: "failure", errorCode: "PRICE_UNRECOGNIZED" });
});

test("never uses the payable-price fallback on bot, access-denied, or authentication pages", () => {
  for (const html of [
    `<title>Robot Check</title><div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL")}`,
    `<title>Access Denied</title><div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL")}`,
    `<title>Amazon Sign-In</title><input id="ap_email"><div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL")}`
  ]) assert.notEqual(extractPrimaryPrice(fixture(html)).status, "success");
});

test("preserves HTML_STRUCTURE and PRICE_MISSING when no qualified fallback exists", () => {
  assert.deepEqual(extractPrimaryPrice(fixture(`<span id="apex-pricetopay-accessibility-label">194,74 TL</span>`)),
    { status: "failure", errorCode: "HTML_STRUCTURE" });
  assert.deepEqual(extractPrimaryPrice(fixture(`<div id="corePrice_feature_div"></div>`)),
    { status: "failure", errorCode: "PRICE_MISSING" });
});

test("fails safely for conflicting payable-price labels and ignores unqualified alternatives", () => {
  const multiple = fixture(`<div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL")}${payableMarkup("199,00 TL")}`);
  const unrelated = fixture(`<div id="corePrice_feature_div"></div><div class="recommendation">${payableMarkup("194,74 TL")}</div>`);
  assert.deepEqual(extractPrimaryPrice(multiple), { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
  assert.deepEqual(extractPrimaryPrice(unrelated), { status: "failure", errorCode: "PRICE_MISSING" });
});

test("rejects payable-price labels in unit-price, coupon, shipping, discount, installment, used, recommendation, and format contexts", () => {
  for (const context of ["apex-priceperunit", "coupon", "shipping", "discount", "installment", "used-offer", "recommendation", "alternative-format"]) {
    const doc = fixture(`<div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL", context)}`);
    assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_MISSING" }, context);
  }
});

test("rejects malformed and non-TRY fallback values without guessing", () => {
  for (const value of ["194,74 USD", "194.74 TL", "0,00 TL", "194,74 TL / ay", "194 TL", "price: 194,74 TL"]) {
    const doc = fixture(`<div id="corePrice_feature_div"></div>${payableMarkup(value)}`);
    assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_UNRECOGNIZED" }, value);
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

function enclosingOfferMarkup(labelMarkup, price) {
  return `<div class="a-accordion-row"><h5>${labelMarkup}</h5><div id="corePrice_feature_div"><span class="a-offscreen">${price}</span></div></div>`;
}

test("recognizes a new offer when its accordion row encloses the primary container", () => {
  const doc = fixture(enclosingOfferMarkup(
    '<span>Yenisini Satın Al</span><style>.offer { color: red }</style><div>Kullanılmış</div>',
    "51.399,00TL"
  ));
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 51399 });
});

test("rejects a recognized used offer in an enclosing accordion row", () => {
  const doc = fixture(enclosingOfferMarkup('<span>Kullanılmış ve yeni gibi</span>', "46.647,90TL"));
  assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_MISSING" });
});

test("accepts a single valid primary price when its accordion offer condition is unknown", () => {
  const doc = fixture(enclosingOfferMarkup(
    '<span>Satın alma seçenekleri</span><div>Yenisini Satın Al</div>',
    "51.399,00TL"
  ));
  assert.deepEqual(extractPrimaryPrice(doc), { status: "success", priceTry: 51399 });
});

test("multiple candidates with unknown offer conditions remain ambiguous", () => {
  const doc = fixture(`<div class="a-accordion-row"><h5><span>Satın alma seçenekleri</span></h5><div id="corePrice_feature_div"><span class="a-offscreen">51.399,00TL</span><span class="a-offscreen">46.647,90TL</span></div></div>`);
  assert.deepEqual(extractPrimaryPrice(doc), { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
});

test("an ordinary single-price page remains successful", () => {
  assert.deepEqual(extractPrimaryPrice(fixture('<div id="corePrice_feature_div"><span class="a-offscreen">51.399,00TL</span></div>')),
    { status: "success", priceTry: 51399 });
});

test("ambiguity callback identifies the primary-candidate parser branch with bounded counts", () => {
  const doc = fixture(`<div id="corePrice_feature_div">
    <div class="a-accordion-row"><h5>Yenisini Satın Al</h5><span class="a-offscreen">51.399,00TL</span></div>
    <div class="a-accordion-row"><h5>Kullanılmış</h5><span class="a-offscreen">46.647,90TL</span></div>
    <div class="a-accordion-row"><h5>Satın alma seçenekleri</h5><span class="a-offscreen">49.000,00TL</span></div>
  </div>`);
  let diagnostic;
  const result = extractPrimaryPrice(doc, value => { diagnostic = value; });
  assert.deepEqual(result, { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
  assert.deepEqual(diagnostic, {
    errorCode: "PRICE_AMBIGUOUS",
    source: "PRIMARY_MULTIPLE_UNKNOWN",
    primaryCandidateCount: 3,
    fallbackCandidateCount: 0,
    newOfferCount: 1,
    nonNewOfferCount: 1,
    unknownOfferCount: 1
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /51\.399|46\.647|49\.000|Yenisini|Kullanılmış/);
});

test("ambiguity callback identifies multiple fallback labels without changing parser result", () => {
  const doc = fixture(`<div id="corePrice_feature_div"></div>${payableMarkup("194,74 TL")}${payableMarkup("199,00 TL")}`);
  let diagnostic;
  const result = extractPrimaryPrice(doc, value => { diagnostic = value; });
  assert.deepEqual(result, { status: "failure", errorCode: "PRICE_AMBIGUOUS" });
  assert.deepEqual(diagnostic, {
    errorCode: "PRICE_AMBIGUOUS",
    source: "FALLBACK_MULTIPLE",
    primaryCandidateCount: 0,
    fallbackCandidateCount: 2,
    newOfferCount: 0,
    nonNewOfferCount: 0,
    unknownOfferCount: 0
  });
});

test("classifies bot checks, access denied, and sign-in pages before price extraction", () => {
  assert.deepEqual(extractPrimaryPrice(fixture('<title>Robot Check</title><p>Enter the characters you see below</p>')),
    { status: "failure", errorCode: "BOT_VERIFICATION" });
  assert.deepEqual(extractPrimaryPrice(fixture('<title>Access Denied</title>')),
    { status: "failure", errorCode: "ACCESS_DENIED" });
  assert.deepEqual(extractPrimaryPrice(fixture('<title>Amazon Sign-In</title><input id="ap_email">')),
    { status: "failure", errorCode: "AUTH_REQUIRED" });
});

test("a same-origin CAPTCHA form is verification even under a generic Turkish title", () => {
  const form = '<title>Amazon.com.tr</title><form action="/errors_page/validateCaptcha"><input name="amzn"></form>';
  assert.deepEqual(extractPrimaryPrice(fixture(form)), { status: "failure", errorCode: "BOT_VERIFICATION" });
  assert.deepEqual(extractPrimaryPrice(fixture('<p>Type the characters you see in this image</p>')),
    { status: "failure", errorCode: "BOT_VERIFICATION" });
  assert.deepEqual(extractPrimaryPrice(fixture('<form action="https://www.amazon.com.tr/errors_page/validateCaptcha?ref=robot"></form>')),
    { status: "failure", errorCode: "BOT_VERIFICATION" });
  for (const action of ["https://evil.example/errors_page/validateCaptcha", "/errors_page/validateCaptchaExtra", "//evil.example/errors_page/validateCaptcha", "/other/validateCaptcha", "/foo/../errors_page/validateCaptcha"]) {
    assert.deepEqual(extractPrimaryPrice(fixture(`<form action="${action}"></form>`)), { status: "failure", errorCode: "HTML_STRUCTURE" });
  }
});

test("incidental CAPTCHA script text and buying options cannot invent a primary price", () => {
  const normal = '<title>SteelSeries</title><span id="productTitle">SteelSeries Arctis</span><div id="buyingOptions_feature_div">Diğer satın alma seçenekleri</div><script>captcha helper</script>';
  assert.deepEqual(extractPrimaryPrice(fixture(normal)), { status: "failure", errorCode: "HTML_STRUCTURE" });
  assert.deepEqual(extractPrimaryPrice(fixture(normal + '<div id="corePrice_feature_div"><span class="a-offscreen">800,00 TL</span></div>')),
    { status: "success", priceTry: 800 });
  assert.deepEqual(extractPrimaryPrice(fixture('<script>captcha required</script><div id="corePrice_feature_div"><span class="a-offscreen">800,00 TL</span></div>')),
    { status: "success", priceTry: 800 });
});

test("extracts only a validated, normalized product title from the targeted title node", () => {
  assert.equal(extractProductTitle(fixture('<span id="productTitle">  DJI   Lito X1 <b>Fly More</b> </span>')), "DJI Lito X1 Fly More");
  assert.equal(extractProductTitle(fixture('<span id="productTitle"> \u0000 </span>')), null);
  assert.equal(extractProductTitle(fixture(`<span id="productTitle">${"x".repeat(201)}</span>`)), null);
  assert.equal(extractProductTitle(fixture('<span class="recommendation-title">Önerilen ürün</span>')), null);
});
