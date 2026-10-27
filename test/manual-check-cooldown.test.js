import test from "node:test";
import assert from "node:assert/strict";
import {
  MANUAL_CHECK_COOLDOWN_MS,
  formatManualCooldown,
  isManualCooldownActive,
  manualCheckCooldownRemaining,
  manualCheckCooldownUntil
} from "../src/manual-check-cooldown.js";
import { createManualCheckTooltipController } from "../src/manual-check-tooltip.js";

test("per-product manual cooldown uses an exact 180-second boundary and readable mm:ss", () => {
  const started = "2026-10-26T10:00:00.000Z";
  const until = Date.parse(started) + MANUAL_CHECK_COOLDOWN_MS;
  assert.equal(manualCheckCooldownUntil(started), until);
  assert.equal(manualCheckCooldownRemaining(started, until - 1), 1);
  assert.equal(manualCheckCooldownRemaining(started, until), 0);
  assert.equal(manualCheckCooldownRemaining("not-a-date", until), 0);
  assert.equal(isManualCooldownActive(until, until - 1), true);
  assert.equal(isManualCooldownActive(until, until), false);
  assert.equal(formatManualCooldown(88_001), "01:29");
  assert.equal(formatManualCooldown(0), "00:00");
});

function createFixture() {
  const listeners = new Map();
  const root = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch(type, event) { listeners.get(type)?.(event); }
  };
  const attributes = new Map([["aria-disabled", "true"], ["aria-describedby", "tooltip"]]);
  const button = {
    dataset: { cooldownUntil: String(Date.now() + 90_000) },
    getAttribute(name) { return attributes.get(name) || null; },
    removeAttribute(name) { attributes.delete(name); }
  };
  const tooltip = { hidden: true, textContent: "" };
  const wrap = {
    className: "product-check-wrap cooldown-active",
    querySelector(selector) { return selector === ".manual-check-tooltip" ? tooltip : button; },
    contains() { return false; }
  };
  const target = { closest(selector) { return selector === ".product-check-wrap" ? wrap : null; } };
  return { root, listeners, button, tooltip, wrap, target };
}

test("cooldown explanation opens on pointer or keyboard focus, counts down, and cleans up", () => {
  const RealDate = globalThis.Date;
  let now = Date.parse("2026-10-26T10:00:00.000Z");
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const timerCallbacks = new Map();
  let nextTimer = 0;
  const timers = {
    setInterval(callback) { const id = ++nextTimer; timerCallbacks.set(id, callback); return id; },
    clearInterval(id) { timerCallbacks.delete(id); }
  };
  try {
    const fixture = createFixture();
    fixture.button.dataset.cooldownUntil = String(now + 90_000);
    const controller = createManualCheckTooltipController(fixture.root, timers);
    fixture.root.dispatch("pointerover", { target: fixture.target, relatedTarget: null });
    assert.equal(fixture.tooltip.hidden, false);
    assert.equal(fixture.tooltip.textContent, "Elle yeniden kontrol için 01:30");
    now += 1000;
    [...timerCallbacks.values()][0]();
    assert.equal(fixture.tooltip.textContent, "Elle yeniden kontrol için 01:29");
    fixture.root.dispatch("pointerout", { target: fixture.target, relatedTarget: null });
    assert.equal(fixture.tooltip.hidden, true);
    fixture.root.dispatch("focusin", { target: fixture.target });
    assert.equal(fixture.tooltip.hidden, false);
    now = Number(fixture.button.dataset.cooldownUntil);
    [...timerCallbacks.values()][0]();
    assert.equal(fixture.tooltip.hidden, true);
    assert.equal(fixture.button.getAttribute("aria-disabled"), null);
    assert.equal(fixture.button.dataset.cooldownUntil, undefined);
    assert.equal(fixture.wrap.className, "product-check-wrap");
    controller.dispose();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(timerCallbacks.size, 0);
  } finally { globalThis.Date = RealDate; }
});
