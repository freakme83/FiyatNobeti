import { extractPrimaryPrice, extractProductTitle } from "../src/price.js";

const capped = value => Math.min(value, 100);

export function inspectPriceDocument(doc) {
  const core = doc.querySelector("#corePrice_feature_div");
  const offscreen = doc.querySelectorAll(".a-price .a-offscreen");
  const apex = doc.querySelectorAll("#apex-pricetopay-accessibility-label");
  const parsed = extractPrimaryPrice(doc);
  return {
    documentTitlePresent: Boolean(doc.querySelector("title")?.textContent?.trim()),
    productTitleElementPresent: Boolean(doc.querySelector("#productTitle")),
    recognizableProductTitle: Boolean(extractProductTitle(doc)),
    primaryContainerPresent: Boolean(core),
    primaryCandidateCount: capped(core?.querySelectorAll(".a-offscreen").length || 0),
    alternatives: {
      apexPriceToPayLabelCount: capped(apex.length),
      apexPriceToPayOutsidePrimaryCount: capped([...apex].filter(node => !core?.contains(node)).length),
      priceOffscreenOutsidePrimaryCount: capped([...offscreen].filter(node => !core?.contains(node)).length)
    },
    securityPageSuspected: ["BOT_VERIFICATION", "ACCESS_DENIED", "AUTH_REQUIRED"].includes(parsed.errorCode)
  };
}

export function installDeveloperPriceParser(chromeApi = chrome) {
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "PARSE_HTML_DIAG" || sender.id !== chromeApi.runtime.id) return;
    try {
      const doc = new DOMParser().parseFromString(message.html, "text/html");
      const result = extractPrimaryPrice(doc);
      sendResponse({ ...result,
        ...(result.status === "success" ? { title: extractProductTitle(doc) } : {}),
        diagnostics: inspectPriceDocument(doc) });
    } catch {
      sendResponse({ status: "failure", errorCode: "PARSE_ERROR" });
    }
  });
}
