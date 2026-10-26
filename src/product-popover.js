const EDGE = 12;
const GAP = 6;

export function positionProductPopover(anchor, panel, viewport) {
  const width = Math.min(panel.width, viewport.width - EDGE * 2);
  const height = Math.min(panel.height, 280, viewport.height - EDGE * 2);
  const below = viewport.height - EDGE - anchor.bottom - GAP;
  const above = anchor.top - EDGE - GAP;
  const openAbove = below < height && above > below;
  const space = Math.max(0, openAbove ? above : below);
  const visibleHeight = Math.min(height, space);
  return {
    left: Math.max(EDGE, Math.min(anchor.right - width, viewport.width - EDGE - width)),
    top: openAbove ? anchor.top - GAP - visibleHeight : anchor.bottom + GAP,
    maxHeight: visibleHeight
  };
}

export function createProductPopoverController(doc, viewport) {
  let active = null;
  const observed = new WeakSet();

  function close() {
    if (!active) return;
    const { panel, trigger } = active;
    active = null;
    trigger.setAttribute("aria-expanded", "false");
    if (panel.matches(":popover-open")) panel.hidePopover();
  }

  function place() {
    if (!active) return;
    const { panel, trigger } = active;
    panel.style.maxHeight = `${Math.max(0, Math.min(280, viewport.innerHeight - EDGE * 2))}px`;
    const position = positionProductPopover(trigger.getBoundingClientRect(), panel.getBoundingClientRect(),
      { width: viewport.innerWidth, height: viewport.innerHeight });
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.maxHeight = `${position.maxHeight}px`;
  }

  doc.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !active) return;
    event.preventDefault();
    const trigger = active.trigger;
    close();
    trigger.focus({ preventScroll: true });
  });
  doc.addEventListener("click", event => {
    if (active && !active.panel.contains(event.target) && !active.trigger.contains(event.target)) close();
  });
  viewport.addEventListener("resize", place);
  viewport.addEventListener("scroll", place, true);

  return {
    close,
    toggle(trigger, panel) {
      if (active?.panel === panel) { close(); return; }
      close();
      active = { trigger, panel };
      if (!observed.has(panel)) {
        observed.add(panel);
        panel.addEventListener("toggle", event => {
          if (event.newState !== "closed") return;
          trigger.setAttribute("aria-expanded", "false");
          if (active?.panel === panel) active = null;
        });
      }
      panel.showPopover();
      trigger.setAttribute("aria-expanded", "true");
      place();
      panel.focus({ preventScroll: true });
    }
  };
}
