import test from "node:test";
import assert from "node:assert/strict";
import { inspectPriceDocument } from "../scripts/dev-price-response.js";

function fixture({ primary = [], outside = [], apex = 0, title = "Ürün", pageTitle = "Amazon", body = "" } = {}) {
  const nodes = values => values.map(textContent => ({ textContent, parentElement: null }));
  const coreNodes = nodes(primary);
  const outsideNodes = nodes(outside);
  const core = {
    querySelectorAll(selector) {
      assert.equal(selector, ".a-offscreen");
      return coreNodes;
    },
    contains(node) { return coreNodes.includes(node); }
  };
  return {
    title: pageTitle,
    body: { textContent: body },
    querySelector(selector) {
      if (selector === "#corePrice_feature_div") return core;
      if (selector === "#productTitle") return title === null ? null : { textContent: title };
      if (selector === "title") return { textContent: pageTitle };
      if (selector === "#ap_email") return null;
      throw Error(`unexpected ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === "#corePrice_feature_div .a-offscreen") return coreNodes;
      if (selector === ".a-price .a-offscreen") return [...coreNodes, ...outsideNodes];
      if (selector === "#apex-pricetopay-accessibility-label") return Array(apex).fill({});
      throw Error(`unexpected ${selector}`);
    }
  };
}

test("diagnostic inspector counts alternative structures but returns no prices or page text", () => {
  const report = inspectPriceDocument(fixture({ primary: [], outside: ["194,74TL"], apex: 1, title: "Private book title" }));
  assert.equal(report.primaryContainerPresent, true);
  assert.equal(report.primaryCandidateCount, 0);
  assert.equal(report.recognizableProductTitle, true);
  assert.equal(report.alternatives.apexPriceToPayLabelCount, 1);
  assert.equal(report.alternatives.priceOffscreenOutsidePrimaryCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /194,74|Private book title/);
});

test("diagnostic inspector recognizes bot page classification without raw page text", () => {
  const report = inspectPriceDocument(fixture({ pageTitle: "Robot Check", body: "captcha required", title: null }));
  assert.equal(report.securityPageSuspected, true);
  assert.equal(report.recognizableProductTitle, false);
  assert.doesNotMatch(JSON.stringify(report), /captcha|Robot Check/);
});
