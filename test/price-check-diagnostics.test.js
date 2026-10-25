import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  appendDiagnosticHistory, completedCheckEntry, normalizeDiagnosticHistory,
  PRICE_CHECK_DIAGNOSTICS_KEY, sanitizeDiagnosticEntry
} from "../src/price-check-diagnostics.js";
import { copyDiagnosticHistory } from "../src/diagnostic-export.js";

const entry = (index, extra = {}) => ({
  checkedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  asin: "B0CYLSLBW4", origin: "manual", result: "success", ...extra
});

test("strict allowlist strips prices, titles, URLs, headers and arbitrary response text", () => {
  assert.deepEqual(sanitizeDiagnosticEntry(entry(1, {
    priceTry: 100, title: "secret", url: "https://example.com/?token=secret", headers: { cookie: "secret" },
    httpStatus: 200, contentType: "html", responseSizeBytesApprox: 2048, pageClass: "product"
  })), entry(1, { httpStatus: 200, contentType: "html", responseSizeBytesApprox: 2048, pageClass: "product" }));
  assert.equal(sanitizeDiagnosticEntry(entry(1, { result: "failure", errorCode: "ARBITRARY_SECRET" })), null);
  assert.equal(sanitizeDiagnosticEntry(entry(1, { asin: "BAD" })), null);
  assert.deepEqual(normalizeDiagnosticHistory({ version: 2, entries: [entry(1)] }), { version: 1, entries: [] });
  assert.deepEqual(normalizeDiagnosticHistory({ version: 1, entries: [null, entry(1)] }).entries, [entry(1)]);
});

test("completed checks retain only approximate response metadata and fixed page classes", () => {
  assert.deepEqual(completedCheckEntry({ asin: "B0CYLSLBW4", automatic: true, checkedAt: entry(0).checkedAt,
    result: { status: "failure", errorCode: "BOT_VERIFICATION", priceTry: 999 },
    response: { httpStatus: 200, contentType: "text/html", responseBytes: 1001, structure: { rawHtml: "secret" } } }),
  entry(0, { origin: "automatic", result: "failure", errorCode: "BOT_VERIFICATION", httpStatus: 200,
    contentType: "html", responseSizeBytesApprox: 1024, pageClass: "verification" }));
});

test("bounded serialized append preserves concurrent completions and sanitizes old entries", async () => {
  const state = { [PRICE_CHECK_DIAGNOSTICS_KEY]: { version: 1, entries: [entry(0, { title: "secret" })] } };
  const storage = {
    async get(key) { assert.equal(key, PRICE_CHECK_DIAGNOSTICS_KEY); return { [key]: state[key] }; },
    async set(value) { Object.assign(state, value); }
  };
  let queue = Promise.resolve();
  const serialize = value => { queue = queue.then(() => appendDiagnosticHistory(storage, value)); return queue; };
  await Promise.all(Array.from({ length: 35 }, (_, index) => serialize(entry(index + 1))));
  const history = state[PRICE_CHECK_DIAGNOSTICS_KEY];
  assert.equal(history.entries.length, 30);
  assert.deepEqual(history.entries, Array.from({ length: 30 }, (_, index) => entry(index + 6)));
  assert.ok(!JSON.stringify(history).includes("secret"));
});

test("collapsed export reads sanitized local data, handles empty and clipboard failure", async () => {
  let copied;
  const storage = { async get() { return { [PRICE_CHECK_DIAGNOSTICS_KEY]: { version: 1, entries: [entry(0, { rawHtml: "secret" })] } }; } };
  assert.equal(await copyDiagnosticHistory(storage, { async writeText(text) { copied = text; } }), "copied");
  assert.deepEqual(JSON.parse(copied), { version: 1, entries: [entry(0)] });
  assert.equal(await copyDiagnosticHistory({ async get() { return {}; } }, { async writeText() { throw new Error("must not write"); } }), "empty");
  await assert.rejects(copyDiagnosticHistory(storage, { async writeText() { throw new Error("denied"); } }), /denied/);
});

test("popup has a native collapsed diagnostic section and no card diagnostic fields", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  assert.match(html, /<details id="diagnostic-section">\s*<summary>Gelişmiş \/ Tanılama<\/summary>/);
  assert.match(html, /<button id="copy-diagnostics" type="button">Tanılama bilgisini kopyala<\/button>/);
  assert.doesNotMatch(html, /<details id="diagnostic-section"[^>]*\bopen\b/);
  const view = await readFile(new URL("../src/watchlist-view.js", import.meta.url), "utf8");
  assert.doesNotMatch(view, /priceCheckDiagnostics|httpStatus|responseSizeBytesApprox/);
});
