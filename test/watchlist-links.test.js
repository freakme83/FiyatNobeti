import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProductRow } from "../src/watchlist-view.js";

const asin = "B0D47HCRZ6";
const canonicalUrl = `https://www.amazon.com.tr/dp/${asin}`;

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
}

function render(overrides = {}) {
  const product = {
    asin, canonicalUrl, title: "Example product", addedAt: "2026-10-24T10:00:00.000Z",
    lastSuccessfulPriceTry: null, lastSuccessfulCheckAt: null,
    lastAttemptedCheckAt: null, lastCheckStatus: "never", lastErrorCode: null,
    ...overrides
  };
  return createProductRow({ createElement: tagName => new Element(tagName), createElementNS: (_ns, tagName) => new Element(tagName) }, product);
}

test("a known title is a native new-tab link to the canonical identity URL", () => {
  const row = render({ canonicalUrl: "https://evil.example/redirect?target=amazon" });
  const heading = row.children[0];
  const link = heading.children[0];
  assert.equal(heading.tagName, "h3");
  assert.equal(link.tagName, "a");
  assert.equal(link.textContent, "Example product");
  assert.equal(link.title, "Example product");
  assert.equal(link.href, canonicalUrl);
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(row.children.at(-1).children.at(-1).children[0].children[0].textContent, asin);
});

test("a missing title gets the same clickable fallback", () => {
  const link = render({ title: null }).children[0].children[0];
  assert.equal(link.tagName, "a");
  assert.equal(link.textContent, "Amazon ürünü");
  assert.equal(link.href, canonicalUrl);
});

test("unsafe identity data cannot produce an external link, and untrusted titles remain text", () => {
  const untrusted = '<img src=x onerror="alert(1)">';
  const link = render({ title: untrusted, canonicalUrl: "javascript:alert(1)" }).children[0].children[0];
  assert.equal(link.textContent, untrusted);
  assert.deepEqual(link.children, []);
  assert.equal(link.href, canonicalUrl);
  for (const invalid of ["https://www.amazon.com.tr/dp/B0D47HCRZ6", "B0D47HCRZ!", "B0D47HCRZ6<script>", null]) {
    const heading = render({ asin: invalid, canonicalUrl: "https://evil.example/" }).children[0];
    assert.equal(heading.children.length, 0);
    assert.equal(heading.textContent, "Example product");
  }
});

test("the title link is independent of the existing check and remove controls", async () => {
  const row = render();
  const actions = row.children.at(-1);
  assert.equal(actions.className, "product-actions");
  assert.deepEqual(actions.children.slice(0, 2).map(button => [button.tagName, button.type, button.dataset.action, button.dataset.asin]), [
    ["button", "button", "check", asin], ["button", "button", "remove", asin]
  ]);
  assert.equal(actions.children[1].children[0].tagName, "svg");
  assert.equal(actions.children[1].children[0]["aria-hidden"], "true");
  assert.equal(actions.children[1].ariaLabel, "Listeden kaldır");
  assert.equal(actions.children[2].tagName, "button");
  assert.equal(actions.children[2].textContent, "Ayrıntılar");
  assert.equal(actions.children[3].popover, "manual");
  assert.equal(row.children[0].children[0].dataset.action, undefined);
  const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
  assert.match(css, /\.product-title a:focus-visible\s*\{/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /\.product-actions \.remove\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;/);
});
