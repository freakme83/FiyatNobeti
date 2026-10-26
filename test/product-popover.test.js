import test from "node:test";
import assert from "node:assert/strict";
import { createProductPopoverController, positionProductPopover } from "../src/product-popover.js";

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
}

class Panel extends Events {
  constructor() { super(); this.style = {}; this.open = false; this.focused = false; }
  matches(selector) { assert.equal(selector, ":popover-open"); return this.open; }
  showPopover() { this.open = true; this.dispatch("toggle", { newState: "open" }); }
  hidePopover() { this.open = false; this.dispatch("toggle", { newState: "closed" }); }
  getBoundingClientRect() { return { width: 280, height: 180 }; }
  contains(target) { return target === this; }
  focus(options) { assert.equal(options.preventScroll, true); this.focused = true; }
}

function trigger(rect) {
  return {
    attributes: {}, rect, focused: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect() { return this.rect; },
    contains(target) { return target === this; },
    focus(options) { assert.equal(options.preventScroll, true); this.focused = true; }
  };
}

test("popover placement stays within narrow viewport and flips above near the bottom", () => {
  const viewport = { width: 320, height: 400 };
  const panel = { width: 280, height: 250 };
  const bottom = positionProductPopover({ top: 350, bottom: 382, right: 315 }, panel, viewport);
  assert.equal(bottom.left, 28);
  assert.equal(bottom.top, 94);
  assert.equal(bottom.maxHeight, 250);
  const top = positionProductPopover({ top: 8, bottom: 40, right: 30 }, panel, viewport);
  assert.equal(top.left, 12);
  assert.equal(top.top, 46);
  assert.ok(top.top + top.maxHeight <= viewport.height - 12);
  const short = positionProductPopover({ top: 45, bottom: 75, right: 315 }, panel, { width: 320, height: 125 });
  assert.ok(short.top >= 12 && short.top + short.maxHeight <= 113);
});

test("toggle, another product, light dismiss and Escape keep one panel and restore focus", () => {
  const doc = new Events();
  const viewport = new Events();
  viewport.innerWidth = 360;
  viewport.innerHeight = 600;
  const controller = createProductPopoverController(doc, viewport);
  const first = new Panel(), second = new Panel();
  const a = trigger({ top: 300, bottom: 332, right: 330 });
  const b = trigger({ top: 420, bottom: 452, right: 330 });
  controller.toggle(a, first);
  assert.equal(first.open, true);
  assert.equal(a.attributes["aria-expanded"], "true");
  assert.equal(first.focused, true);
  assert.ok(parseInt(first.style.left) >= 12);
  controller.toggle(a, first);
  assert.equal(first.open, false);
  controller.toggle(a, first);
  controller.toggle(b, second);
  assert.equal(first.open, false);
  assert.equal(second.open, true);
  assert.equal(a.attributes["aria-expanded"], "false");
  doc.dispatch("click", { target: {} });
  assert.equal(second.open, false);
  assert.equal(b.attributes["aria-expanded"], "false");
  controller.toggle(b, second);
  let prevented = false;
  doc.dispatch("keydown", { key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(second.open, false);
  assert.equal(b.focused, true);
  controller.toggle(a, first);
  controller.close(); // Called before list replacement or product removal.
  assert.equal(first.open, false);
  assert.equal(a.attributes["aria-expanded"], "false");
});
