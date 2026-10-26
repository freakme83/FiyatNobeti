import { formatManualCooldown, manualCheckCooldownRemaining } from "./manual-check-cooldown.js";

export function createManualCheckTooltipController(root, timers = globalThis) {
  let activeWrap = null;
  let hoveredWrap = null;
  let focusedWrap = null;
  let countdownTimer = null;
  let disposed = false;

  function hide() {
    if (!activeWrap) return;
    const tooltip = activeWrap.querySelector(".manual-check-tooltip");
    if (tooltip) tooltip.hidden = true;
    activeWrap = null;
    if (countdownTimer !== null) timers.clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function update() {
    if (!activeWrap || disposed) return;
    const button = activeWrap.querySelector('[data-action="check"]');
    const tooltip = activeWrap.querySelector(".manual-check-tooltip");
    if (!button || !tooltip) return hide();
    const remaining = Math.max(0, Number(button.dataset.cooldownUntil) - Date.now());
    if (remaining <= 0) {
      tooltip.hidden = true;
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-describedby");
      delete button.dataset.cooldownUntil;
      activeWrap.className = "product-check-wrap";
      hide();
      return;
    }
    tooltip.textContent = `Elle yeniden kontrol için ${formatManualCooldown(remaining)}`;
    tooltip.hidden = false;
  }

  function show(wrap) {
    const button = wrap?.querySelector('[data-action="check"]');
    if (!button || button.getAttribute("aria-disabled") !== "true") return;
    if (activeWrap !== wrap) hide();
    activeWrap = wrap;
    update();
    if (activeWrap && countdownTimer === null) countdownTimer = timers.setInterval(update, 1000);
  }

  function pointerOver(event) {
    const wrap = event.target.closest?.(".product-check-wrap");
    if (wrap && !wrap.contains(event.relatedTarget)) {
      hoveredWrap = wrap;
      show(wrap);
    }
  }
  function pointerOut(event) {
    const wrap = event.target.closest?.(".product-check-wrap");
    if (wrap && !wrap.contains(event.relatedTarget)) {
      if (hoveredWrap === wrap) hoveredWrap = null;
      if (activeWrap === wrap && focusedWrap !== wrap) hide();
    }
  }
  function focusIn(event) {
    focusedWrap = event.target.closest?.(".product-check-wrap") || null;
    show(focusedWrap);
  }
  function focusOut(event) {
    const wrap = event.target.closest?.(".product-check-wrap");
    if (wrap && !wrap.contains(event.relatedTarget)) {
      if (focusedWrap === wrap) focusedWrap = null;
      if (activeWrap === wrap && hoveredWrap !== wrap) hide();
    }
  }

  root.addEventListener("pointerover", pointerOver);
  root.addEventListener("pointerout", pointerOut);
  root.addEventListener("focusin", focusIn);
  root.addEventListener("focusout", focusOut);
  return {
    reset() {
      hoveredWrap = null;
      focusedWrap = null;
      hide();
    },
    dispose() {
      disposed = true;
      hoveredWrap = null;
      focusedWrap = null;
      hide();
      root.removeEventListener("pointerover", pointerOver);
      root.removeEventListener("pointerout", pointerOut);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
    }
  };
}
