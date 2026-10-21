import { parseAmazonInput } from "./src/url.js";

const origin = "https://www.amazon.com.tr/*";
const shortLinkOrigin = "https://amzn.eu/*";
const form = document.querySelector("#probe-form");
const input = document.querySelector("#product-url");
const button = document.querySelector("#check-button");
const status = document.querySelector("#status");
const latest = document.querySelector("#latest");
const previous = document.querySelector("#previous");

const errors = {
  INVALID_URL: "Güvenli ve geçerli bir Amazon bağlantısı girin.",
  UNSUPPORTED_URL: "Bu Amazon bağlantı biçimi desteklenmiyor.",
  UNSUPPORTED_MARKETPLACE: "Bu bağlantı Amazon Türkiye'ye ait değil.",
  PERMISSION_REQUIRED: "Amazon Türkiye izni verilmedi.",
  SHORT_LINK_PERMISSION_REQUIRED: "Kısa Amazon bağlantısı izni verilmedi.",
  SHORT_LINK_RESOLUTION_FAILED: "Kısa Amazon bağlantısı güvenli biçimde çözümlenemedi.",
  SHORT_LINK_OPAQUE_REDIRECT: "Kısa Amazon bağlantısının yönlendirme adresi tarayıcı tarafından gizlendi.",
  SHORT_LINK_LOCATION_MISSING: "Kısa Amazon bağlantısı yanıtında yönlendirme adresi bulunamadı.",
  SHORT_LINK_HTTP_STATUS: "Kısa Amazon bağlantısı beklenmeyen bir HTTP yanıtı verdi.",
  SHORT_LINK_NETWORK_ERROR: "Kısa Amazon bağlantısı için ağ isteği başarısız oldu.",
  SHORT_LINK_TIMEOUT: "Kısa Amazon bağlantısının yanıtı zaman aşımına uğradı.",
  SHORT_LINK_REDIRECT_LOOP: "Kısa bağlantıda yönlendirme döngüsü algılandı.",
  SHORT_LINK_TOO_MANY_REDIRECTS: "Kısa bağlantı çok fazla kez yönlendirildi.",
  SHORT_LINK_UNSAFE_REDIRECT: "Kısa bağlantı güvenli olmayan veya desteklenmeyen bir adrese yönlendirildi.",
  SHORT_LINK_UNSUPPORTED_MARKETPLACE: "Kısa bağlantı Amazon Türkiye dışındaki bir pazaryerine yönlendirildi.",
  REDIRECT: "Amazon sayfayı başka bir adrese yönlendirdi; fiyat doğrulanamadı.",
  ACCESS_DENIED: "Amazon erişimi reddetti.",
  BOT_VERIFICATION: "Amazon robot doğrulaması istedi; fiyat okunamadı.",
  AUTH_REQUIRED: "Amazon giriş yapılmasını istiyor; fiyat okunamadı.",
  HTTP_ERROR: "Amazon sayfası yüklenemedi.",
  HTML_STRUCTURE: "Beklenen ürün fiyatı bölümü bulunamadı.",
  PRICE_MISSING: "Ürünün birincil fiyatı bulunamadı.",
  PRICE_AMBIGUOUS: "Birden çok birincil fiyat bulundu; sonuç güvenilir değil.",
  PRICE_UNRECOGNIZED: "Birincil fiyatın TL biçimi tanınamadı.",
  RESPONSE_TOO_LARGE: "Sayfa güvenli boyut sınırını aştı.",
  TIMEOUT: "Amazon yanıtı zaman aşımına uğradı.",
  NETWORK_ERROR: "Ağ veya ayrıştırma hatası oluştu.",
  PARSE_ERROR: "Ürün sayfası ayrıştırılamadı."
};

const formatPrice = value => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value);
const formatTime = value => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

