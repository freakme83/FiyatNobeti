import { parseAmazonInput } from "./src/url.js";
import { errorMessage, renderProductRows } from "./src/watchlist-view.js";
import { createPermissionOnboarding } from "./src/permission-onboarding.js";
import { getMissingAmazonOrigins } from "./src/popup-permissions.js";
import { createPopupWatchlistSync } from "./src/popup-watchlist-sync.js";
import { createPopupNotificationPreferences } from "./src/notification-preferences.js";
import { createWatchlist, WATCHLIST_VERSION } from "./src/watchlist.js";

const loadingView = document.querySelector("#permission-loading");
const onboardingView = document.querySelector("#permission-onboarding");
const normalView = document.querySelector("#normal-view");
const permissionButton = document.querySelector("#permission-button");
const permissionExplanation = document.querySelector("#permission-explanation");
const permissionStatus = document.querySelector("#permission-status");
const form = document.querySelector("#add-form");
const input = document.querySelector("#product-url");
const addButton = document.querySelector("#add-button");
const status = document.querySelector("#status");
const shortLinkNotice = document.querySelector("#short-link-notice");
const productList = document.querySelector("#products");
const emptyState = document.querySelector("#empty-state");
const autoEnabled = document.querySelector("#auto-enabled");
const autoMode = document.querySelector("#auto-mode");
const autoStatus = document.querySelector("#auto-status");
const notificationMaster = document.querySelector("#notifications-enabled");
const notifyOnDecrease = document.querySelector("#notify-on-decrease");
const notifyOnIncrease = document.querySelector("#notify-on-increase");
const notificationOptions = document.querySelector("#notification-options");
const notificationStatus = document.querySelector("#notification-status");

let watchlist = createWatchlist();
const busyAsins = new Set();
const busyRemovalAsins = new Set();
const watchlistSync = createPopupWatchlistSync(chrome.storage, updatedWatchlist => {
  watchlist = updatedWatchlist;
  render();
});
const notificationPreferences = createPopupNotificationPreferences(chrome.storage, view => {
  notificationMaster.checked = view.preferences.enabled;
  notifyOnDecrease.checked = view.preferences.notifyOnDecrease;
  notifyOnIncrease.checked = view.preferences.notifyOnIncrease;
  notificationMaster.disabled = !view.loaded;
  notifyOnDecrease.disabled = !view.loaded || !view.preferences.enabled;
  notifyOnIncrease.disabled = !view.loaded || !view.preferences.enabled;
  notificationOptions.dataset.disabled = String(!view.preferences.enabled);
  notificationStatus.textContent = view.status === "loading" ? "Yükleniyor…"
    : view.status === "saving" ? "Kaydediliyor…"
    : view.status === "saved" ? "Bildirim tercihleri kaydedildi."
    : view.status === "invalid" ? "Ayarlar geçersiz; güvenli olması için bildirimler kapalı."
    : view.status === "read-error" ? "Ayarlar okunamadı; bildirimler kapalı."
    : view.status === "write-error" ? "Kaydedilemedi; önceki ayarlar korundu."
    : "";
});
window.addEventListener("unload", () => {
  watchlistSync.dispose();
  notificationPreferences.dispose();
}, { once: true });

notificationMaster.addEventListener("change", () => {
  notificationPreferences.update("enabled", notificationMaster.checked);
});
notifyOnDecrease.addEventListener("change", () => {
  notificationPreferences.update("notifyOnDecrease", notifyOnDecrease.checked);
});
notifyOnIncrease.addEventListener("change", () => {
  notificationPreferences.update("notifyOnIncrease", notifyOnIncrease.checked);
});

async function loadAutoSettings() {
  const result = await chrome.runtime.sendMessage({ type: "GET_AUTO_SETTINGS" });
  if (result?.status !== "success") throw new Error("AUTO_SETTINGS_ERROR");
  autoEnabled.checked = result.settings.enabled;
  autoEnabled.disabled = false;
  autoMode.textContent = result.settings.enabled ? "Açık" : "Kapalı";
  autoStatus.textContent = result.settings.enabled && result.errorCode === "PERMISSION_REQUIRED"
    ? "Otomatik kontrol için Amazon Türkiye erişim izni gerekli."
    : "";
}

autoEnabled.disabled = true;
autoEnabled.addEventListener("change", async () => {
  const enabled = autoEnabled.checked;
  autoEnabled.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "SET_AUTO_ENABLED", enabled });
    if (result?.status !== "success") throw new Error("AUTO_SETTINGS_ERROR");
    autoMode.textContent = enabled ? "Açık" : "Kapalı";
    autoStatus.textContent = enabled ? "Otomatik kontrol açık." : "Otomatik kontrol kapalı.";
  } catch {
    autoEnabled.checked = !enabled;
    autoStatus.textContent = "Otomatik kontrol ayarı kaydedilemedi.";
  } finally {
    autoEnabled.disabled = false;
  }
});

