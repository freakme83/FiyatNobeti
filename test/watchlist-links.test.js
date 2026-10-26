import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProductRow } from "../src/watchlist-view.js";

const asin = "B0D47HCRZ6";
const canonicalUrl = `https://www.amazon.com.tr/dp/${asin}`;

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
}

function render(overrides = {}) {
  const product = {
    asin, canonicalUrl, title: "Example product", addedAt: "2026-10-24T10:00:00.000Z",
    lastSuccessfulPriceTry: null, lastSuccessfulCheckAt: null,
    lastAttemptedCheckAt: null, lastCheckStatus: "never", lastErrorCode: null,
    ...overrides
  };
  return createProductRow({ createElement: tagName => new Element(tagName), createElementNS: (_ns, tagName) => new Element(tagName) }, product);
}

test("a known title is a native new-tab link to the canonical identity URL", () => {
  const row = render({ canonicalUrl: "https://evil.example/redirect?target=amazon" });
  const heading = row.children[0];
  const link = heading.children[0];
  assert.equal(heading.tagName, "h3");
  assert.equal(link.tagName, "a");
  assert.equal(link.textContent, "Example product");
  assert.equal(link.title, "Example product");
  assert.equal(link.href, canonicalUrl);
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(row.children.at(-1).children.at(-1).children[0].children[0].textContent, asin);
});

test("a missing title gets the same clickable fallback", () => {
  const link = render({ title: null }).children[0].children[0];
  assert.equal(link.tagName, "a");
  assert.equal(link.textContent, "Amazon ürünü");
  assert.equal(link.href, canonicalUrl);
});

test("unsafe identity data cannot produce an external link, and untrusted titles remain text", () => {
  const untrusted = '<img src=x onerror="alert(1)">';
  const link = render({ title: untrusted, canonicalUrl: "javascript:alert(1)" }).children[0].children[0];
  assert.equal(link.textContent, untrusted);
  assert.deepEqual(link.children, []);
  assert.equal(link.href, canonicalUrl);
  for (const invalid of ["https://www.amazon.com.tr/dp/B0D47HCRZ6", "B0D47HCRZ!", "B0D47HCRZ6<script>", null]) {
    const heading = render({ asin: invalid, canonicalUrl: "https://evil.example/" }).children[0];
    assert.equal(heading.children.length, 0);
    assert.equal(heading.textContent, "Example product");
  }
});

test("the title link is independent of the existing check and remove controls", async () => {
  const row = render();
  const actions = row.children.at(-1);
  assert.equal(actions.className, "product-actions");
  const [group, detailsButton, details] = actions.children;
  assert.equal(group.className, "product-action-group");
  assert.deepEqual(group.children.map(button => [button.tagName, button.type, button.dataset.action, button.dataset.asin]), [
    ["button", "button", "check", asin], ["button", "button", "remove", asin]
  ]);
  assert.equal(group.children[0].ariaLabel, "Fiyatı kontrol et");
  assert.equal(group.children[0].children[0].tagName, "svg");
  assert.equal(group.children[0].children[0]["aria-hidden"], "true");
  assert.equal(group.children[0].children[1].textContent, "Kontrol et");
  assert.equal(group.children[1].children[0].tagName, "svg");
  assert.equal(group.children[1].children[0]["aria-hidden"], "true");
  assert.equal(group.children[1].ariaLabel, "Listeden kaldır");
  assert.equal(detailsButton.tagName, "button");
  assert.equal(detailsButton.className, "product-details-trigger");
  assert.equal(detailsButton.children[0].textContent, "Ayrıntılar");
  assert.equal(detailsButton.children[1].tagName, "svg");
  assert.equal(detailsButton["aria-controls"], details.id);
  assert.equal(detailsButton["aria-expanded"], "false");
  assert.equal(details.popover, "manual");
  assert.equal(row.children[0].children[0].dataset.action, undefined);
  const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content;\s*column-gap:\s*14px/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.product-actions \.product-check\s*\{[^}]*white-space:\s*nowrap;/);
  assert.match(css, /\.product-actions \.remove\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/);
});

test("long and short product titles remain intact alongside the price column", () => {
  const cases = [
    ["DJI Lito X1 Fly More Combo (DJI RC 2)", 36399],
    ["Apple AirPods Pro 3 Kablosuz Kulaklık, Aktif Gürültü Engelleme, Kalp Atış Hızı Algılama, Bluetooth Kulaklık, Uzamsal Ses, Yüksek Ses Kalitesi, USB-C ile Şarj", 11399],
    ["Kuzenler", 500]
  ];
  for (const [title, price] of cases) {
    const row = render({ title, lastSuccessfulPriceTry: price, lastCheckStatus: "success" });
    const link = row.children[0].children[0];
    const details = row.children.at(-1).children.at(-1);
    assert.equal(link.textContent, title);
    assert.equal(link.title, title);
    assert.equal(row.children.find(child => child.className === "product-price").textContent,
      new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(price));
    assert.equal(details.children[0].children.find(child => child.className === "product-full-title").textContent, title);
  }
});

test("custom-order controls remain separate from the unified product action row", () => {
  const customRow = createProductRow({
    createElement: tagName => new Element(tagName),
    createElementNS: (_ns, tagName) => new Element(tagName)
  }, {
    asin, canonicalUrl, title: "Kuzenler", lastSuccessfulPriceTry: null,
    lastSuccessfulCheckAt: null, lastAttemptedCheckAt: null, lastCheckStatus: "never"
  }, { customOrder: true, index: 0, count: 2 });
  const actions = customRow.children.at(-1);
  assert.equal(actions.children[0].className, "product-order-actions");
  assert.deepEqual(actions.children[0].children.map(button => [button.dataset.action, button.dataset.asin]), [
    ["move-up", asin], ["move-down", asin]
  ]);
  assert.equal(actions.children[1].className, "product-action-group");
  assert.equal(actions.children[2].dataset.action, "details");
});
