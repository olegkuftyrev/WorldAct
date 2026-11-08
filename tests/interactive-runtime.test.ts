import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { enhanceInteractiveBlocks } from '../src/interactiveBlocks.js';

function accordion(id: string, { autoclose = false, open = [false, false], inside = '' } = {}) {
  return `<div class="wp-block-accordion" data-worldact-interactive="accordion" data-worldact-autoclose="${autoclose}" id="${id}">${open.map((opened, i) => `<div class="wp-block-accordion-item${opened ? ' is-open' : ''}" data-worldact-accordion-item="${id}-toggle-${i}" data-worldact-open="${opened}"><h3 class="wp-block-accordion-heading"><button type="button" class="wp-block-accordion-heading__toggle" id="${id}-toggle-${i}" aria-controls="${id}-panel-${i}" aria-expanded="${opened}">Section ${i}</button></h3><div class="wp-block-accordion-panel" role="region" id="${id}-panel-${i}" aria-labelledby="${id}-toggle-${i}"><a href="#${id}-target-${i}" id="${id}-target-${i}">Content ${i}</a>${i === 0 ? inside : ''}</div></div>`).join('')}</div>`;
}

function tabs(id: string, { active = 0, inside = '' } = {}) {
  return `<div class="wp-block-tabs" data-worldact-interactive="tabs" data-worldact-active-tab="${active}" data-editor-active-tab-index="0" id="${id}"><div class="wp-block-tab-list" role="tablist" aria-label="Product details">${[0, 1, 2].map((i) => `<button type="button" role="tab" id="tab__${id}-panel-${i}" aria-controls="${id}-panel-${i}" aria-selected="${i === active}" tabindex="${i === active ? 0 : -1}">Tab ${i}</button>`).join('')}</div><div class="wp-block-tab-panels">${[0, 1, 2].map((i) => `<section class="wp-block-tab-panel" role="tabpanel" data-worldact-tab-panel="${i}" id="${id}-panel-${i}" aria-labelledby="tab__${id}-panel-${i}" tabindex="${i === active ? 0 : -1}"><a href="#${id}-target-${i}" id="${id}-target-${i}">Panel ${i}</a>${i === 1 ? inside : ''}</section>`).join('')}</div></div>`;
}

function fixture(html: string, hash = '') {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  Object.defineProperty(window, 'location', { configurable: true, value: { hash } });
  let focused: Element | null = null;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => focused });
  for (const node of document.querySelectorAll<HTMLElement>('button,a')) node.focus = () => { focused = node; };
  const get = (id: string) => document.getElementById(id)!;
  const event = (node: Element | Window, type: string, key?: string) => {
    const value = new window.Event(type, { bubbles: true, cancelable: true });
    if (key) Object.defineProperty(value, 'key', { value: key });
    node.dispatchEvent(value);
    return value;
  };
  return { document: document as unknown as Document, window, get, event };
}

test('accordion preserves source defaults, applies autoclose only on action, and isolates other instances', () => {
  const { document, get, event } = fixture(accordion('a', { autoclose: true, open: [true, true] }) + accordion('b'));
  assert.equal(document.querySelectorAll('[hidden]').length, 0, 'without JS all content remains readable');
  const cleanup = enhanceInteractiveBlocks(document);
  assert.equal(get('a-panel-0').hasAttribute('hidden'), false);
  assert.equal(get('a-panel-1').hasAttribute('hidden'), false);
  event(get('a-toggle-0'), 'click');
  assert.equal(get('a-toggle-0').getAttribute('aria-expanded'), 'false');
  assert.equal(get('a-panel-1').getAttribute('hidden'), 'until-found');
  event(get('a-toggle-1'), 'click');
  assert.equal(get('a-toggle-1').getAttribute('aria-expanded'), 'true');
  assert.equal(get('a-panel-0').getAttribute('hidden'), 'until-found');
  assert.equal(get('b-toggle-1').getAttribute('aria-expanded'), 'false');
  assert.equal(get('a-toggle-1').closest('.wp-block-accordion-item')?.classList.contains('is-open'), true);
  cleanup();
  assert.equal(document.querySelectorAll('[hidden]').length, 0);
});

test('nested accordion actions stay local, beforematch reveals enclosing panels and closing focused content returns focus', () => {
  const { document, get, event } = fixture(accordion('outer', { autoclose: true, inside: accordion('inner') }));
  const cleanup = enhanceInteractiveBlocks(document);
  event(get('inner-toggle-0'), 'click');
  assert.equal(get('inner-toggle-0').getAttribute('aria-expanded'), 'true');
  assert.equal(get('outer-toggle-0').getAttribute('aria-expanded'), 'false');
  event(get('inner-panel-1'), 'beforematch');
  assert.equal(get('inner-toggle-1').getAttribute('aria-expanded'), 'true');
  assert.equal(get('outer-toggle-0').getAttribute('aria-expanded'), 'true');
  (get('outer-target-0') as HTMLElement).focus();
  event(get('outer-toggle-0'), 'click');
  assert.equal(document.activeElement, get('outer-toggle-0'));
  cleanup();
});

