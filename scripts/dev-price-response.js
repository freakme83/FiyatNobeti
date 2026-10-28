import { extractPrimaryPrice, extractProductTitle, inspectPayablePriceCandidate, parseTurkishPrice } from "../src/price.js";

const MAX_COUNT = 100;
const MAX_LABELS_INSPECTED = 3;
const MAX_ANCESTRY_DEPTH = 8;
const MAX_QUALIFICATION_DEPTH = 32;
const MAX_CLASSES_SCANNED = 128;
const MAX_RECOGNIZED_CLASSES_PER_NODE = 8;
const MAX_REGION_TOKENS = 5;
const MAX_PRIMARY_CANDIDATES = 40;
const MAX_HEADINGS_PER_ROW = 20;
const NEW_OFFER_LABEL = /^Yenisini Satın Al(?:$|[\s:·–—])/iu;
const NON_NEW_OFFER_LABEL = /^(?:Kullanılmış|Yenilenmiş|İkinci el|Used|Refurbished|Renewed|Second hand)(?:$|[\s:·–—])/iu;

// Only exact, stable Amazon layout tokens may leave the diagnostic.
const SAFE_IDS = new Set([
  "apex-pricetopay-accessibility-label",
  "apex_offerDisplay_expanded",
  "apex-pricetopay_feature_div",
  "apex_pricetopay_feature_div",
  "apex_desktop",
  "buybox",
  "centerCol",
  "corePrice_feature_div",
  "corePriceDisplay_desktop_feature_div",
  "desktop_qualifiedBuyBox",
  "desktop_buybox",
  "rightCol"
]);
const SAFE_CLASSES = new Set([
  "a-offscreen",
  "a-price",
  "a-price-fraction",
  "a-price-symbol",
  "a-price-whole",
  "a-text-price",
  "apex-priceperunit",
  "apex-priceperunit-alt",
  "apex-priceperunit-container",
  "apex-priceperunit-desktop",
  "apex-pricetoprice",
  "apex-core-price-identifier"
]);
const PRICE_REGION_IDS = new Set([
  "apex-pricetopay_feature_div",
  "apex_pricetopay_feature_div"
]);
const PURCHASE_REGION_IDS = new Set([
  "apex_desktop", "apex_offerDisplay_expanded", "buybox", "centerCol",
  "corePriceDisplay_desktop_feature_div", "desktop_qualifiedBuyBox", "desktop_buybox", "rightCol"
]);
// This mirrors PR #8's existing rejection rule; matching values are never emitted.
const EXCLUDED_PRICE_CONTEXT = /(?:coupon|shipping|installment|monthly|used|other.?seller|recommend|similar|variation|format|unit|discount|list.?price)/i;

const capped = value => Math.min(value, MAX_COUNT);

function readStructuralNode(node) {
  const classList = node?.classList;
  const availableClasses = Number.isInteger(classList?.length) ? classList.length : 0;
  const scannedLength = Math.min(availableClasses, MAX_CLASSES_SCANNED);
  const classes = [];
  for (let index = 0; index < scannedLength; index++) {
    const value = classList.item(index);
    if (typeof value === "string" && value) classes.push(value);
  }
  const rawId = typeof node?.id === "string" ? node.id : "";
  const tagName = typeof node?.tagName === "string" && /^[a-z][a-z0-9-]{0,20}$/i.test(node.tagName)
    ? node.tagName.toLowerCase()
    : "unknown";
  return {
    node,
    tagName,
    safeId: SAFE_IDS.has(rawId) ? rawId : null,
    hasId: Boolean(rawId),
    classes,
    classesTruncated: availableClasses > MAX_CLASSES_SCANNED
  };
}

function isExcludedPriceContext(candidate) {
  let ancestor = candidate?.parentElement;
  let visited = 0;
  let truncationReason = null;
  for (; ancestor && visited < MAX_QUALIFICATION_DEPTH; ancestor = ancestor.parentElement, visited++) {
    const structure = readStructuralNode(ancestor);
    if (structure.classes.some(className => EXCLUDED_PRICE_CONTEXT.test(className)) ||
        EXCLUDED_PRICE_CONTEXT.test(typeof ancestor.id === "string" ? ancestor.id : "")) {
      return { excluded: true, truncated: false, truncationReason: null };
    }
    if (structure.classesTruncated) truncationReason ||= "CLASS_TOKEN_LIMIT";
  }
  if (ancestor) truncationReason = "ANCESTRY_DEPTH_LIMIT";
  return { excluded: false, truncated: Boolean(truncationReason), truncationReason };
}

