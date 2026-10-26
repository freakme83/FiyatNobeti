import { compareWithBaseline } from "./price-comparison.js";
import { priceCents } from "./watchlist.js";
import { parseAmazonInput } from "./url.js";
import { sortWatchlistProducts } from "./watchlist-sorting.js";

const ERROR_LABELS = {
  PERMISSION_REQUIRED: "Amazon Türkiye izni verilmedi.",
  SHORT_LINK_PERMISSION_REQUIRED: "Kısa Amazon bağlantısı izni verilmedi.",
  SHORT_LINK_RESOLUTION_FAILED: "Kısa Amazon bağlantısı çözümlenemedi.",
  SHORT_LINK_OPAQUE_REDIRECT: "Kısa bağlantı yönlendirmesi okunamadı.",
  SHORT_LINK_OPAQUE_RESPONSE: "Kısa bağlantı yanıtı okunamadı.",
  SHORT_LINK_HTTP_STATUS: "Kısa bağlantı isteği başarısız oldu.",
  SHORT_LINK_NETWORK_ERROR: "Kısa bağlantı için ağ isteği başarısız oldu.",
  SHORT_LINK_TIMEOUT: "Kısa bağlantı isteği zaman aşımına uğradı.",
  SHORT_LINK_UNSAFE_REDIRECT: "Kısa bağlantı desteklenmeyen bir adrese yönlendi.",
  SHORT_LINK_UNSUPPORTED_MARKETPLACE: "Kısa bağlantı Amazon Türkiye dışına yönlendi.",
  SHORT_LINK_FINAL_URL_MISSING: "Kısa bağlantının ürün adresi alınamadı.",
  SHORT_LINK_FINAL_URL_INVALID: "Kısa bağlantının ürün adresi doğrulanamadı.",
  SHORT_LINK_UNSUPPORTED_PRODUCT_URL: "Kısa bağlantı desteklenen bir ürün sayfasına ulaşmadı.",
  CHECK_INTERRUPTED: "Kontrol servis çalışanı yeniden başladığı için kesildi; yeniden deneyebilirsiniz.",
  CHECK_CANCELLED: "Kontrol sonucu ürün kaydı değiştiği için uygulanmadı.",
  REDIRECT: "Amazon yönlendirmesi nedeniyle fiyat doğrulanamadı.",
  ACCESS_DENIED: "Amazon erişimi reddetti.",
  BOT_VERIFICATION: "Amazon ek doğrulama istiyor. Fiyat kontrolü tamamlanamadı.",
  AUTH_REQUIRED: "Amazon giriş yapılmasını istiyor.",
  HTTP_ERROR: "Amazon sayfası yüklenemedi.",
  HTML_STRUCTURE: "Amazon ürün sayfasındaki fiyat alanı tanınamadı.",
  PRICE_MISSING: "Birincil ürün fiyatı bulunamadı.",
  PRICE_AMBIGUOUS: "Birden çok ürün fiyatı bulundu; fiyat güncellenmedi.",
  PRICE_UNRECOGNIZED: "Ürün fiyatı TL biçiminde tanınamadı.",
  RESPONSE_TOO_LARGE: "Amazon yanıtı güvenli boyut sınırını aştı.",
  TIMEOUT: "Amazon isteği zaman aşımına uğradı.",
  NETWORK_ERROR: "Amazon için ağ isteği başarısız oldu.",
  PARSE_ERROR: "Amazon ürün yanıtı ayrıştırılamadı.",
  INVALID_URL: "Geçerli bir Amazon Türkiye ürün bağlantısı veya ASIN girin.",
  UNSUPPORTED_URL: "Bu Amazon bağlantısı desteklenmiyor.",
  UNSUPPORTED_MARKETPLACE: "Bu bağlantı Amazon Türkiye'ye ait değil.",
  STORAGE_ERROR: "İzleme listesi yerel olarak okunamadı veya kaydedilemedi."
};

const priceFormatter = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });

