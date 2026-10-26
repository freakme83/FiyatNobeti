import { priceCents } from "./watchlist.js";

export const SORT_MODE_KEY = "watchlistSortMode";
export const CUSTOM_ORDER_KEY = "watchlistCustomOrder";
export const DEFAULT_SORT_MODE = "added-newest";
export const SORT_MODES = Object.freeze([
  "custom", "added-newest", "added-oldest", "price-lowest", "price-highest"
]);
const ASIN = /^[A-Z0-9]{10}$/;

export function normalizeSortMode(value) {
  return SORT_MODES.includes(value) ? value : DEFAULT_SORT_MODE;
}

export function normalizeCustomOrder(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  return value.slice(0, 1000).filter(asin => {
    if (typeof asin !== "string" || !ASIN.test(asin) || seen.has(asin)) return false;
    seen.add(asin);
    return true;
  });
}

function addedAt(product) {
  const time = Date.parse(product.addedAt);
  return Number.isFinite(time) ? time : null;
}

function newestFirst(left, right) {
  const a = addedAt(left);
  const b = addedAt(right);
  if (a === null && b !== null) return 1;
  if (b === null && a !== null) return -1;
  return (b ?? 0) - (a ?? 0) || left.asin.localeCompare(right.asin);
}

export function reconcileCustomOrder(order, products) {
  const known = new Set(Object.keys(products || {}));
  const saved = (normalizeCustomOrder(order) || []).filter(asin => known.delete(asin));
  const additions = [...known].map(asin => products[asin]).sort(newestFirst).map(product => product.asin);
  return [...additions, ...saved];
}

export function sortWatchlistProducts(products, mode = DEFAULT_SORT_MODE, order = null) {
  const records = Object.values(products || {});
  if (mode === "custom" && order !== null) {
    const positions = new Map(reconcileCustomOrder(order, products).map((asin, index) => [asin, index]));
    return records.sort((a, b) => positions.get(a.asin) - positions.get(b.asin));
  }
  if (mode === "added-oldest") return records.sort((a, b) => {
    const left = addedAt(a), right = addedAt(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    return (left ?? 0) - (right ?? 0) || newestFirst(a, b);
  });
  if (mode === "price-lowest" || mode === "price-highest") return records.sort((a, b) => {
    const left = priceCents(a.lastSuccessfulPriceTry), right = priceCents(b.lastSuccessfulPriceTry);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) {
      return mode === "price-lowest" ? left - right : right - left;
    }
    return newestFirst(a, b);
  });
  return records.sort(newestFirst);
}

export function moveCustomProduct(order, asin, direction, products) {
  const next = reconcileCustomOrder(order, products);
  const index = next.indexOf(asin);
  const neighbor = index + direction;
  if (index < 0 || ![-1, 1].includes(direction) || neighbor < 0 || neighbor >= next.length) return next;
  [next[index], next[neighbor]] = [next[neighbor], next[index]];
  return next;
}

export function createWatchlistSorting(storage, onChange) {
  let products = {};
  let productsReady = false;
  let mode = DEFAULT_SORT_MODE;
  let order = null;
  let loaded = false;
  let status = "";
  let revision = 0;
  let writes = Promise.resolve();
  let disposed = false;

  const view = () => ({ mode, order: order?.slice() ?? null, loaded: loaded && productsReady, status,
    records: sortWatchlistProducts(products, mode, order) });
  const publish = () => { if (!disposed) onChange(view()); };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function persist() {
    const ticket = ++revision;
    const snapshot = { [SORT_MODE_KEY]: mode, ...(order !== null ? { [CUSTOM_ORDER_KEY]: order.slice() } : {}) };
    const operation = writes.catch(() => {}).then(async () => {
      try {
        await storage.set(snapshot);
        if (ticket === revision) { status = ""; publish(); }
      } catch {
        if (ticket === revision) {
          try {
            const saved = await storage.get([SORT_MODE_KEY, CUSTOM_ORDER_KEY]);
            mode = normalizeSortMode(saved[SORT_MODE_KEY]);
            order = normalizeCustomOrder(saved[CUSTOM_ORDER_KEY]);
            if (order !== null) order = reconcileCustomOrder(order, products);
          } catch { mode = DEFAULT_SORT_MODE; order = null; }
          status = "Sıralama kaydedilemedi.";
          publish();
        }
      }
    });
    writes = operation;
    return operation;
  }

  return {
    getState: view,
    whenIdle: () => writes,
    async load() {
      if (loaded || disposed) return;
      try {
        const saved = await storage.get([SORT_MODE_KEY, CUSTOM_ORDER_KEY]);
        if (disposed) return;
        mode = normalizeSortMode(saved[SORT_MODE_KEY]);
        order = normalizeCustomOrder(saved[CUSTOM_ORDER_KEY]);
        loaded = true;
        if (mode === "custom" && order === null && productsReady) {
          order = sortWatchlistProducts(products).map(product => product.asin);
          persist();
        }
        if (order !== null && productsReady) {
          const reconciled = reconcileCustomOrder(order, products);
          if (!equal(order, reconciled)) { order = reconciled; persist(); }
        }
      } catch {
        if (disposed) return;
        loaded = true;
        status = "Sıralama tercihi okunamadı; yeniden eskiye gösteriliyor.";
      }
      publish();
    },
    updateProducts(next) {
      products = next || {};
      productsReady = true;
      if (loaded && mode === "custom" && order === null) {
        order = sortWatchlistProducts(products).map(product => product.asin);
        persist();
      }
      if (loaded && order !== null) {
        const reconciled = reconcileCustomOrder(order, products);
        if (!equal(order, reconciled)) { order = reconciled; persist(); }
      }
      publish();
    },
    changeMode(next) {
      if (!loaded || !productsReady || !SORT_MODES.includes(next)) return Promise.resolve();
      if (next === mode) return writes;
      if (next === "custom" && order === null) {
        order = sortWatchlistProducts(products, mode, order).map(product => product.asin);
      }
      mode = next;
      status = "";
      publish();
      return persist();
    },
    move(asin, direction) {
      if (!loaded || mode !== "custom" || order === null) return Promise.resolve();
      const next = moveCustomProduct(order, asin, direction, products);
      if (equal(next, order)) return writes;
      order = next;
      status = "";
      publish();
      return persist();
    },
    dispose() { disposed = true; }
  };
}
