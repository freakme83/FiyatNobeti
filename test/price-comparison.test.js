import test from "node:test";
import assert from "node:assert/strict";
import { createProductRecord, establishFirstBaseline, normalizeWatchlist, priceCents } from "../src/watchlist.js";
import { compareWithBaseline } from "../src/price-comparison.js";
import { createProductRow } from "../src/watchlist-view.js";

const asin = "B0D47HCRZ6";
const url = `https://www.amazon.com.tr/dp/${asin}`;
const stamp = "2026-10-23T10:00:00.000Z";
const product = () => createProductRecord({ asin, canonicalUrl: url, addedAt: "2026-10-20T10:00:00.000Z" });

function rowText(record) {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this[name] = value; }
  }
  const row = createProductRow({ createElement: tagName => new Element(tagName), createElementNS: (_ns, tagName) => new Element(tagName) }, record);
  const collect = element => [element.textContent, ...element.children.map(collect)].join(" | ");
  return { row, text: collect(row) };
}

test("first valid success fixes a baseline and later observations cannot replace it", () => {
  const record = product();
  for (const price of [null, 0, -1, NaN, Infinity, 1000.001, Number.MAX_VALUE]) establishFirstBaseline(record, price, stamp);
  assert.equal(record.baselineSource, null);
  establishFirstBaseline(record, 1000, "invalid date");
  assert.equal(record.baselineSource, null);
  establishFirstBaseline(record, 1000, stamp);
  establishFirstBaseline(record, 800, "2026-10-24T10:00:00.000Z");
  assert.deepEqual([record.baselinePriceTry, record.baselineCheckedAt, record.baselineSource], [1000, stamp, "first"]);
  assert.equal(priceCents(1000.01), 100001);
});

test("lower, higher, unchanged and tiny cent-exact prices render visible Turkish comparisons", () => {
  const record = product();
  establishFirstBaseline(record, 1000, stamp);
  record.lastCheckStatus = "success";
  record.lastSuccessfulPriceTry = 800;
  assert.deepEqual(compareWithBaseline(record), {
    direction: -1, headline: "↓ %20 daha ucuz",
    detail: "İlk fiyatından beri ₺200,00 daha ucuz", baselineText: "₺1.000,00"
  });
  let visible = rowText(record);
  assert.match(visible.text, /Başlangıç: ₺1\.000,00/);
  assert.ok(visible.row.children.some(child => child.className === "product-comparison decrease"));
  record.lastSuccessfulPriceTry = 1350;
  assert.match(rowText(record).text, /↑ %35 daha pahalı.*₺350,00 daha pahalı/);
  assert.ok(rowText(record).row.children.some(child => child.className === "product-comparison increase"));
  record.lastSuccessfulPriceTry = 1000;
  const unchanged = rowText(record);
  assert.doesNotMatch(unchanged.row.children.map(child => child.className).join(" "), /product-comparison/);
  assert.match(unchanged.text, /İlk fiyatıyla aynı/);
  establishFirstBaseline(record, 0.01, stamp); // Existing reference remains immutable.
  record.baselinePriceTry = 999999999.99;
  record.lastSuccessfulPriceTry = 999999999.98;
  assert.match(compareWithBaseline(record).headline, /%0,01'den az/);
  assert.doesNotMatch(rowText(record).text, /NaN|Infinity|%0 daha/);
});

test("migrated reference names the saved observation and does not imply the addition date", () => {
  const old = product();
  old.lastSuccessfulPriceTry = 1000;
  old.lastSuccessfulCheckAt = stamp;
  old.lastCheckStatus = "failure";
  const migrated = normalizeWatchlist({ version: 1, products: { [asin]: old } });
  const record = migrated.products[asin];
  assert.equal(migrated.version, 2);
  assert.deepEqual([record.baselinePriceTry, record.baselineCheckedAt, record.baselineSource], [1000, stamp, "migrated"]);
  assert.deepEqual(normalizeWatchlist(migrated), migrated);
  record.lastSuccessfulPriceTry = 800;
  const visible = rowText(record).text;
  assert.match(visible, /Referans \(geçişteki son fiyat\): ₺1\.000,00/);
  assert.match(visible, /Son kontrol başarısız/);
  assert.match(visible, /Son kontrol başarısız/);
  assert.doesNotMatch(visible, /Başlangıç:/);
});

test("invalid legacy data waits; corrupt version 2 data cannot silently reset a reference", () => {
  for (const invalid of [undefined, 0, -5, 1000.001, Infinity]) {
    const old = product();
    old.lastSuccessfulPriceTry = invalid;
    const migrated = normalizeWatchlist({ version: 1, products: { [asin]: old } });
    assert.equal(migrated.products[asin].baselineSource, null);
    assert.equal(compareWithBaseline(migrated.products[asin]), null);
  }
  const old = product();
  old.lastSuccessfulPriceTry = 1000;
  old.lastSuccessfulCheckAt = "invalid";
  const migrated = normalizeWatchlist({ version: 1, products: { [asin]: old } });
  assert.equal(migrated.products[asin].baselineCheckedAt, null);
  assert.match(rowText(migrated.products[asin]).text, /tarih bilinmiyor/);
  migrated.products[asin].baselinePriceTry = -1;
  assert.throws(() => normalizeWatchlist(migrated), /WATCHLIST_UNSUPPORTED_VERSION/);
});
