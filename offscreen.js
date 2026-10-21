import { extractPrimaryPrice } from "./src/price.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PARSE_HTML" || sender.id !== chrome.runtime.id) return;
  try {
    const doc = new DOMParser().parseFromString(message.html, "text/html");
    sendResponse(extractPrimaryPrice(doc));
  } catch {
    sendResponse({ status: "failure", errorCode: "PARSE_ERROR" });
  }
});
