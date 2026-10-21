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
  REDIRECT: "Amazon yönlendirmesi nedeniyle fiyat doğrulanamadı.",
  ACCESS_DENIED: "Amazon erişimi reddetti.",
  BOT_VERIFICATION: "Amazon robot doğrulaması istedi.",
  AUTH_REQUIRED: "Amazon giriş yapılmasını istiyor.",
  HTTP_ERROR: "Amazon sayfası yüklenemedi.",
  HTML_STRUCTURE: "Ürün fiyatı bölümü bulunamadı.",
  PRICE_MISSING: "Birincil ürün fiyatı bulunamadı.",
  PRICE_AMBIGUOUS: "Birden çok ürün fiyatı bulundu; fiyat güncellenmedi.",
  PRICE_UNRECOGNIZED: "Ürün fiyatı TL biçiminde tanınamadı.",
  RESPONSE_TOO_LARGE: "Amazon yanıtı güvenli boyut sınırını aştı.",
  TIMEOUT: "Amazon isteği zaman aşımına uğradı.",
  NETWORK_ERROR: "Amazon için ağ isteği başarısız oldu.",
  PARSE_ERROR: "Amazon ürün yanıtı ayrıştırılamadı.",
  INVALID_URL: "Geçerli bir Amazon Türkiye ürün bağlantısı girin.",
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

export function createProductRow(doc, product) {
  const row = doc.createElement("li");
  row.className = "product";
  row.dataset.asin = product.asin;
  row.append(
    textElement(doc, "h3", "product-title", product.title || "Amazon ürünü"),
    textElement(doc, "p", "product-asin", product.asin)
  );

  if (Number.isFinite(product.lastSuccessfulPriceTry) && product.lastSuccessfulPriceTry > 0) {
    const fresh = product.lastCheckStatus === "success";
    row.append(
      textElement(doc, "p", "product-price-label", fresh ? "Son başarılı fiyat" : "Son başarılı fiyat · güncel değil"),
      textElement(doc, "p", "product-price", priceFormatter.format(product.lastSuccessfulPriceTry))
    );
    if (product.lastSuccessfulCheckAt) {
      row.append(textElement(doc, "p", "product-meta", `Başarılı kontrol: ${timeLabel(product.lastSuccessfulCheckAt)}`));
    }
  } else {
    row.append(textElement(doc, "p", "product-price-label", "Henüz fiyat alınamadı"));
  }

  let statusText = "";
  let statusClass = "product-status";
  if (product.lastCheckStatus === "checking") statusText = "Kontrol ediliyor…";
  else if (product.lastCheckStatus === "failure") {
    statusText = `Son kontrol başarısız${product.lastErrorCode ? ` · ${errorMessage(product.lastErrorCode)}` : ""}`;
    statusClass += " error";
  } else if (product.lastCheckStatus === "never") statusText = "Henüz kontrol edilmedi.";
  if (statusText) row.append(textElement(doc, "p", statusClass, statusText));
  if (product.lastAttemptedCheckAt) {
    row.append(textElement(doc, "p", "product-meta", `Son deneme: ${timeLabel(product.lastAttemptedCheckAt)}`));
  }

  const actions = doc.createElement("div");
  actions.className = "product-actions";
  const check = textElement(doc, "button", "", "Fiyatı kontrol et");
  check.type = "button";
  check.dataset.action = "check";
  check.dataset.asin = product.asin;
  const remove = textElement(doc, "button", "remove", "Listeden kaldır");
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.dataset.asin = product.asin;
  actions.append(check, remove);
  row.append(actions);
  return row;
}

export function renderProductRows(doc, container, products, emptyState) {
  container.replaceChildren();
  const records = Object.values(products || {}).sort((left, right) => String(right.addedAt).localeCompare(String(left.addedAt)));
  emptyState.hidden = records.length > 0;
  for (const product of records) container.append(createProductRow(doc, product));
}
