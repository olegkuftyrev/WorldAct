/**
 * Progressive enhancement for the two server-generated interactive block shapes.
 * Only these fixed selectors and paired local IDs have behavior. Saved scripts,
 * action expressions, and arbitrary data attributes are never interpreted.
 */
const selector = '[data-worldact-interactive="accordion"], [data-worldact-interactive="tabs"]';
type Mounted = { users: number; dispose: () => void };
const mounted = new WeakMap<HTMLElement, Mounted>();

function mount(root: HTMLElement) {
  const document = root.ownerDocument, view = document.defaultView;
  const abort = new AbortController(), restores: Array<() => void> = [];
  const remembered = new WeakMap<Element, Set<string>>(), timers = new Set<ReturnType<typeof setTimeout>>();
  const listen = (target: EventTarget, type: string, handler: EventListener) => {
    target.addEventListener(type, handler);
    abort.signal.addEventListener('abort', () => target.removeEventListener(type, handler), { once: true });
  };
  const attribute = (node: HTMLElement, name: string, value: string | null) => {
    let names = remembered.get(node);
    if (!names) { names = new Set(); remembered.set(node, names); }
    if (!names.has(name)) {
      names.add(name);
      const previous = node.getAttribute(name);
      restores.push(() => previous === null ? node.removeAttribute(name) : node.setAttribute(name, previous));
    }
    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
  };
  const local = (node: Element) => node.closest(selector) === root;
  const byId = (id: string | null) => {
    if (!id || id.length > 512 || /\s/.test(id)) return null;
    const node = document.getElementById(id);
    return node && root.contains(node) && local(node) ? node : null;
  };
  const hide = (node: HTMLElement, hidden: boolean) => attribute(node, 'hidden', hidden ? 'until-found' : null);
  let reveal: (target: Element) => boolean = () => false;

  if (root.matches('.wp-block-accordion[data-worldact-interactive="accordion"]')) {
    const items = [...root.querySelectorAll<HTMLElement>('.wp-block-accordion-item[data-worldact-accordion-item]')]
      .filter(local).flatMap((item) => {
        const toggle = byId(item.getAttribute('data-worldact-accordion-item'));
        const panel = toggle && byId(toggle.getAttribute('aria-controls'));
        if (!toggle?.matches('button.wp-block-accordion-heading__toggle') || !panel?.matches('.wp-block-accordion-panel') ||
          !item.contains(toggle) || !item.contains(panel) || panel.getAttribute('aria-labelledby') !== toggle.id) return [];
        const hadOpenClass = item.classList.contains('is-open');
        restores.push(() => item.classList.toggle('is-open', hadOpenClass));
        return [{ item, toggle, panel, open: item.getAttribute('data-worldact-open') === 'true' }];
      });
    const autoclose = root.getAttribute('data-worldact-autoclose') === 'true';
    const synchronize = () => {
      for (const { item, toggle, panel, open } of items) {
        if (!open && panel.contains(document.activeElement)) toggle.focus();
        item.classList.toggle('is-open', open);
        attribute(toggle, 'aria-expanded', String(open));
        hide(panel, !open);
      }
    };
    const open = (index: number) => {
      for (let i = 0; i < items.length; i++) if (i === index) items[i].open = true; else if (autoclose) items[i].open = false;
      synchronize();
    };
    items.forEach(({ toggle, panel }, index) => {
      listen(toggle, 'click', (event) => {
        event.preventDefault();
        const next = !items[index].open;
        for (let i = 0; i < items.length; i++) if (i === index) items[i].open = next; else if (autoclose) items[i].open = false;
        synchronize();
      });
      listen(panel, 'beforematch', () => open(index));
    });
    reveal = (target) => { const index = items.findIndex(({ panel }) => panel === target || panel.contains(target)); if (index < 0) return false; open(index); return true; };
    // Source allows several default-open items, even when later actions autoclose.
    synchronize();
  } else if (root.matches('.wp-block-tabs[data-worldact-interactive="tabs"]')) {
    const tabs = [...root.querySelectorAll<HTMLElement>('.wp-block-tab-list[role="tablist"] button[role="tab"]')].filter(local);
    const pairs = tabs.flatMap((tab) => {
      const panel = byId(tab.getAttribute('aria-controls'));
      return panel?.matches('.wp-block-tab-panel[role="tabpanel"][data-worldact-tab-panel]') &&
        panel.getAttribute('aria-labelledby') === tab.id ? [{ tab, panel }] : [];
    });
    const requested = Number(root.getAttribute('data-worldact-active-tab'));
    let active = Number.isFinite(requested) ? Math.max(0, Math.min(pairs.length - 1, Math.trunc(requested))) : 0;
    const activate = (index: number) => {
      if (!pairs.length) return;
      active = Math.max(0, Math.min(pairs.length - 1, index));
      if (pairs.some(({ panel }, i) => i !== active && panel.contains(document.activeElement))) pairs[active].tab.focus();
      pairs.forEach(({ tab, panel }, i) => {
        attribute(tab, 'aria-selected', String(i === active));
        attribute(tab, 'tabindex', i === active ? '0' : '-1');
        attribute(panel, 'tabindex', i === active ? '0' : '-1');
        hide(panel, i !== active);
      });
    };
    pairs.forEach(({ tab, panel }, index) => {
      listen(tab, 'click', (event) => { event.preventDefault(); activate(index); });
      listen(tab, 'keydown', (event) => {
        const { key } = event as KeyboardEvent;
        let next: number;
        if (key === 'ArrowRight') next = (index + 1) % pairs.length;
        else if (key === 'ArrowLeft') next = (index + pairs.length - 1) % pairs.length;
        else if (key === 'Home') next = 0;
        else if (key === 'End') next = pairs.length - 1;
        else return;
        event.preventDefault();
        // Source uses manual activation: arrows move focus; Enter/Space click.
        pairs[next].tab.focus();
      });
      listen(panel, 'beforematch', () => activate(index));
    });
    reveal = (target) => { const index = pairs.findIndex(({ panel }) => panel === target || panel.contains(target)); if (index < 0) return false; activate(index); return true; };
    activate(active);
  }

  const revealHash = () => {
    let id: string;
    try { id = decodeURIComponent(view?.location.hash.slice(1) || ''); } catch { return; }
    const target = id && document.getElementById(id);
    if (!target || !reveal(target)) return;
    const timer = setTimeout(() => { timers.delete(timer); if (!abort.signal.aborted && target.isConnected) target.scrollIntoView?.(); }, 0);
    timers.add(timer);
  };
  if (view) listen(view, 'hashchange', revealHash);
  revealHash();
  return () => {
    abort.abort();
    for (const timer of timers) clearTimeout(timer);
    for (const restore of restores.reverse()) restore();
  };
}

/** Cleanup releases listeners and restores readable, unhidden server markup. */
export function enhanceInteractiveBlocks(container: ParentNode | null) {
  if (!container) return () => {};
  const roots = [...container.querySelectorAll<HTMLElement>(selector)];
  if ('matches' in container && (container as Element).matches(selector)) roots.unshift(container as HTMLElement);
  const releases = roots.map((root) => {
    let entry = mounted.get(root);
    if (!entry) { entry = { users: 0, dispose: mount(root) }; mounted.set(root, entry); }
    entry.users++;
    return () => { if (--entry.users === 0) { entry.dispose(); mounted.delete(root); } };
  });
  let released = false;
  return () => { if (!released) { released = true; releases.reverse().forEach((release) => release()); } };
}
