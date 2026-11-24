const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function createOverlayManager({ document }) {
  let current = null;
  let trigger = null;

  function focusables() {
    return current ? [...current.querySelectorAll(FOCUSABLE)].filter((element) => !element.hidden) : [];
  }

  function onKeyDown(event) {
    if (!current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open(element, source = document.activeElement) {
    close(false);
    current = element;
    trigger = source;
    current.hidden = false;
    current.setAttribute("aria-modal", "true");
    current.addEventListener("keydown", onKeyDown);
    focusables()[0]?.focus();
  }

  function close(restoreFocus = true) {
    if (!current) return;
    current.removeEventListener("keydown", onKeyDown);
    current.hidden = true;
    current.removeAttribute("aria-modal");
    const previousTrigger = trigger;
    current = null;
    trigger = null;
    if (restoreFocus) previousTrigger?.focus?.();
  }

  function confirm({ title = "Xác nhận thao tác", message = "", confirmLabel = "Xác nhận", cancelLabel = "Hủy", onConfirm, trigger: source } = {}) {
    const dialog = document.createElement("section");
    dialog.className = "overlay-confirmation";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", title);
    dialog.innerHTML = `<div class="overlay-confirmation__panel"><h2>${title}</h2><p>${message}</p><div><button type="button" data-cancel>${cancelLabel}</button><button type="button" data-confirm>${confirmLabel}</button></div></div>`;
    document.body.appendChild(dialog);
    dialog.querySelector("[data-cancel]").addEventListener("click", () => close());
    dialog.querySelector("[data-confirm]").addEventListener("click", () => {
      close();
      onConfirm?.();
    });
    open(dialog, source || document.activeElement);
    return dialog;
  }

  return { open, close, confirm };
}
