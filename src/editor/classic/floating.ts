/** The source WordPress plugin renders its toolbars at document.body. Rehome
 * those existing controls inside the owning modal, preserving their source
 * viewport positioning, keyboard handlers and editor-owned remove lifecycle. */
export function containClassicToolbar(
  toolbar: any,
  host: HTMLElement,
  win: Window,
) {
  const element = toolbar?.getEl?.() as HTMLElement | undefined;
  if (!element || element.parentElement === host) return;
  host.appendChild(element);
  // The modal hid this former body sibling before it entered the modal.
  // TinyMCE controls visibility with display, so clear that stale aria flag.
  element.removeAttribute("aria-hidden");
  const reposition = toolbar.reposition;
  toolbar.reposition = function () {
    const result = reposition.apply(this, arguments);
    const rect = host.getBoundingClientRect();
    element.style.transform = `translate(${-rect.left - win.scrollX + host.scrollLeft}px, ${-rect.top - win.scrollY + host.scrollTop}px)`;
    return result;
  };
}

/** TinyMCE 4 windowManager also renders source dialogs and their blocker under
 * body. Keep them in the same Classic modal stacking/focus scope so a nested
 * React file picker can appear above them without dismissing the editor. */
export function containClassicWindow(
  control: any,
  host: HTMLElement,
  win: Window,
) {
  const element = control?.getEl?.() as HTMLElement | undefined;
  if (!element) return;
  host.appendChild(element);
  element.removeAttribute("aria-hidden");
  const position = () => {
    const rect = host.getBoundingClientRect();
    element.style.transform = `translate(${-rect.left}px, ${-rect.top}px)`;
  };
  const reflow = control.reflow;
  if (reflow)
    control.reflow = function () {
      const result = reflow.apply(this, arguments);
      position();
      return result;
    };
  position();
  const blocker = win.document.getElementById("mce-modal-block");
  if (blocker) {
    host.appendChild(blocker);
    const rect = host.getBoundingClientRect();
    blocker.style.transform = `translate(${-rect.left}px, ${-rect.top}px)`;
    blocker.style.width = `${win.innerWidth}px`;
    blocker.style.height = `${win.innerHeight}px`;
  }
}
