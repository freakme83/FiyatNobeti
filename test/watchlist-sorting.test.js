import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SORT_MODE_KEY, CUSTOM_ORDER_KEY, DEFAULT_SORT_MODE, SORT_MODES,
  sortWatchlistProducts, normalizeCustomOrder, normalizeSortMode,
  reconcileCustomOrder, moveCustomProduct, createWatchlistSorting
} from "../src/watchlist-sorting.js";
import { createProductRow } from "../src/watchlist-view.js";

const ids = ["B0D47HCRZ6", "B0CQXKXBR7", "B0FZ9Y4GPF", "B0CYLSLBW4"];
const product = (asin, addedAt, price, extra = {}) => ({ asin, addedAt, lastSuccessfulPriceTry: price,
  title: asin, lastCheckStatus: "success", lastAttemptedCheckAt: null, lastSuccessfulCheckAt: null, ...extra });
const products = () => ({
  [ids[0]]: product(ids[0], "2026-10-20T00:00:00Z", 100),
  [ids[1]]: product(ids[1], "2026-10-22T00:00:00Z", 50),
  [ids[2]]: product(ids[2], "2026-10-21T00:00:00Z", 50),
  [ids[3]]: product(ids[3], "2026-10-23T00:00:00Z", null, { lastCheckStatus: "failure" })
});
const visible = (records) => records.map(record => record.asin);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function storage(initial = {}, hooks = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data, writes,
    async get(keys) {
      if (hooks.get) await hooks.get();
      return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])]));
    },
    async set(value) {
      writes.push(structuredClone(value));
      if (hooks.set) await hooks.set(value, writes.length);
      Object.assign(data, structuredClone(value));
    }
  };
}

test("five modes sort numeric prices, invalid dates, ties and missing prices without mutating products", () => {
  const items = products();
  const before = structuredClone(items);
  assert.deepEqual(SORT_MODES, ["custom", "added-newest", "added-oldest", "price-lowest", "price-highest"]);
  assert.deepEqual(visible(sortWatchlistProducts(items)), [ids[3], ids[1], ids[2], ids[0]]);
  assert.deepEqual(visible(sortWatchlistProducts(items, "added-oldest")), [ids[0], ids[2], ids[1], ids[3]]);
  assert.deepEqual(visible(sortWatchlistProducts(items, "price-lowest")), [ids[1], ids[2], ids[0], ids[3]]);
  assert.deepEqual(visible(sortWatchlistProducts(items, "price-highest")), [ids[0], ids[1], ids[2], ids[3]]);
  assert.deepEqual(visible(sortWatchlistProducts(items, "custom", [ids[0], ids[3], ids[2], ids[1]])), [ids[0], ids[3], ids[2], ids[1]]);
  items[ids[0]].addedAt = "bad date";
  items[ids[1]].lastSuccessfulPriceTry = 100;
  assert.deepEqual(visible(sortWatchlistProducts(items, "added-oldest")), [ids[2], ids[1], ids[3], ids[0]]);
  assert.deepEqual(visible(sortWatchlistProducts(items, "price-highest")), [ids[1], ids[0], ids[2], ids[3]]);
  assert.deepEqual(before, products());
});

test("price sorting ignores unverified candidate amounts", () => {
  const items = products();
  items[ids[3]].unverifiedPriceCandidates = { status: "unverified", checkedAt: "2026-10-23T00:00:00Z", pricesTry: [1, 2] };
  items[ids[0]].unverifiedPriceCandidates = { status: "unverified", checkedAt: "2026-10-23T00:00:00Z", pricesTry: [10000, 9000] };
  assert.deepEqual(visible(sortWatchlistProducts(items, "price-lowest")), [ids[1], ids[2], ids[0], ids[3]]);
  assert.deepEqual(visible(sortWatchlistProducts(items, "price-highest")), [ids[0], ids[1], ids[2], ids[3]]);
});

test("stored modes and custom ASINs are sanitized, deduplicated and reconciled", () => {
  const items = products();
  assert.equal(normalizeSortMode("something else"), DEFAULT_SORT_MODE);
  assert.equal(normalizeCustomOrder({ bad: true }), null);
  assert.deepEqual(normalizeCustomOrder([ids[0], "BAD", ids[0], ids[2]]), [ids[0], ids[2]]);
  assert.deepEqual(reconcileCustomOrder([ids[0], "B000000000", ids[0], ids[2]], items), [ids[3], ids[1], ids[0], ids[2]]);
  assert.deepEqual(moveCustomProduct([ids[0], ids[1], ids[2], ids[3]], ids[1], -1, items), [ids[1], ids[0], ids[2], ids[3]]);
  assert.deepEqual(moveCustomProduct([ids[0], ids[1], ids[2], ids[3]], ids[1], 1, items), [ids[0], ids[2], ids[1], ids[3]]);
  assert.deepEqual(moveCustomProduct([ids[0], ids[1], ids[2], ids[3]], ids[0], -1, items), [ids[0], ids[1], ids[2], ids[3]]);
});

