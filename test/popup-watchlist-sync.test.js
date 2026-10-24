import test from "node:test";
import assert from "node:assert/strict";
import { createPopupWatchlistSync } from "../src/popup-watchlist-sync.js";
import { renderProductRows } from "../src/watchlist-view.js";

function storageMock() {
  const listeners = new Set();
  return {
    api: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); }
      }
    },
    listeners,
    emit(changes, areaName = "local") {
      for (const listener of [...listeners]) listener(changes, areaName);
    }
  };
}

function watchlist(productRecords = {}) {
  return { version: 2, products: productRecords };
}

function record(overrides = {}) {
  return {
    asin: "B0D47HCRZ6",
    title: "Test product",
    addedAt: "2026-10-20T12:00:00.000Z",
    lastSuccessfulPriceTry: 1200,
    lastSuccessfulCheckAt: "2026-10-21T12:00:00.000Z",
    lastAttemptedCheckAt: "2026-10-21T12:00:00.000Z",
    lastCheckStatus: "success",
    lastErrorCode: null,
    baselinePriceTry: 1200,
    baselineCheckedAt: "2026-10-21T12:00:00.000Z",
    baselineSource: "first",
    ...overrides
  };
}

test("popup initialization accepts and presents the stored watchlist snapshot", () => {
  const storage = storageMock();
  const updates = [];
  const sync = createPopupWatchlistSync(storage.api, value => updates.push(value));
  const initialRead = sync.beginRead();
  const initial = watchlist({ B0D47HCRZ6: record() });

  assert.equal(sync.applyIfCurrent(initialRead, initial), true);
  assert.equal(updates[0], initial);
  assert.equal(storage.listeners.size, 1);
  sync.dispose();
});

test("local watchlist changes immediately expose the latest successful price and timestamps", () => {
  const storage = storageMock();
  let visible = watchlist();
  const sync = createPopupWatchlistSync(storage.api, value => { visible = value; });
  const updated = watchlist({ B0D47HCRZ6: record({
    lastSuccessfulPriceTry: 987.65,
    lastSuccessfulCheckAt: "2026-10-22T12:01:00.000Z",
    lastAttemptedCheckAt: "2026-10-22T12:00:59.000Z"
  }) });

  storage.emit({ watchlist: { oldValue: watchlist(), newValue: updated } });
  assert.equal(visible.products.B0D47HCRZ6.lastSuccessfulPriceTry, 987.65);
  assert.equal(visible.products.B0D47HCRZ6.lastSuccessfulCheckAt, "2026-10-22T12:01:00.000Z");
  assert.equal(visible.products.B0D47HCRZ6.lastAttemptedCheckAt, "2026-10-22T12:00:59.000Z");
  sync.dispose();
});

test("the existing renderer paints storage updates as text and preserves normal product presentation", () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const doc = { createElement: tagName => new Element(tagName) };
  const container = new Element("ul");
  const emptyState = { hidden: false };
  const storage = storageMock();
  const paint = value => renderProductRows(doc, container, value.products, emptyState);
  const sync = createPopupWatchlistSync(storage.api, paint);
  const title = '<img src=x onerror="alert(1)"> synthetic';
  const latest = watchlist({ B0D47HCRZ6: record({
    title,
    lastSuccessfulPriceTry: 2500,
    lastSuccessfulCheckAt: "2026-10-22T12:00:00.000Z",
    lastAttemptedCheckAt: "2026-10-22T12:01:00.000Z",
    lastCheckStatus: "failure",
    lastErrorCode: "HTTP_ERROR"
  }) });
  storage.emit({ watchlist: { newValue: latest } });
  const text = element => `${element.textContent} ${element.children.map(text).join(" ")}`;
  const rowText = text(container.children[0]);

  assert.equal(container.children.length, 1);
  assert.equal(emptyState.hidden, true);
  assert.equal(container.children[0].children[0].children[0].textContent, title);
  assert.equal(container.children[0].children[0].children[0].children.length, 0);
  assert.match(rowText, /2\.500,00/);
  assert.match(rowText, /Son kontrol başarısız/);
  assert.match(rowText, /Başarılı kontrol:/);
  assert.match(rowText, /Son deneme:/);
  sync.dispose();
});

test("live storage updates repaint the fixed comparison independently of notification preferences", () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const doc = { createElement: tagName => new Element(tagName) };
  const container = new Element("ul");
  const storage = storageMock();
  const sync = createPopupWatchlistSync(storage.api, value => renderProductRows(doc, container, value.products, { hidden: false }));
  const paint = price => storage.emit({ watchlist: { newValue: watchlist({ B0D47HCRZ6: record({ lastSuccessfulPriceTry: price }) }) } });
  const visible = () => container.children[0].children.map(child => child.textContent).join(" ");
  paint(800);
  assert.match(visible(), /↓ %33,33 daha ucuz/);
  storage.emit({ notificationPreferences: { newValue: { enabled: false } } });
  assert.match(visible(), /↓ %33,33 daha ucuz/);
  paint(1350);
  assert.match(visible(), /↑ %12,5 daha pahalı/);
  sync.dispose();
});