function safeAncestry(candidate) {
  const ancestry = [];
  let node = candidate;
  while (node && ancestry.length < MAX_ANCESTRY_DEPTH) {
    const structure = readStructuralNode(node);
    const safeClasses = [...new Set(structure.classes.filter(className => SAFE_CLASSES.has(className)))].slice(0, MAX_RECOGNIZED_CLASSES_PER_NODE);
    const unknownClassCount = structure.classes.filter(className => !SAFE_CLASSES.has(className)).length;
    ancestry.push({
      tagName: structure.tagName,
      id: structure.hasId ? (structure.safeId || "redacted") : null,
      recognizedClassTokens: safeClasses,
      redactedClassCount: capped(unknownClassCount),
      classListTruncated: structure.classesTruncated
    });
    node = node.parentElement;
  }
  return { ancestry, truncated: Boolean(node) };
}

function nearbyPriceRegion(candidate, recognizedMainPurchaseRegion) {
  const tokens = [];
  let kind = null;
  let ancestor = candidate?.parentElement;
  let depth = 0;
  while (ancestor && depth < MAX_ANCESTRY_DEPTH && tokens.length < MAX_REGION_TOKENS) {
    const structure = readStructuralNode(ancestor);
    for (const className of structure.classes) {
      if (className === "apex-pricetoprice" && tokens.length < MAX_REGION_TOKENS) {
        tokens.push(`class:${className}`);
        if (!kind) kind = "PRICE_TO_PAY";
      }
    }
    if (structure.safeId && (PRICE_REGION_IDS.has(structure.safeId) || PURCHASE_REGION_IDS.has(structure.safeId) || structure.safeId === "corePrice_feature_div")) {
      tokens.push(`id:${structure.safeId}`);
      if (!kind) {
        kind = PRICE_REGION_IDS.has(structure.safeId) ? "PRICE_TO_PAY" :
          ["apex_offerDisplay_expanded", "corePriceDisplay_desktop_feature_div", "desktop_qualifiedBuyBox"].includes(structure.safeId) ? "PURCHASING_REGION" :
          structure.safeId === "corePrice_feature_div" ? "PRIMARY_PRICE_CONTAINER" : "PURCHASING_REGION";
      }
    }
    ancestor = ancestor.parentElement;
    depth++;
  }
  return {
    identified: Boolean(kind),
    kind: recognizedMainPurchaseRegion ? "MAIN_PURCHASE_PRICE_REGION" : (kind || "UNKNOWN"),
    tokens: tokens.slice(0, MAX_REGION_TOKENS),
    truncated: Boolean(ancestor)
  };
}

function qualifiesFallback(doc, candidate, allCandidates, primaryGate, excludedContext) {
  if (primaryGate) return { wouldQualify: false, rejectionReason: primaryGate };
  if (allCandidates.length > 1) return { wouldQualify: false, rejectionReason: "MULTIPLE_LABELS" };
  if (excludedContext.excluded) return { wouldQualify: false, rejectionReason: "EXCLUDED_CONTEXT" };
  if (excludedContext.truncated) return { wouldQualify: null, rejectionReason: excludedContext.truncationReason };
  const result = inspectPayablePriceCandidate(doc, candidate);
  return { wouldQualify: result.qualified, rejectionReason: result.rejectionReason };
}

function inspectPayablePriceLabels(doc, labels, core, parserOutcome, primaryGate) {
  return {
    inspectedCount: Math.min(labels.length, MAX_LABELS_INSPECTED),
    inspectionTruncated: labels.length > MAX_LABELS_INSPECTED,
    elements: labels.slice(0, MAX_LABELS_INSPECTED).map(candidate => {
      const excludedContext = isExcludedPriceContext(candidate);
      const qualification = ["BOT_VERIFICATION", "ACCESS_DENIED", "AUTH_REQUIRED"].includes(parserOutcome.errorCode)
        ? { wouldQualify: false, rejectionReason: "SECURITY_OR_AUTH_PAGE" }
        : qualifiesFallback(doc, candidate, labels, primaryGate, excludedContext);
      const structuralQualification = inspectPayablePriceCandidate(doc, candidate);
      const ancestry = safeAncestry(candidate);
      return {
        insidePrimaryContainer: Boolean(core?.contains?.(candidate)),
        tagName: readStructuralNode(candidate).tagName,
        ancestry: ancestry.ancestry,
        ancestryTruncated: ancestry.truncated,
        nearbyPriceRegion: nearbyPriceRegion(candidate, structuralQualification.purchaseRegion),
        insideExcludedContext: excludedContext.excluded,
        fallback: qualification
      };
    })
  };
}