test('tabs use the persisted active index and manual activation with wraparound arrows, Home and End', () => {
  const { document, get, event } = fixture(tabs('tabs', { active: 2 }));
  const cleanup = enhanceInteractiveBlocks(document);
  assert.equal(get('tabs-panel-2').hasAttribute('hidden'), false);
  assert.equal(get('tabs-panel-0').getAttribute('hidden'), 'until-found');
  assert.equal(get('tab__tabs-panel-2').getAttribute('tabindex'), '0');
  assert.equal(event(get('tab__tabs-panel-2'), 'keydown', 'ArrowRight').defaultPrevented, true);
  assert.equal(document.activeElement, get('tab__tabs-panel-0'));
  assert.equal(get('tab__tabs-panel-2').getAttribute('aria-selected'), 'true', 'focus does not activate');
  event(get('tab__tabs-panel-0'), 'keydown', 'ArrowLeft');
  assert.equal(document.activeElement, get('tab__tabs-panel-2'));
  event(get('tab__tabs-panel-2'), 'keydown', 'Home');
  assert.equal(document.activeElement, get('tab__tabs-panel-0'));
  event(get('tab__tabs-panel-0'), 'keydown', 'End');
  assert.equal(document.activeElement, get('tab__tabs-panel-2'));
  event(get('tab__tabs-panel-1'), 'click');
  assert.equal(get('tab__tabs-panel-1').getAttribute('aria-selected'), 'true');
  assert.equal(get('tabs-panel-1').getAttribute('tabindex'), '0');
  assert.equal(get('tabs-panel-2').getAttribute('tabindex'), '-1');
  (get('tabs-target-1') as HTMLElement).focus();
  event(get('tabs-panel-0'), 'beforematch');
  assert.equal(document.activeElement, get('tab__tabs-panel-0'));
  cleanup();
});

test('nested tab instances activate only local pairs while beforematch opens all containing tabs', () => {
  const { document, get, event } = fixture(tabs('outer', { inside: tabs('inner') }));
  const cleanup = enhanceInteractiveBlocks(document);
  event(get('tab__inner-panel-2'), 'click');
  assert.equal(get('outer-panel-0').hasAttribute('hidden'), false);
  assert.equal(get('inner-panel-2').hasAttribute('hidden'), false);
  event(get('inner-panel-2'), 'beforematch');
  assert.equal(get('outer-panel-1').hasAttribute('hidden'), false);
  assert.equal(get('inner-panel-2').hasAttribute('hidden'), false);
  cleanup();
});

test('initial and changed fragments reveal nested content with safe ID lookup and no expression execution', () => {
  const { document, window, get, event } = fixture(accordion('a', { inside: tabs('t') }), '#t-target-2');
  get('a').setAttribute('data-wp-init', 'window.__unsafe = true');
  const cleanup = enhanceInteractiveBlocks(document);
  assert.equal(get('a-panel-0').hasAttribute('hidden'), false);
  assert.equal(get('t-panel-2').hasAttribute('hidden'), false);
  window.location.hash = '#a-target-1';
  event(window as unknown as Window, 'hashchange');
  assert.equal(get('a-panel-1').hasAttribute('hidden'), false);
  window.location.hash = '#%E0%A4%A';
  assert.doesNotThrow(() => event(window as unknown as Window, 'hashchange'));
  assert.equal((window as unknown as { __unsafe?: boolean }).__unsafe, undefined);
  cleanup();
});

test('repeated enhancement is shared, cleanup aborts listeners and restores the original no-JS markup', () => {
  const { document, window, get, event } = fixture(tabs('t'));
  const original = document.body.innerHTML;
  const first = enhanceInteractiveBlocks(document), second = enhanceInteractiveBlocks(get('t'));
  first(); first();
  event(get('tab__t-panel-2'), 'click');
  assert.equal(get('t-panel-2').hasAttribute('hidden'), false);
  second();
  assert.equal(document.body.innerHTML, original);
  event(get('tab__t-panel-1'), 'click');
  window.location.hash = '#t-target-1'; event(window as unknown as Window, 'hashchange');
  assert.equal(document.body.innerHTML, original, 'disposed click/hash handlers cannot hide content');
  window.location.hash = '';
  const again = enhanceInteractiveBlocks(document);
  assert.equal(get('t-panel-0').hasAttribute('hidden'), false, 'reinitialization uses saved defaults');
  again();
});

test('malformed and cross-instance ID pairs cannot affect unrelated elements', () => {
  const { document, get, event } = fixture(accordion('a') + tabs('t'));
  get('a-toggle-0').setAttribute('aria-controls', 't-panel-1');
  get('tab__t-panel-1').setAttribute('aria-controls', 'a-panel-1');
  const cleanup = enhanceInteractiveBlocks(document);
  event(get('a-toggle-0'), 'click');
  assert.equal(get('a-panel-0').hasAttribute('hidden'), false, 'unpaired content stays readable');
  assert.equal(get('a-panel-1').getAttribute('hidden'), 'until-found');
  assert.equal(get('t-panel-1').hasAttribute('hidden'), false, 'unpaired tab panel stays readable');
  cleanup();
});
