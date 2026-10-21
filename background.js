import { parseAmazonInput } from "./src/url.js";
import { resolveAmazonShortLink } from "./src/shortlink.js";

const AMAZON_ORIGIN = "https://www.amazon.com.tr/*";
const SHORT_LINK_ORIGIN = "https://amzn.eu/*";
const OFFSCREEN_PATH = "offscreen.html";
const MAX_HTML_BYTES = 5 * 1024 * 1024;
let creatingOffscreen;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Elle getirilen Amazon HTML içeriğinde birincil fiyatı DOM ile ayrıştırmak"
    }).finally(() => { creatingOffscreen = undefined; });
  }
  await creatingOffscreen;
}

async function readLimitedHtml(response) {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_HTML_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("NETWORK_ERROR");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) throw new Error("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder("utf-8");
  return chunks.map((chunk, index) => decoder.decode(chunk, { stream: index < chunks.length - 1 })).join("") + decoder.decode();
}

async function probe(input) {
  let requested;
  try {
    requested = parseAmazonInput(input);
  } catch (error) {
    return { status: "failure", errorCode: error.message };
  }

  const result = {
    ...(requested.type === "product"
      ? { asin: requested.asin, canonicalUrl: requested.canonicalUrl }
      : { inputUrl: requested.shortUrl }),
    checkedAt: new Date().toISOString(),
    status: "failure"
  };
  try {
    let product = requested;
    if (requested.type === "short") {
      if (!await chrome.permissions.contains({ origins: [SHORT_LINK_ORIGIN] })) {
        result.errorCode = "SHORT_LINK_PERMISSION_REQUIRED";
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          product = await resolveAmazonShortLink(requested.shortUrl, { signal: controller.signal });
          result.asin = product.asin;
          result.canonicalUrl = product.canonicalUrl;
          delete result.inputUrl;
        } catch (error) {
          result.errorCode = error.message || "SHORT_LINK_RESOLUTION_FAILED";
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    if (!result.errorCode && !await chrome.permissions.contains({ origins: [AMAZON_ORIGIN] })) {
      result.errorCode = "PERMISSION_REQUIRED";
    } else if (!result.errorCode) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(product.canonicalUrl, {
          credentials: "omit",
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal
        });
        if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
          result.errorCode = "REDIRECT";
        } else if (response.status === 401 || response.status === 403) {
          result.errorCode = "ACCESS_DENIED";
        } else if (!response.ok) {
          result.errorCode = "HTTP_ERROR";
          result.httpStatus = response.status;
        } else if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
          result.errorCode = "HTML_STRUCTURE";
        } else {
          const html = await readLimitedHtml(response);
          await ensureOffscreen();
          const parsed = await chrome.runtime.sendMessage({ type: "PARSE_HTML", html });
          if (parsed?.status === "success" && Number.isFinite(parsed.priceTry)) {
            result.status = "success";
            result.priceTry = parsed.priceTry;
          } else {
            result.errorCode = parsed?.errorCode || "PARSE_ERROR";
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (error) {
    result.errorCode = error?.message === "RESPONSE_TOO_LARGE"
      ? "RESPONSE_TOO_LARGE"
      : error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
  }

  result.checkedAt = new Date().toISOString();
  try {
    const update = { lastCheck: result };
    if (result.status === "success") update.lastSuccess = result;
    await chrome.storage.local.set(update);
  } catch {
    return { ...result, storageError: true };
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CHECK_PRICE" || sender.id !== chrome.runtime.id) return;
  probe(message.url)
    .then(sendResponse)
    .catch(() => sendResponse({ status: "failure", errorCode: "NETWORK_ERROR" }));
  return true;
});