test("missing custom order under a saved custom mode initializes from visible newest order", async () => {
  const local = storage({ [SORT_MODE_KEY]: "custom", [CUSTOM_ORDER_KEY]: { malformed: true } });
  const sorting = createWatchlistSorting(local, () => {});
  await sorting.load();
  sorting.updateProducts(products());
  await sorting.whenIdle();
  assert.deepEqual(sorting.getState().order, [ids[3], ids[1], ids[2], ids[0]]);
  await sorting.move(ids[0], -1);
  assert.equal(sorting.getState().records.at(-2).asin, ids[0]);
  sorting.dispose();
});

test("first custom selection captures visible order; switching modes and reopening restores it", async () => {
  const local = storage();
  const first = createWatchlistSorting(local, () => {});
  await first.load();
  assert.equal(first.getState().loaded, false);
  first.updateProducts(products());
  await first.changeMode("price-lowest");
  const initial = visible(first.getState().records);
  await first.changeMode("custom");
  assert.deepEqual(first.getState().order, initial);
  await first.move(ids[2], -1);
  const custom = visible(first.getState().records);
  await first.changeMode("added-newest");
  assert.deepEqual(first.getState().order, custom);
  await first.changeMode("custom");
  assert.deepEqual(visible(first.getState().records), custom);
  first.dispose();
  const reopened = createWatchlistSorting(local, () => {});
  await reopened.load(); // Must not erase saved order before the watchlist arrives.
  reopened.updateProducts(products());
  await reopened.whenIdle();
  assert.deepEqual(visible(reopened.getState().records), custom);
  assert.deepEqual(local.data[CUSTOM_ORDER_KEY], custom);
  reopened.dispose();
});

test("new products lead the custom sequence; removals clean stale entries", async () => {
  const local = storage({ [SORT_MODE_KEY]: "custom", [CUSTOM_ORDER_KEY]: [ids[0], ids[2]] });
  const sorting = createWatchlistSorting(local, () => {});
  await sorting.load();
  sorting.updateProducts({ [ids[0]]: products()[ids[0]], [ids[2]]: products()[ids[2]] });
  sorting.updateProducts(products());
  await sorting.whenIdle();
  assert.deepEqual(sorting.getState().order, [ids[3], ids[1], ids[0], ids[2]]);
  const remaining = products();
  delete remaining[ids[0]];
  sorting.updateProducts(remaining);
  await sorting.whenIdle();
  assert.deepEqual(local.data[CUSTOM_ORDER_KEY], [ids[3], ids[1], ids[2]]);
  sorting.dispose();
});

test("late initialization and pending writes reconcile a concurrent watchlist addition and reorder", async () => {
  const readGate = deferred();
  const writeGate = deferred();
  const local = storage({ [SORT_MODE_KEY]: "custom", [CUSTOM_ORDER_KEY]: [ids[0], ids[2]] }, {
    get: () => readGate.promise,
    set: (_value, number) => number === 1 ? writeGate.promise : undefined
  });
  const sorting = createWatchlistSorting(local, () => {});
  const loading = sorting.load();
  sorting.updateProducts({ [ids[0]]: products()[ids[0]], [ids[2]]: products()[ids[2]] });
  readGate.resolve();
  await loading;
  const added = products();
  sorting.updateProducts(added);
  const moving = sorting.move(ids[2], -1);
  writeGate.resolve();
  await moving;
  await sorting.whenIdle();
  assert.deepEqual(local.data[CUSTOM_ORDER_KEY], sorting.getState().order);
  assert.deepEqual(local.data[CUSTOM_ORDER_KEY], [ids[3], ids[1], ids[2], ids[0]]);
  sorting.dispose();
});

test("failed storage write rolls back the displayed preference without touching the watchlist", async () => {
  const items = products();
  const before = structuredClone(items);
  const local = storage({}, { set: () => { throw new Error("quota"); } });
  const sorting = createWatchlistSorting(local, () => {});
  sorting.updateProducts(items);
  await sorting.load();
  await sorting.changeMode("price-highest");
  assert.equal(sorting.getState().mode, DEFAULT_SORT_MODE);
  assert.match(sorting.getState().status, /kaydedilemedi/);
  assert.deepEqual(items, before);
  sorting.dispose();
});

test("custom controls are keyboard buttons with product labels; check and remove stay independent", async () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this[name] = value; }
  }
  const record = products()[ids[0]];
  const doc = { createElement: tagName => new Element(tagName), createElementNS: (_ns, tagName) => new Element(tagName) };
  const row = createProductRow(doc, record,
    { customOrder: true, index: 0, count: 2 });
  const actions = row.children.at(-1);
  const orderActions = actions.children[0];
  assert.equal(orderActions.className, "product-order-actions");
  assert.deepEqual(orderActions.children.map(button => [button.type, button.dataset.action, button.dataset.asin, button.disabled]), [
    ["button", "move-up", ids[0], true], ["button", "move-down", ids[0], false]
  ]);
  assert.match(orderActions.children[1].ariaLabel, new RegExp(ids[0]));
  assert.equal(actions.children[1].children[0].children[0].dataset.action, "check");
  assert.equal(actions.children[1].children[1].dataset.action, "remove");
  assert.equal(createProductRow(doc, record).children.at(-1).children[0].children[0].children[0].dataset.action, "check");
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  assert.match(html, /<select id="watchlist-sort"/);
  assert.equal((html.match(/<option value=/g) || []).length, 5);
});