test("failed watchlist update shows failure while preserving the previous successful price", () => {
  const storage = storageMock();
  let visible;
  const sync = createPopupWatchlistSync(storage.api, value => { visible = value; });
  storage.emit({ watchlist: { newValue: watchlist({ B0D47HCRZ6: record({
    lastCheckStatus: "failure",
    lastErrorCode: "HTTP_ERROR",
    lastAttemptedCheckAt: "2026-10-22T12:00:00.000Z"
  }) }) } });

  assert.equal(visible.products.B0D47HCRZ6.lastCheckStatus, "failure");
  assert.equal(visible.products.B0D47HCRZ6.lastErrorCode, "HTTP_ERROR");
  assert.equal(visible.products.B0D47HCRZ6.lastSuccessfulPriceTry, 1200);
  sync.dispose();
});

test("product removals and a cleared watchlist update the open view", () => {
  const storage = storageMock();
  let visible = watchlist({ B0D47HCRZ6: record() });
  const sync = createPopupWatchlistSync(storage.api, value => { visible = value; });
  storage.emit({ watchlist: { newValue: watchlist() } });
  assert.deepEqual(visible.products, {});
  storage.emit({ watchlist: { oldValue: watchlist(), newValue: undefined } });
  assert.deepEqual(visible, watchlist());
  sync.dispose();
});

test("unrelated keys and non-local storage events are ignored", () => {
  const storage = storageMock();
  let renders = 0;
  const sync = createPopupWatchlistSync(storage.api, () => { renders++; });
  storage.emit({ automaticChecks: { newValue: { enabled: false } } });
  storage.emit({ watchlist: { newValue: watchlist({ B0D47HCRZ6: record() }) } }, "sync");
  assert.equal(renders, 0);
  sync.dispose();
});

test("rapid watchlist updates leave the latest committed snapshot visible", () => {
  const storage = storageMock();
  const seen = [];
  const sync = createPopupWatchlistSync(storage.api, value => seen.push(value));
  const states = [1, 2, 3].map(price => watchlist({ B0D47HCRZ6: record({ lastSuccessfulPriceTry: price }) }));
  for (const state of states) storage.emit({ watchlist: { newValue: state } });
  assert.equal(seen.length, 3);
  assert.equal(seen.at(-1).products.B0D47HCRZ6.lastSuccessfulPriceTry, 3);
  sync.dispose();
});

test("a storage event invalidates an older initialization read before it can render", () => {
  const storage = storageMock();
  const seen = [];
  const sync = createPopupWatchlistSync(storage.api, value => seen.push(value));
  const firstRead = sync.beginRead();
  const latest = watchlist({ B0D47HCRZ6: record({ lastSuccessfulPriceTry: 2500 }) });
  storage.emit({ watchlist: { newValue: latest } });

  assert.equal(sync.applyIfCurrent(firstRead, watchlist({ B0D47HCRZ6: record({ lastSuccessfulPriceTry: 1000 }) })), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].products.B0D47HCRZ6.lastSuccessfulPriceTry, 2500);
  sync.dispose();
});

test("newer concurrent reads cannot be overwritten by an older response", () => {
  const storage = storageMock();
  const seen = [];
  const sync = createPopupWatchlistSync(storage.api, value => seen.push(value));
  const firstRead = sync.beginRead();
  const secondRead = sync.beginRead();
  const newest = watchlist({ B0D47HCRZ6: record({ lastSuccessfulPriceTry: 2200 }) });

  assert.equal(sync.applyIfCurrent(firstRead, watchlist()), false);
  assert.equal(sync.applyIfCurrent(secondRead, newest), true);
  assert.equal(seen[0], newest);
  sync.dispose();
});

test("popup open-close cycles remove their listener and repeated cleanup is safe", () => {
  const storage = storageMock();
  const updates = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const sync = createPopupWatchlistSync(storage.api, value => updates.push(value));
    assert.equal(storage.listeners.size, 1);
    sync.dispose();
    sync.dispose();
    assert.equal(storage.listeners.size, 0);
  }
  storage.emit({ watchlist: { newValue: watchlist({ B0D47HCRZ6: record() }) } });
  assert.equal(updates.length, 0);
});

test("watchlist events only render data and do not invoke fetches or scheduler APIs", () => {
  const storage = storageMock();
  let fetches = 0;
  let alarmCalls = 0;
  let renders = 0;
  const sync = createPopupWatchlistSync(storage.api, () => { renders++; });
  storage.emit({ watchlist: { newValue: watchlist({ B0D47HCRZ6: record({ lastCheckStatus: "checking" }) }) } });
  assert.equal(renders, 1);
  assert.equal(fetches, 0);
  assert.equal(alarmCalls, 0);
  sync.dispose();
});
