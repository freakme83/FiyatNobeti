import { createWatchlist, WATCHLIST_KEY } from "./watchlist.js";

export function createPopupWatchlistSync(storage, onWatchlist) {
  let revision = 0;
  let readSequence = 0;
  let disposed = false;

  function beginRead() {
    return { revision, sequence: ++readSequence };
  }

  function isCurrent(token) {
    return !disposed && token.revision === revision && token.sequence === readSequence;
  }

  function applyIfCurrent(token, watchlist) {
    if (!isCurrent(token)) return false;
    revision += 1;
    readSequence += 1;
    onWatchlist(watchlist);
    return true;
  }

  function applyStorageChange(changes, areaName) {
    if (disposed || areaName !== "local" || !Object.hasOwn(changes, WATCHLIST_KEY)) return;
    const value = changes[WATCHLIST_KEY].newValue;
    const watchlist = value === undefined ? createWatchlist() : value;
    if (watchlist?.version !== 1 || !watchlist.products || typeof watchlist.products !== "object") return;
    revision += 1;
    readSequence += 1;
    onWatchlist(watchlist);
  }

  storage.onChanged.addListener(applyStorageChange);
  return {
    beginRead,
    isCurrent,
    applyIfCurrent,
    dispose() {
      if (disposed) return;
      disposed = true;
      storage.onChanged.removeListener(applyStorageChange);
    }
  };
}
