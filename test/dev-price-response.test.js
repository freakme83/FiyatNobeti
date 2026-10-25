import test from "node:test";
import assert from "node:assert/strict";
import { extractPrimaryPrice } from "../src/price.js";
import { inspectPriceDocument } from "../scripts/dev-price-response.js";

const LABEL_ID = "apex-pricetopay-accessibility-label";

function element(tagName, { id = "", classes = [], textContent = "" } = {}) {
  const children = [];
  const node = {
    tagName: tagName.toUpperCase(),
    id,
    textContent,
    parentElement: null,
    children,
    classList: {
      get length() { return classes.length; },
      item(index) { return classes[index] ?? null; },
      contains(value) { return classes.includes(value); }
    },
    append(child) {
      child.parentElement = node;
      children.push(child);
      return child;
    },
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === node) return true;
      }
      return false;
    },
    querySelectorAll(selector) {
      if (selector !== ".a-offscreen") throw new Error(`unexpected nested selector ${selector}`);
      return allDescendants(node).filter(child => child.classList.item && Array.from({length: child.classList.length}, (_, i) => child.classList.item(i)).includes("a-offscreen"));
    }
  };
  return node;
}

function allDescendants(node) {
  return node.children.flatMap(child => [child, ...allDescendants(child)]);
}