function render() {
  renderProductRows(document, productList, watchlist.products, emptyState);
  for (const button of productList.querySelectorAll('[data-action="check"]')) {
    button.disabled = busyAsins.has(button.dataset.asin);
  }
  for (const button of productList.querySelectorAll('[data-action="remove"]')) {
    button.disabled = busyRemovalAsins.has(button.dataset.asin);
  }
}

async function loadWatchlist() {
  const read = watchlistSync.beginRead();
  const response = await chrome.runtime.sendMessage({ type: "GET_WATCHLIST" });
  if (response?.status === "success" && response.watchlist?.version === WATCHLIST_VERSION) {
    watchlistSync.applyIfCurrent(read, response.watchlist);
    return true;
  }
  if (watchlistSync.isCurrent(read)) status.textContent = errorMessage(response?.errorCode || "STORAGE_ERROR");
  return false;
}

function updateShortLinkNotice() {
  try { shortLinkNotice.hidden = parseAmazonInput(input.value).type !== "short"; }
  catch { shortLinkNotice.hidden = true; }
}

function showFailure(result) {
  const message = errorMessage(result?.errorCode);
  status.textContent = result?.errorCode?.startsWith("SHORT_LINK_")
    ? `${message} (${result.errorCode})`
    : message;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  let request;
  try { request = parseAmazonInput(input.value); }
  catch (error) { showFailure({ errorCode: error.message }); return; }

  addButton.disabled = true;
  status.textContent = request.type === "short" ? "Amazon kısa bağlantısı çözümleniyor…" : "Ürün doğrulanıyor…";
  try {
    const submittedUrl = input.value;
    const missingOrigins = await getMissingAmazonOrigins(chrome.permissions);
    if (missingOrigins.length > 0) {
      await permissionOnboarding.start();
      input.value = submittedUrl;
      updateShortLinkNotice();
      return;
    }
    const addWatchlistRead = watchlistSync.beginRead();
    const result = await chrome.runtime.sendMessage({ type: "ADD_PRODUCT", url: input.value });
    if (result?.status === "duplicate") {
      status.textContent = "Bu ürün zaten izleme listenizde.";
    } else if (result?.status === "added") {
      if (result.watchlist?.version === WATCHLIST_VERSION) watchlistSync.applyIfCurrent(addWatchlistRead, result.watchlist);
      else await loadWatchlist();
      const product = watchlist.products[result.asin];
      if (product?.canonicalUrl) input.value = product.canonicalUrl;
      status.textContent = result.check?.status === "success"
        ? "Ürün eklendi ve fiyat kontrol edildi."
        : `Ürün eklendi; ilk fiyat alınamadı${result.check?.errorCode ? ` · ${errorMessage(result.check.errorCode)}` : "."}`;
    } else {
      showFailure(result);
    }
  } catch {
    status.textContent = "Ürün eklenemedi. Tekrar deneyin.";
  } finally {
    addButton.disabled = false;
    updateShortLinkNotice();
  }
});

productList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action][data-asin]");
  if (!button) return;
  const { action, asin } = button.dataset;
  if (action === "remove") {
    if (busyRemovalAsins.has(asin)) return;
    busyRemovalAsins.add(asin);
    const removalRead = watchlistSync.beginRead();
    render();
    try {
      const result = await chrome.runtime.sendMessage({ type: "REMOVE_PRODUCT", asin });
      if (result?.status === "success") {
        watchlistSync.applyIfCurrent(removalRead, result.watchlist);
        status.textContent = "Ürün izleme listesinden kaldırıldı.";
      } else showFailure(result);
    } catch { status.textContent = "Ürün kaldırılamadı. Tekrar deneyin."; }
    finally {
      busyRemovalAsins.delete(asin);
      render();
    }
    return;
  }
  if (action !== "check" || busyAsins.has(asin)) return;

  busyAsins.add(asin);
  const current = watchlist.products[asin];
  if (current) watchlist.products[asin] = { ...current, lastCheckStatus: "checking", lastAttemptedCheckAt: new Date().toISOString() };
  render();
  status.textContent = "Fiyat kontrol ediliyor…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "CHECK_PRODUCT", asin });
    if (result?.status === "busy") status.textContent = "Bu ürün için kontrol zaten sürüyor.";
    else if (result?.status === "success") status.textContent = "Fiyat kontrolü tamamlandı.";
    else if (result?.status === "failure") showFailure(result);
    await loadWatchlist();
  } catch {
    status.textContent = "Fiyat kontrolü tamamlanamadı. Tekrar deneyin.";
  } finally {
    busyAsins.delete(asin);
    render();
  }
});

input.addEventListener("input", updateShortLinkNotice);

const permissionOnboarding = createPermissionOnboarding({
  permissions: chrome.permissions,
  loadingView,
  onboardingView,
  normalView,
  permissionButton,
  explanation: permissionExplanation,
  status: permissionStatus,
  onAuthorized() {
    loadWatchlist().catch(() => { status.textContent = errorMessage("STORAGE_ERROR"); });
    loadAutoSettings().catch(() => { autoStatus.textContent = "Otomatik kontrol ayarı okunamadı."; });
  },
});

permissionOnboarding.start();
notificationPreferences.load();
