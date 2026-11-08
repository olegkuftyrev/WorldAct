/** Progressive enhancement of trusted server-rendered navigation disclosures. */
const selector = 'nav[data-worldact-interactive="navigation"]';
type Entry = { users: number; dispose: () => void };
const mounted = new WeakMap<HTMLElement, Entry>();
const documents = new WeakMap<Document, { open: Set<() => void>; locked: boolean; users:number }>();

function mount(root: HTMLElement) {
  const document = root.ownerDocument;
  const local = (node: Element) => node.closest(selector) === root;
  const disclosure = [...root.querySelectorAll<HTMLDetailsElement>('details[data-worldact-navigation-toggle]')].find(local);
  const opener = disclosure?.querySelector<HTMLElement>(':scope > summary[data-worldact-navigation-open]');
  const panel = [...root.querySelectorAll<HTMLElement>('[data-worldact-navigation-panel]')].find(local);
  const dialog = panel?.querySelector<HTMLElement>('[data-worldact-navigation-dialog]');
  if (!disclosure || !opener || !panel || !dialog || !panel.id || opener.getAttribute('aria-controls') !== panel.id || !disclosure.contains(panel)) return () => {};
  const abort = new AbortController(), restores: Array<() => void> = [];
  const previous = new WeakMap<Element, Set<string>>();
  const listen = (target: EventTarget, type: string, callback: EventListener) => {
    target.addEventListener(type, callback);
    abort.signal.addEventListener('abort', () => target.removeEventListener(type, callback), { once: true });
  };
  const attribute = (node: Element, name: string, value: string | null) => {
    let names = previous.get(node);
    if (!names) { names = new Set(); previous.set(node, names); }
    if (!names.has(name)) {
      names.add(name); const before = node.getAttribute(name);
      restores.push(() => before === null ? node.removeAttribute(name) : node.setAttribute(name, before));
    }
    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
  };
  let state = documents.get(document);
  if (!state) { state = { open: new Set(), locked: document.documentElement.classList.contains('has-modal-open'),users:0 }; documents.set(document, state); }
  const shared = state;
  shared.users++;
  const hadOpen = disclosure.open, hadClass = panel.classList.contains('is-menu-open');
  let opened = false, invoking: HTMLElement | null = null;
  const submenuState = new Map<HTMLDetailsElement, boolean>();
  const submenuTabIndex = new Map<HTMLElement,string|null>();
  const submenus=[...root.querySelectorAll<HTMLDetailsElement>('.wp-block-navigation-item > details')].filter(details=>local(details) && !!details.querySelector(':scope > .wp-block-navigation__submenu-container'));
  const visible = (node: HTMLElement) => !node.closest('[hidden],[inert],[aria-hidden="true"]') && !node.matches(':disabled,[aria-disabled="true"]') && node.tabIndex >= 0 &&
    ![...panel.querySelectorAll('details:not([open])')].some(details => details.contains(node) && !details.querySelector(':scope > summary')?.contains(node)) &&
    (typeof node.checkVisibility==='function'?node.checkVisibility({checkOpacity:false,checkVisibilityCSS:true}):node.getClientRects().length > 0 && document.defaultView?.getComputedStyle?.(node)?.visibility!=='hidden');
  const focusables = (container: Element) => [...container.querySelectorAll<HTMLElement>('a[href],area[href],button,input,select,textarea,summary,[tabindex]')].filter(visible);
  const synchronize = () => {
    attribute(opener, 'aria-expanded', String(opened));
    attribute(dialog, 'role', opened ? 'dialog' : null);
    attribute(dialog, 'aria-modal', opened ? 'true' : null);
    panel.classList.toggle('is-menu-open', opened);
    document.documentElement.classList.toggle('has-modal-open', shared.locked || shared.open.size > 0);
  };
  const close = (restoreFocus = true) => {
    if (!opened) return;
    const inside = panel.contains(document.activeElement);
    opened = false; shared.open.delete(close); disclosure.open = false;
    for (const [details, wasOpen] of submenuState) details.open = wasOpen;
    for(const [summary,index] of submenuTabIndex) {if(index===null)summary.removeAttribute('tabindex');else summary.setAttribute('tabindex',index);}
    submenuTabIndex.clear();
    submenuState.clear(); synchronize();
    if (restoreFocus && inside && invoking?.isConnected) invoking.focus();
    invoking = null;
  };
  const open = () => {
    if (opened) return;
    for (const other of [...shared.open]) other();
    invoking = opener; opened = true; disclosure.open = true; shared.open.add(close);
    if (!panel.classList.contains('disable-default-overlay')) {
      for (const details of submenus.filter(details=>panel.contains(details))) {
        submenuState.set(details, details.open); details.open = true;
        const summary=details.querySelector<HTMLElement>(':scope > summary');
        if(summary){submenuTabIndex.set(summary,summary.getAttribute('tabindex'));attribute(summary,'tabindex','-1');}
      }
    }
    synchronize();
    // The source starts in content, rather than its fallback close control.
    const content = panel.querySelector('.wp-block-navigation__responsive-container-content') || panel;
    (focusables(content)[0] || panel).focus();
  };
  attribute(disclosure, 'data-worldact-navigation-enhanced', 'true');
  attribute(opener,'role','button');
  listen(opener, 'click', event => { event.preventDefault(); if (opened) close(); else open(); });
  listen(disclosure, 'toggle', () => { if (disclosure.open !== opened) { if (disclosure.open) open(); else close(); } });
  listen(panel, 'click', event => {
    const target = event.target as Element;
    const closeButton = target.closest<HTMLElement>('button[data-worldact-navigation-close]');
    if (closeButton && local(closeButton) && closeButton.getAttribute('data-worldact-navigation-close') === panel.id) { event.preventDefault(); close(); return; }
    const link = target.closest('a[href]');
    if (link && local(link)) { close(false); return; }
    if (target === panel || target === dialog.parentElement) close();
    const summary = target.closest('summary');
    if (summary && !panel.classList.contains('disable-default-overlay') && submenus.some(details=>details.querySelector(':scope > summary')===summary)) event.preventDefault();
  });
  for(const details of submenus) {
    listen(details,'keydown',event=>{
      if((event as KeyboardEvent).key!=='Escape' || !details.open || (opened && !panel.classList.contains('disable-default-overlay')))return;
      event.preventDefault();event.stopPropagation();details.open=false;
      if(details.contains(document.activeElement))details.querySelector<HTMLElement>(':scope > summary')?.focus();
    });
    listen(details,'focusout',event=>{
      if(opened && !panel.classList.contains('disable-default-overlay'))return;
      const next=(event as FocusEvent).relatedTarget as Node|null;
      if(!next || !details.contains(next))details.open=false;
    });
  }
  listen(document, 'keydown', event => {
    if (!opened) return;
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (keyboard.key !== 'Tab') return;
    const controls = focusables(panel), first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); panel.focus(); return; }
    if (keyboard.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last!.focus(); }
    else if (!keyboard.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  if (hadOpen) open(); else synchronize();
  return () => {
    abort.abort(); close(false);
    disclosure.open = hadOpen; panel.classList.toggle('is-menu-open', hadClass);
    for (const restore of restores.reverse()) restore();
    if (--shared.users===0) { document.documentElement.classList.toggle('has-modal-open', shared.locked); documents.delete(document); }
  };
}

export function enhanceNavigationOverlays(container: ParentNode | null) {
  if (!container) return () => {};
  const roots = [...container.querySelectorAll<HTMLElement>(selector)];
  if ('matches' in container && (container as Element).matches(selector)) roots.unshift(container as HTMLElement);
  const releases = roots.map(root => {
    let entry = mounted.get(root);
    if (!entry) { entry = { users: 0, dispose: mount(root) }; mounted.set(root, entry); }
    entry.users++;
    return () => { if (--entry.users === 0) { entry.dispose(); mounted.delete(root); } };
  });
  let released = false;
  return () => { if (!released) { released = true; releases.reverse().forEach(release => release()); } };
}