function fixture({ labelTrees = [], primaryPriceTexts = [], outsidePrices = [], pageTitle = "Amazon", bodyText = "", productTitle = "Private product title" } = {}) {
  const root = element("html");
  const core = element("div", { id: "corePrice_feature_div" });
  root.append(core);
  for (const makeTree of labelTrees) makeTree({ root, core });
  for (const value of primaryPriceTexts) core.append(element("span", { classes: ["a-offscreen"], textContent: value }));
  for (const value of outsidePrices) root.append(element("span", { classes: ["a-price", "a-offscreen"], textContent: value }));
  const labels = allDescendants(root).filter(node => node.id === LABEL_ID);
  const primaryCandidates = allDescendants(core).filter(node => {
    for (let index = 0; index < node.classList.length; index++) if (node.classList.item(index) === "a-offscreen") return true;
    return false;
  });
  const doc = {
    title: pageTitle,
    body: { textContent: bodyText },
    querySelector(selector) {
      if (selector === "#corePrice_feature_div") return core;
      if (selector === "#productTitle") return productTitle === null ? null : { textContent: productTitle };
      if (selector === "title") return { textContent: pageTitle };
      if (selector === "#ap_email") return null;
      throw new Error(`unexpected selector ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === "form[action]" || selector === "p, label, h1, h2, h3") return [];
      if (selector === "#corePrice_feature_div .a-offscreen") return primaryCandidates;
      if (selector === ".a-price .a-offscreen") return [...primaryCandidates, ...allDescendants(root).filter(node => {
        for (let index = 0; index < node.classList.length; index++) if (node.classList.item(index) === "a-offscreen") return true;
        return false;
      })];
      if (selector === `#${LABEL_ID}`) return labels;
      if (/^#[\w-]+$/.test(selector)) return allDescendants(root).filter(node => node.id === selector.slice(1));
      if (/^\.[\w-]+$/.test(selector)) return allDescendants(root).filter(node => {
        for (let index = 0; index < node.classList.length; index++) if (node.classList.item(index) === selector.slice(1)) return true;
        return false;
      });
      throw new Error(`unexpected selector ${selector}`);
    }
  };
  return { doc, core, root, labels };
}

const makeLabel = (location, { wrapperId = "", wrapperClasses = [], labelTag = "span", labelClasses = [], labelText = "" } = {}) => ({ root, core }) => {
  const wrapper = element("div", { id: wrapperId, classes: wrapperClasses });
  const label = wrapper.append(element(labelTag, { id: LABEL_ID, classes: labelClasses, textContent: labelText }));
  (location === "inside" ? core : root).append(wrapper);
  return label;
};

const makeQualifiedLabel = (location, { extraClasses = [], labelTag = "span", labelText = "" } = {}) => ({ root, core }) => {
  const parent = location === "inside" ? core : root;
  const desktop = parent.append(element("div", { id: "desktop_qualifiedBuyBox" }));
  const offer = desktop.append(element("div", { id: "apex_offerDisplay_expanded" }));
  const price = offer.append(element("div", { id: "corePriceDisplay_desktop_feature_div" }));
  const identifier = price.append(element("div", { classes: ["apex-core-price-identifier", ...extraClasses] }));
  return identifier.append(element(labelTag, { id: LABEL_ID, textContent: labelText }));
};

test("reports capped label count, primary containment, tag, and bounded ancestry", () => {
  const { doc } = fixture({ labelTrees: [
    makeQualifiedLabel("inside", { labelText: "194,74 TL" })
  ] });
  const report = inspectPriceDocument(doc);
  assert.equal(report.alternatives.apexPriceToPayLabelCount, 1);
  const [label] = report.alternatives.apexPriceToPay.elements;
  assert.equal(label.insidePrimaryContainer, true);
  assert.equal(label.tagName, "span");
  assert.deepEqual(label.ancestry.map(item => item.tagName), ["span", "div", "div", "div", "div", "div", "html"]);
  assert.equal(label.ancestryTruncated, false);
  assert.equal(label.nearbyPriceRegion.identified, true);
  assert.equal(label.nearbyPriceRegion.kind, "MAIN_PURCHASE_PRICE_REGION");
  assert.equal(label.fallback.wouldQualify, true);
  assert.equal(label.fallback.rejectionReason, null);
});

test("reports the observed qualified purchase region even when it is outside the primary container", () => {
  const { doc } = fixture({ labelTrees: [makeQualifiedLabel("outside", { labelText: "194,74 TL" })] });
  const report = inspectPriceDocument(doc);
  const [label] = report.alternatives.apexPriceToPay.elements;
  assert.equal(label.insidePrimaryContainer, false);
  assert.equal(label.fallback.wouldQualify, true);
  assert.equal(label.fallback.rejectionReason, null);
});

test("marks every candidate ambiguous when multiple payable-price labels exist", () => {
  const { doc } = fixture({ labelTrees: [makeLabel("inside"), makeLabel("outside")] });
  const report = inspectPriceDocument(doc);
  assert.equal(report.alternatives.apexPriceToPayLabelCount, 2);
  assert.deepEqual(report.alternatives.apexPriceToPay.elements.map(item => item.fallback.rejectionReason), ["MULTIPLE_LABELS", "MULTIPLE_LABELS"]);
});

test("reports element-tag and unparseable-TRY rejection reasons without returning candidate text", () => {
  const wrongTag = fixture({ labelTrees: [makeLabel("inside", { labelTag: "div", labelText: "194,74 TL" })] });
  const invalidAmount = fixture({ labelTrees: [makeQualifiedLabel("outside", { labelText: "194,74 TL / ay" })] });
  const wrong = inspectPriceDocument(wrongTag.doc).alternatives.apexPriceToPay.elements[0];
  const invalid = inspectPriceDocument(invalidAmount.doc).alternatives.apexPriceToPay.elements[0];
  assert.equal(wrong.fallback.rejectionReason, "WRONG_ELEMENT_TAG");
  assert.equal(invalid.fallback.rejectionReason, "UNRECOGNIZED_TRY_AMOUNT");
  assert.equal(JSON.stringify(invalid).includes("194,74 TL / ay"), false);
});

test("reports a missing label with an empty inspected list", () => {
  const { doc } = fixture();
  const report = inspectPriceDocument(doc);
  assert.equal(report.alternatives.apexPriceToPayLabelCount, 0);
  assert.deepEqual(report.alternatives.apexPriceToPay.elements, []);
});

test("identifies recognized payable-price and purchase ancestry using exact allowlisted tokens", () => {
  const { doc } = fixture({ labelTrees: [makeQualifiedLabel("outside", { labelText: "194,74 TL" })] });
  const label = inspectPriceDocument(doc).alternatives.apexPriceToPay.elements[0];
  assert.equal(label.nearbyPriceRegion.identified, true);
  assert.equal(label.nearbyPriceRegion.kind, "MAIN_PURCHASE_PRICE_REGION");
  assert.deepEqual(label.nearbyPriceRegion.tokens, [
    "id:corePriceDisplay_desktop_feature_div",
    "id:apex_offerDisplay_expanded",
    "id:desktop_qualifiedBuyBox"
  ]);
});

test("reports unrecognized ancestry without exposing unknown IDs or classes", () => {
  const secretId = "address-order-839201";
  const secretClass = "customer-session-4f88b2";
  const { doc } = fixture({ labelTrees: [makeLabel("inside", { wrapperId: secretId, wrapperClasses: [secretClass] })] });
  const report = inspectPriceDocument(doc);
  const label = report.alternatives.apexPriceToPay.elements[0];
  assert.equal(label.nearbyPriceRegion.identified, true);
  assert.equal(label.nearbyPriceRegion.kind, "PRIMARY_PRICE_CONTAINER");
  assert.ok(label.ancestry.some(item => item.id === "redacted"));
  assert.ok(label.ancestry.some(item => item.redactedClassCount > 0));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${secretId}|${secretClass}`));
});

test("detects PR #8 excluded unit-price and recommendation contexts", () => {
  for (const classes of [["apex-priceperunit"], ["recommendation"]]) {
    const { doc } = fixture({ labelTrees: [makeLabel("inside", { wrapperClasses: classes })] });
    const label = inspectPriceDocument(doc).alternatives.apexPriceToPay.elements[0];
    assert.equal(label.insideExcludedContext, true);
    assert.equal(label.fallback.wouldQualify, false);
    assert.equal(label.fallback.rejectionReason, "EXCLUDED_CONTEXT");
  }
});

test("caps ancestry traversal and reports indeterminate qualification when truncated", () => {
  const deepTree = ({ root, core }) => {
    let current = core;
    for (let index = 0; index < 40; index++) current = current.append(element("div"));
    current.append(element("span", { id: LABEL_ID }));
  };
  const { doc } = fixture({ labelTrees: [deepTree] });
  const label = inspectPriceDocument(doc).alternatives.apexPriceToPay.elements[0];
  assert.equal(label.ancestry.length, 8);
  assert.equal(label.ancestryTruncated, true);
  assert.equal(label.fallback.wouldQualify, null);
  assert.equal(label.fallback.rejectionReason, "ANCESTRY_DEPTH_LIMIT");
});

test("caps label count, ancestor class scanning, and redacted token counts", () => {
  const labels = Array.from({ length: 105 }, (_, index) => makeLabel("inside", {
    wrapperId: `private-${index}`,
    wrapperClasses: Array.from({ length: 140 }, (_, n) => `private-class-${n}`)
  }));
  const { doc } = fixture({ labelTrees: labels });
  const alternatives = inspectPriceDocument(doc).alternatives;
  const details = alternatives.apexPriceToPay;
  assert.equal(alternatives.apexPriceToPayLabelCount, 100);
  assert.equal(alternatives.apexPriceToPayCountCapped, true);
  assert.equal(details.elements.length, 3);
  assert.equal(details.inspectionTruncated, true);
  assert.equal(details.elements[0].fallback.rejectionReason, "MULTIPLE_LABELS");
  assert.equal(details.elements[0].ancestry[1].classListTruncated, true);
  assert.equal(details.elements[0].ancestry[1].redactedClassCount, 100);
  assert.doesNotMatch(JSON.stringify(details), /private-class|private-0/);
});

test("caps candidate inspection and structural tokens", () => {
  const labels = Array.from({ length: 5 }, (_, index) => makeLabel("inside", { wrapperId: `private-${index}`, wrapperClasses: Array.from({ length: 20 }, (_, n) => `private-class-${n}`) }));
  const { doc } = fixture({ labelTrees: labels });
  const details = inspectPriceDocument(doc).alternatives.apexPriceToPay;
  assert.equal(details.elements.length, 3);
  assert.equal(details.inspectionTruncated, true);
  assert.ok(details.elements.every(item => item.ancestry.every(node => node.recognizedClassTokens.length <= 8)));
});

test("diagnostic output contains no page text, price, URL, form value, or personal data", () => {
  const { doc } = fixture({
    labelTrees: [makeLabel("outside", { wrapperId: "customer-jane@example.com", wrapperClasses: ["shipping-address-123"] })],
    outsidePrices: ["194,74 TL"],
    productTitle: "Private book title",
    bodyText: "Shipping to Jane Doe, Ankara",
    pageTitle: "https://www.amazon.com.tr/dp/B0CQXKXBR7"
  });
  const report = inspectPriceDocument(doc);
  const serialized = JSON.stringify(report);
  for (const privateValue of ["194,74", "Private book title", "Jane Doe", "Ankara", "B0CQXKXBR7", "customer-jane@example.com", "shipping-address-123"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("diagnostic inspection does not change production parser outcomes", () => {
  const qualified = fixture({ labelTrees: [makeQualifiedLabel("outside", { labelText: "194,74 TL" })], primaryPriceTexts: [] });
  const rejected = fixture({ labelTrees: [makeLabel("outside")], primaryPriceTexts: [] });
  const primary = fixture({ labelTrees: [makeLabel("outside")], primaryPriceTexts: ["599,99 TL"] });
  const outcomes = [qualified, rejected, primary].map(({ doc }) => {
    inspectPriceDocument(doc);
    return extractPrimaryPrice(doc);
  });
  assert.deepEqual(outcomes, [
    { status: "success", priceTry: 194.74 },
    { status: "failure", errorCode: "PRICE_MISSING" },
    { status: "success", priceTry: 599.99 }
  ]);
});

test("diagnostic inspector recognizes bot page classification without returning page text", () => {
  const { doc } = fixture({ pageTitle: "Robot Check", bodyText: "captcha required", productTitle: null });
  const report = inspectPriceDocument(doc);
  assert.equal(report.securityPageSuspected, true);
  assert.equal(report.recognizableProductTitle, false);
  assert.doesNotMatch(JSON.stringify(report), /captcha|Robot Check/);
});