function timeLabel(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function textElement(doc, tagName, className, text) {
  const element = doc.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

export function errorMessage(code) {
  return ERROR_LABELS[code] || "Fiyat kontrolü başarısız oldu.";
}

export function createProductRow(doc, product, { customOrder = false, index = 0, count = 0 } = {}) {
  const row = doc.createElement("li");
  row.className = "product";
  row.dataset.asin = product.asin;
  const heading = doc.createElement("h3");
  heading.className = "product-title";
  const title = product.title || "Amazon ürünü";
  try {
    // A stored URL is never used as a destination; only the product's ASIN is accepted.
    const destination = parseAmazonInput(product.asin);
    if (destination.type !== "product" || destination.asin !== product.asin) throw new Error("INVALID_PRODUCT");
    const link = textElement(doc, "a", "", title);
    link.href = destination.canonicalUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = title;
    heading.append(link);
  } catch {
    heading.textContent = title;
  }
  row.append(heading);

  const details = doc.createElement("div");
  details.className = "product-details";
  details.id = `product-details-${product.asin}`;
  details.setAttribute("popover", "manual");
  details.tabIndex = -1;
  details.setAttribute("aria-label", `${title} ayrıntıları`);
  const detailContent = doc.createElement("div");
  detailContent.className = "product-detail-content";
  detailContent.append(textElement(doc, "p", "product-asin", product.asin));
  detailContent.append(textElement(doc, "p", "product-full-title", title));

  if (priceCents(product.lastSuccessfulPriceTry) !== null) {
    row.append(
      textElement(doc, "p", "product-price-label", "Son başarılı fiyat"),
      textElement(doc, "p", "product-price", priceFormatter.format(product.lastSuccessfulPriceTry))
    );
    const comparison = compareWithBaseline(product);
    if (comparison) {
      const tone = comparison.direction < 0 ? "decrease" : comparison.direction > 0 ? "increase" : "unchanged";
      if (comparison.direction !== 0) row.append(textElement(doc, "p", `product-comparison ${tone}`, comparison.headline));
      detailContent.append(
        textElement(doc, "p", `product-comparison-detail ${tone}`, comparison.headline),
        textElement(doc, "p", "product-comparison-detail", comparison.detail),
        textElement(doc, "p", "product-meta", `${product.baselineSource === "migrated" ? "Referans (geçişteki son fiyat)" : "Başlangıç"}: ${comparison.baselineText} · ${timeLabel(product.baselineCheckedAt) || "tarih bilinmiyor"}`)
      );
    } else detailContent.append(textElement(doc, "p", "product-meta", "Karşılaştırma henüz kullanılamıyor."));
    if (product.lastSuccessfulCheckAt) {
      detailContent.append(textElement(doc, "p", "product-meta", `Başarılı kontrol: ${timeLabel(product.lastSuccessfulCheckAt)}`));
    }
  } else {
    row.append(textElement(doc, "p", "product-price-label", "Henüz başarılı fiyat yok"));
    detailContent.append(textElement(doc, "p", "product-meta", "İlk geçerli fiyat bekleniyor."));
  }

  if (product.lastCheckStatus === "failure") row.append(textElement(doc, "p", "product-status error", "Son kontrol başarısız"));
  else if (product.lastCheckStatus === "checking") row.append(textElement(doc, "p", "product-status", "Kontrol ediliyor…"));
  else if (product.lastCheckStatus === "never" && priceCents(product.lastSuccessfulPriceTry) === null) {
    row.append(textElement(doc, "p", "product-status", "İlk fiyat kontrolü bekleniyor"));
  }
  if (product.lastCheckStatus !== "success" && product.lastCheckStatus !== "failure" && product.lastCheckStatus !== "checking" && product.lastSuccessfulCheckAt) {
    row.append(textElement(doc, "p", "product-status error", "Fiyat güncel olmayabilir"));
  }
  if (product.lastCheckStatus === "failure" && product.lastErrorCode) {
    detailContent.append(textElement(doc, "p", "product-status error", `Son kontrol başarısız · ${errorMessage(product.lastErrorCode)}`));
  } else if (product.lastCheckStatus === "never") detailContent.append(textElement(doc, "p", "product-status", "Henüz kontrol edilmedi."));
  if (product.lastAttemptedCheckAt) {
    detailContent.append(textElement(doc, "p", "product-meta", `Son deneme: ${timeLabel(product.lastAttemptedCheckAt)}`));
  }
  details.append(detailContent);

  const actions = doc.createElement("div");
  actions.className = "product-actions";
  if (customOrder) {
    const orderActions = doc.createElement("div");
    orderActions.className = "product-order-actions";
    for (const [direction, label, action, disabled] of [
      [-1, "Yukarı", "move-up", index === 0],
      [1, "Aşağı", "move-down", index === count - 1]
    ]) {
      const button = textElement(doc, "button", "", direction < 0 ? "↑" : "↓");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.asin = product.asin;
      button.ariaLabel = `${product.title || "Amazon ürünü"} (${product.asin}) ${label.toLowerCase()} taşı`;
      button.disabled = disabled;
      orderActions.append(button);
    }
    actions.append(orderActions);
  }

  const check = doc.createElement("button");
  check.className = "product-check";
  const refreshIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  refreshIcon.setAttribute("viewBox", "0 0 16 16");
  refreshIcon.setAttribute("aria-hidden", "true");
  refreshIcon.setAttribute("focusable", "false");
  const refreshPath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  refreshPath.setAttribute("d", "M13 8a5 5 0 1 1-1.45-3.54M13 3v3.5H9.5");
  refreshIcon.append(refreshPath);
  check.append(refreshIcon, textElement(doc, "span", "", "Kontrol et"));
  check.type = "button";
  check.ariaLabel = "Fiyatı kontrol et";
  check.dataset.action = "check";
  check.dataset.asin = product.asin;
  const remove = doc.createElement("button");
  remove.className = "remove";
  remove.type = "button";
  remove.ariaLabel = "Listeden kaldır";
  remove.dataset.action = "remove";
  remove.dataset.asin = product.asin;
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 18 18");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3 5.5h12M6 5.5V4h6v1.5m-7 0 .5 10h7l.5-10M7.5 8v5m3-5v5");
  svg.append(path);
  remove.append(svg);
  const actionGroup = doc.createElement("div");
  actionGroup.className = "product-action-group";
  actionGroup.append(check, remove);

  const detailsButton = doc.createElement("button");
  detailsButton.className = "product-details-trigger";
  detailsButton.append(textElement(doc, "span", "", "Ayrıntılar"));
  const chevron = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 12 12");
  chevron.setAttribute("aria-hidden", "true");
  chevron.setAttribute("focusable", "false");
  const chevronPath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  chevronPath.setAttribute("d", "m3 4.5 3 3 3-3");
  chevron.append(chevronPath);
  detailsButton.append(chevron);
  detailsButton.type = "button";
  detailsButton.dataset.action = "details";
  detailsButton.dataset.asin = product.asin;
  detailsButton.setAttribute("aria-controls", details.id);
  detailsButton.setAttribute("aria-expanded", "false");
  actions.append(actionGroup, detailsButton, details);
  row.append(actions);
  return row;
}

export function renderProductRows(doc, container, products, emptyState, options = {}) {
  container.replaceChildren();
  const records = options.records || sortWatchlistProducts(products);
  emptyState.hidden = records.length > 0;
  records.forEach((product, index) => container.append(createProductRow(doc, product,
    { customOrder: options.customOrder, index, count: records.length })));
}