function formatShortLinkDiagnostics(diagnostics = {}) {
  const parts = [];
  if (Number.isInteger(diagnostics.httpStatus) && diagnostics.httpStatus >= 100 && diagnostics.httpStatus <= 599) {
    parts.push(`HTTP durumu: ${diagnostics.httpStatus}`);
  }
  if (["basic", "cors", "default", "error", "opaque", "opaqueredirect"].includes(diagnostics.responseType)) {
    parts.push(`Yanıt türü: ${diagnostics.responseType}`);
  }
  if (Number.isInteger(diagnostics.redirectCount) && diagnostics.redirectCount >= 0 && diagnostics.redirectCount <= 5) {
    parts.push(`Yönlendirme sayısı: ${diagnostics.redirectCount}`);
  }
  if (typeof diagnostics.locationAccessible === "boolean") {
    parts.push(`Location erişilebilir: ${diagnostics.locationAccessible ? "Evet" : "Hayır"}`);
  }
  return parts.join(" · ");
}

function renderSection(element, heading, result) {
  element.replaceChildren();
  if (!result) { element.hidden = true; return; }
  const title = document.createElement("h2");
  title.textContent = heading;
  const detail = document.createElement("p");
  detail.className = result.status === "success" ? "price" : "error";
  detail.textContent = result.status === "success"
    ? formatPrice(result.priceTry)
    : errors[result.errorCode] || "Fiyat doğrulanamadı.";
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [result.asin, result.checkedAt && formatTime(result.checkedAt), result.errorCode, result.httpStatus && `HTTP ${result.httpStatus}`]
    .filter(Boolean).join(" · ");
  element.append(title, detail, meta);
  const diagnosticText = result.errorCode?.startsWith("SHORT_LINK_")
    ? formatShortLinkDiagnostics(result.diagnostics)
    : "";
  if (diagnosticText) {
    const diagnostic = document.createElement("p");
    diagnostic.className = "meta";
    diagnostic.textContent = diagnosticText;
    element.append(diagnostic);
  }
  element.hidden = false;
}

function render(lastCheck, lastSuccess) {
  renderSection(latest, lastCheck?.status === "success" ? "Son başarılı kontrol" : "Son kontrol başarısız", lastCheck);
  const older = lastSuccess && (
    lastCheck?.status !== "success" || lastSuccess.checkedAt !== lastCheck.checkedAt
  ) ? lastSuccess : null;
  renderSection(previous, "Önceki başarılı kontrol (güncel değil)", older);
}

async function restore() {
  try {
    const { lastCheck, lastSuccess } = await chrome.storage.local.get(["lastCheck", "lastSuccess"]);
    if (lastCheck?.canonicalUrl) input.value = lastCheck.canonicalUrl;
    render(lastCheck, lastSuccess);
  } catch {
    status.textContent = "Kayıtlı sonuçlar okunamadı.";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  let request;
  try {
    request = parseAmazonInput(input.value);
  } catch (error) {
    status.textContent = errors[error.message] || errors.INVALID_URL;
    return;
  }

  button.disabled = true;
  status.textContent = request.type === "short"
    ? "Amazon bağlantısı çözümleniyor…"
    : "Fiyat kontrol ediliyor…";
  try {
    const origins = request.type === "short" ? [origin, shortLinkOrigin] : [origin];
    // İzin isteme çağrısı doğrudan kullanıcının tıklamasıyla başlar.
    try { await chrome.permissions.request({ origins }); } catch { /* worker kaydeder */ }
    const result = await chrome.runtime.sendMessage({ type: "CHECK_PRICE", url: input.value });
    if (!result || !["success", "failure"].includes(result.status)) throw new Error("BAD_RESPONSE");
    if (result.canonicalUrl) input.value = result.canonicalUrl;
    status.textContent = result.storageError ? "Kontrol tamamlandı ancak sonuç yerel olarak kaydedilemedi." : "Kontrol tamamlandı.";
    const { lastCheck, lastSuccess } = await chrome.storage.local.get(["lastCheck", "lastSuccess"]);
    render(result.storageError ? result : lastCheck, lastSuccess);
  } catch {
    status.textContent = "Kontrol tamamlanamadı. Tekrar deneyin.";
  } finally {
    button.disabled = false;
  }
});

restore();