export function inspectPriceDocument(doc) {
  const core = doc.querySelector("#corePrice_feature_div");
  const offscreen = doc.querySelectorAll(".a-price .a-offscreen");
  const apex = [...doc.querySelectorAll("#apex-pricetopay-accessibility-label")];
  const parsed = extractPrimaryPrice(doc);
  const primaryCandidates = core ? [...core.querySelectorAll(".a-offscreen")].filter(candidate => {
    let ancestor = candidate.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
      const classes = ancestor.classList;
      if (!classes || !Number.isInteger(classes.length) || typeof classes.item !== "function") continue;
      for (let index = 0; index < classes.length; index++) {
        if (typeof classes.item(index) === "string" && classes.item(index).startsWith("apex-priceperuni")) return false;
      }
    }
    return true;
  }) : [];
  let primaryGate = null;
  if (!core) primaryGate = "PRIMARY_CONTAINER_MISSING";
  else if (primaryCandidates.length > 1) primaryGate = "PRIMARY_PRICE_AMBIGUOUS";
  else if (primaryCandidates.length === 1 && primaryCandidates[0].textContent?.trim()) {
    primaryGate = parseTurkishPrice(primaryCandidates[0].textContent) === null
      ? "PRIMARY_PRICE_UNRECOGNIZED"
      : "PRIMARY_PRICE_PRESENT";
  }
  const securityPage = ["BOT_VERIFICATION", "ACCESS_DENIED", "AUTH_REQUIRED"].includes(parsed.errorCode);
  const fallbackPathEligible = !securityPage && !primaryGate;
  return {
    documentTitlePresent: Boolean(doc.querySelector("title")?.textContent?.trim()),
    productTitleElementPresent: Boolean(doc.querySelector("#productTitle")),
    recognizableProductTitle: Boolean(extractProductTitle(doc)),
    primaryContainerPresent: Boolean(core),
    primaryCandidateCount: capped(core?.querySelectorAll(".a-offscreen").length || 0),
    alternatives: {
      apexPriceToPayLabelCount: capped(apex.length),
      apexPriceToPayCountCapped: apex.length > MAX_COUNT,
      apexPriceToPayOutsidePrimaryCount: capped(apex.filter(node => !core?.contains(node)).length),
      apexPriceToPay: inspectPayablePriceLabels(doc, apex, core, parsed, primaryGate),
      priceOffscreenOutsidePrimaryCount: capped([...offscreen].filter(node => !core?.contains(node)).length)
    },
    parserOutcome: {
      status: parsed.status,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      fallbackEligible: fallbackPathEligible
    },
    securityPageSuspected: ["BOT_VERIFICATION", "ACCESS_DENIED", "AUTH_REQUIRED"].includes(parsed.errorCode)
  };
}

function leadingDirectHeadingText(heading) {
  let text = "";
  let hasLeadingText = false;
  for (const child of heading?.childNodes || []) {
    if (child.nodeType === 3) {
      const value = child.nodeValue || "";
      text += ` ${value}`;
      if (value.trim()) hasLeadingText = true;
      continue;
    }
    if (child.nodeType === 1 && ["STYLE", "SCRIPT"].includes(child.tagName?.toUpperCase())) continue;
    break;
  }
  return { text: text.replace(/\s+/g, " ").trim(), hasLeadingText };
}

function primaryOfferCondition(candidate, primaryContainer) {
  const row = candidate?.closest?.(".a-accordion-row");
  if (!row) {
    return {
      hasAccordionRow: false, rowInsidePrimaryContainer: false, headingCount: 0,
      classification: "unknown", leadingDirectTextPresent: false
    };
  }
  const rowInsidePrimaryContainer = Boolean(primaryContainer?.contains?.(row));
  const headings = [...row.querySelectorAll("h5")];
  const boundedHeadings = headings.slice(0, MAX_HEADINGS_PER_ROW);
  const heading = boundedHeadings.length === 1 ? boundedHeadings[0] : null;
  const directText = leadingDirectHeadingText(heading);
  let classification = "unknown";
  if (rowInsidePrimaryContainer && heading) {
    if (NEW_OFFER_LABEL.test(directText.text)) classification = "new";
    else if (NON_NEW_OFFER_LABEL.test(directText.text)) classification = "non-new";
  }
  return {
    hasAccordionRow: true,
    rowInsidePrimaryContainer,
    headingCount: Math.min(headings.length, MAX_HEADINGS_PER_ROW),
    ...(headings.length > MAX_HEADINGS_PER_ROW ? { headingCountTruncated: true } : {}),
    classification,
    leadingDirectTextPresent: directText.hasLeadingText
  };
}

