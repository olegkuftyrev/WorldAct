import test from './isolated-test.js';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { enhanceNavigationOverlays } from '../src/navigationOverlays.js';

function navigation(id:string,custom=false) {
  return `<nav data-worldact-interactive="navigation"><details data-worldact-navigation-toggle><summary data-worldact-navigation-open aria-controls="${id}" id="${id}-open">Menu</summary><div id="${id}" class="wp-block-navigation__responsive-container ${custom?'disable-default-overlay':''}" data-worldact-navigation-panel tabindex="-1"><div class="wp-block-navigation__responsive-close"><div data-worldact-navigation-dialog aria-label="Menu"><button data-worldact-navigation-close="${id}" id="${id}-close">Close</button><div class="wp-block-navigation__responsive-container-content"><a href="/first" id="${id}-first">First</a><li class="wp-block-navigation-item"><details id="${id}-submenu"><summary id="${id}-summary">Parent <a href="/parent" id="${id}-parent">Parent link</a></summary><ul class="wp-block-navigation__submenu-container"><li><a href="/child" id="${id}-child">Child</a></li></ul></details></li><button disabled id="${id}-disabled">Disabled</button><button tabindex="-1">Skipped</button><button data-worldact-navigation-close="${id}" id="${id}-last">Custom close</button></div></div></div></div></details></nav>`;
}
function fixture(html:string) {
  const {document,window}=parseHTML(`<!doctype html><html><body><button id="outside">Outside</button>${html}</body></html>`);
  let focused:Element|null=null;
  Object.defineProperty(document,'activeElement',{get:()=>focused});
  for(const node of document.querySelectorAll<HTMLElement>('*')) {
    node.focus=()=>{focused=node;};
    node.getClientRects=()=>[{width:20,height:20}] as unknown as DOMRectList;
    Object.defineProperty(node,'tabIndex',{get:()=>node.hasAttribute('tabindex')?Number(node.getAttribute('tabindex')):node.matches('a[href],button,input,summary')?0:-1});
  }
  const get=(id:string)=>document.getElementById(id)! as HTMLElement;
  const event=(node:Element|Document,type:string,key?:string,shiftKey=false)=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{key:{value:key},shiftKey:{value:shiftKey}});node.dispatchEvent(event);return event;};
  return {document:document as unknown as Document,get,event};
}

test('navigation opens in content, traps only at bounds, restores its invoking control and releases scroll lock',()=>{
  const {document,get,event}=fixture(navigation('a'));
  const cleanup=enhanceNavigationOverlays(document);
  event(get('a-open'),'click');
  assert.equal(document.activeElement,get('a-first'));
  assert.equal(get('a').querySelector('[data-worldact-navigation-dialog]')?.getAttribute('aria-modal'),'true');
  assert.equal(document.documentElement.classList.contains('has-modal-open'),true);
  assert.equal((get('a-submenu') as HTMLDetailsElement).open,true);
  get('a-last').focus();assert.equal(event(get('a-last'),'keydown','Tab').defaultPrevented,true);
  assert.equal(document.activeElement,get('a-close'));
  event(get('a-close'),'keydown','Tab',true);assert.equal(document.activeElement,get('a-last'));
  event(get('a-last'),'keydown','Escape');
  assert.equal(document.activeElement,get('a-open'));
  assert.equal(document.documentElement.classList.contains('has-modal-open'),false);
  assert.equal((get('a-submenu') as HTMLDetailsElement).open,undefined);
  cleanup();
});

test('custom overlays retain submenus, preserve parent links and never steal focus moved outside',()=>{
  const {document,get,event}=fixture(navigation('a',true));
  const cleanup=enhanceNavigationOverlays(document);
  event(get('a-open'),'click');
  assert.equal((get('a-submenu') as HTMLDetailsElement).open,undefined);
  get('outside').focus();event(document,'keydown','Escape');
  assert.equal(document.activeElement,get('outside'));
  event(get('a-open'),'click');
  assert.equal(event(get('a-parent'),'click').defaultPrevented,false);
  assert.equal(get('a').classList.contains('is-menu-open'),false);
  cleanup();
});

test('Escape closes the nearest custom submenu before its overlay and focusout closes only that submenu',()=>{
  const {document,get,event}=fixture(navigation('a',true));
  const cleanup=enhanceNavigationOverlays(document);event(get('a-open'),'click');
  (get('a-submenu') as HTMLDetailsElement).open=true;get('a-child').focus();
  event(get('a-child'),'keydown','Escape');
  assert.equal((get('a-submenu') as HTMLDetailsElement).open,false);
  assert.equal(document.activeElement,get('a-summary'));
  assert.equal(get('a').classList.contains('is-menu-open'),true);
  event(get('a-summary'),'keydown','Escape');assert.equal(get('a').classList.contains('is-menu-open'),false);
  event(get('a-open'),'click');(get('a-submenu') as HTMLDetailsElement).open=true;
  event(get('a-child'),'focusout');assert.equal((get('a-submenu') as HTMLDetailsElement).open,false);
  assert.equal(get('a').classList.contains('is-menu-open'),true);cleanup();
});

test('paired controls stay local, only one menu opens, repeated mounts and disposal restore readable markup',()=>{
  const {document,get,event}=fixture(navigation('a')+navigation('b',true));
  const original=document.body.innerHTML;
  const first=enhanceNavigationOverlays(document),second=enhanceNavigationOverlays(document);
  event(get('a-open'),'click');event(get('b-open'),'click');
  assert.equal(get('a').classList.contains('is-menu-open'),false);
  assert.equal(get('b').classList.contains('is-menu-open'),true);
  get('b-last').setAttribute('data-worldact-navigation-close','a');
  event(get('b-last'),'click');assert.equal(get('b').classList.contains('is-menu-open'),true);
  get('b-last').setAttribute('data-worldact-navigation-close','b');
  first();assert.equal(get('b').classList.contains('is-menu-open'),true);
  second();assert.equal(document.body.innerHTML,original);
  event(get('a-open'),'click');assert.equal(get('a').classList.contains('is-menu-open'),false);
});
