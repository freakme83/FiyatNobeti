import test from "node:test";
import assert from "node:assert/strict";
import { createProductRow, renderProductRows } from "../src/watchlist-view.js";

const asin = "B0D47HCRZ6";
const stamp = "2026-10-23T10:00:00.000Z";
class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this[name] = value; }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector(selector) {
    if (selector === ".product-details") return this.children.flatMap(child => [child, ...child.children]).find(child => child.className === "product-details") || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === ".product") return this.children.filter(child => child.className === "product");
    return [];
  }
}
const doc = { createElement: tagName => new Element(tagName), createElementNS: (_ns, tagName) => new Element(tagName) };
function product(overrides = {}) {
  const record = {
    asin, title: "Example product", addedAt: stamp, lastSuccessfulPriceTry: 1000,
    lastSuccessfulCheckAt: stamp, lastAttemptedCheckAt: stamp, lastCheckStatus: "success",
    lastErrorCode: null, baselinePriceTry: 1000, baselineCheckedAt: stamp, baselineSource: "first",
    canonicalUrl: `https://www.amazon.com.tr/dp/${asin}`,
    ...overrides
  };
  return record;
}
function text(node) { return [node.textContent, ...node.children.map(text)].join(" "); }
function topLevelText(row) { return row.children.filter(child => child.tagName !== "div").map(text).join(" "); }

test("closed product row keeps history and unchanged comparison only inside the popover", () => {
  const row = createProductRow(doc, product());
  const closedText = topLevelText(row);
  assert.match(closedText, /Example product/);
  assert.match(closedText, /Son başarılı fiyat/);
  assert.doesNotMatch(closedText, /B0D47HCRZ6|Başlangıç:|Başarılı kontrol:|Son deneme:|İlk fiyatıyla aynı/);
  const details = row.children.at(-1).children.at(-1);
  assert.equal(details.tagName, "div");
  assert.equal(details.popover, "manual");
  assert.match(text(details), /B0D47HCRZ6|Başlangıç:|Başarılı kontrol:|Son deneme:|İlk fiyatıyla aynı/);
});

test("changed price shows percentage on closed row; failure warning is short while error detail stays expandable", () => {
  const changed = product({ lastSuccessfulPriceTry: 800 });
  assert.match(topLevelText(createProductRow(doc, changed)), /%20 daha ucuz/);
  const failed = product({ lastCheckStatus: "failure", lastErrorCode: "NETWORK_ERROR" });
  const row = createProductRow(doc, failed);
  assert.match(topLevelText(row), /Son kontrol başarısız/);
  assert.doesNotMatch(topLevelText(row), /ağ isteği başarısız/);
  assert.match(text(row.children.at(-1).children.at(-1)), /ağ isteği başarısız/);
});

test("compact actions are independent of the popover; order buttons appear only in custom mode", () => {
  const normal = createProductRow(doc, product());
  const normalActions = normal.children.at(-1);
  assert.deepEqual(normalActions.children.map(child => child.tagName), ["div", "button", "div"]);
  assert.deepEqual(normalActions.children[0].children.map(button => button.dataset.action), ["check", "remove"]);
  assert.equal(normalActions.children[0].children[0].children[0].tagName, "svg");
  assert.equal(normalActions.children[0].children[1].children[0].tagName, "svg");
  assert.equal(normalActions.children[0].children[1].ariaLabel, "Listeden kaldır");
  assert.equal(normalActions.children[1].dataset.action, "details");
  const custom = createProductRow(doc, product(), { customOrder: true, index: 0, count: 2 });
  assert.deepEqual(custom.children.at(-1).children[0].children.map(button => button.dataset.action), ["move-up", "move-down"]);
  assert.equal(custom.children.at(-1).children[0].children[0].disabled, true);
});

test("list rerenders create distinct product-bound popovers", () => {
  const list = new Element("ul");
  const empty = { hidden: false };
  const products = { [asin]: product(), B0D47HCRZ7: product({ asin: "B0D47HCRZ7" }) };
  renderProductRows(doc, list, products, empty);
  const oldPanel = list.children[0].querySelector(".product-details");
  renderProductRows(doc, list, products, empty);
  assert.notEqual(list.children[0].querySelector(".product-details"), oldPanel);
  const remaining = { B0D47HCRZ7: products.B0D47HCRZ7 };
  renderProductRows(doc, list, remaining, empty);
  assert.equal(list.children[0].dataset.asin, "B0D47HCRZ7");
  assert.equal(list.children[0].querySelector(".product-details").id, "product-details-B0D47HCRZ7");
});