function parserRejectionReason(parsed, candidates) {
  if (parsed.status === "success") return null;
  if (parsed.errorCode === "PRICE_AMBIGUOUS") {
    const unknown = candidates.find(candidate => candidate.classification === "unknown");
    if (unknown) {
      if (!unknown.hasAccordionRow) return "OFFER_ROW_MISSING";
      if (!unknown.rowInsidePrimaryContainer) return "OFFER_ROW_OUTSIDE_PRIMARY_CONTAINER";
      if (unknown.headingCount !== 1) return "OFFER_HEADING_COUNT_UNEXPECTED";
      if (!unknown.leadingDirectTextPresent) return "OFFER_HEADING_LEADING_TEXT_MISSING";
      return "OFFER_CONDITION_UNKNOWN";
    }
    if (candidates.filter(candidate => candidate.classification === "new").length > 1) return "MULTIPLE_NEW_OFFERS";
    return "PARSER_PRICE_AMBIGUOUS";
  }
  if (parsed.errorCode === "PRICE_MISSING" && candidates.length &&
      candidates.every(candidate => candidate.classification === "non-new")) return "NO_NEW_OFFER";
  if (parsed.errorCode === "PRICE_UNRECOGNIZED") return "PRICE_FORMAT_INVALID";
  return parsed.errorCode || "PARSER_REJECTED";
}

export function inspectPrimaryPriceStructure(doc, parsed = extractPrimaryPrice(doc)) {
  const primaryContainer = doc.querySelector("#corePrice_feature_div");
  const allCandidates = primaryContainer
    ? [...primaryContainer.querySelectorAll(".a-offscreen")].filter(candidate => {
      let ancestor = candidate.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
        const classes = ancestor.classList;
        if (!classes || !Number.isInteger(classes.length) || typeof classes.item !== "function") continue;
        for (let index = 0; index < classes.length; index++) {
          if (typeof classes.item(index) === "string" && classes.item(index).startsWith("apex-priceperuni")) return false;
        }
      }
      return true;
    })
    : [];
  const inspectedCandidates = allCandidates.map(candidate => ({
    ...primaryOfferCondition(candidate, primaryContainer),
    priceFormatValid: parseTurkishPrice(typeof candidate.textContent === "string" ? candidate.textContent : "") !== null
  }));
  const candidates = inspectedCandidates.slice(0, MAX_PRIMARY_CANDIDATES);
  return {
    primaryCandidateCount: Math.min(allCandidates.length, MAX_PRIMARY_CANDIDATES),
    ...(allCandidates.length > MAX_PRIMARY_CANDIDATES ? { primaryCandidateCountTruncated: true } : {}),
    candidates,
    parserOutcome: {
      status: parsed.status === "success" ? "success" : "failure",
      ...(typeof parsed.errorCode === "string" && /^[A-Z0-9_]{1,40}$/.test(parsed.errorCode) ? { errorCode: parsed.errorCode } : {}),
      rejectionReason: parserRejectionReason(parsed, inspectedCandidates)
    }
  };
}

export function installDeveloperPriceParser(chromeApi = chrome) {
  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["PARSE_HTML_DIAG", "PARSE_HTML_STRUCTURE_DIAG"].includes(message?.type) || sender.id !== chromeApi.runtime.id) return;
    try {
      const doc = new DOMParser().parseFromString(message.html, "text/html");
      const result = extractPrimaryPrice(doc);
      if (message.type === "PARSE_HTML_STRUCTURE_DIAG") {
        sendResponse({
          ...result,
          ...(result.status === "success" ? { title: extractProductTitle(doc) } : {}),
          priceStructureDiagnostic: inspectPrimaryPriceStructure(doc, result)
        });
        return;
      }
      sendResponse({ ...result,
        ...(result.status === "success" ? { title: extractProductTitle(doc) } : {}),
        diagnostics: inspectPriceDocument(doc) });
    } catch {
      sendResponse({ status: "failure", errorCode: "PARSE_ERROR" });
    }
  });
}
